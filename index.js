import WebSocket from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const plugin = {
  register(api) {
    const cfg = api.pluginConfig || {};
    const napcatWs = cfg.napcatWs || process.env.NAPCAT_WS;
    const napcatToken = cfg.napcatToken || process.env.NAPCAT_TOKEN || '';
    const botQQ = String(cfg.botQQ || process.env.BOT_QQ || '');
    const allowedUsers = cfg.allowedUsers || [];
    const httpPort = Number(cfg.port || 0);

    if (!napcatWs) {
      api.logger.warn('qq: missing napcatWs, plugin disabled');
      return;
    }

    const gwCfg = api.config?.gateway || {};
    const gwPort = gwCfg.port || 18789;
    const gwToken = gwCfg.auth?.token || process.env.OPENCLAW_TOKEN;
    const openclawApi = `http://127.0.0.1:${gwPort}/v1/responses`;

    const log = api.logger;

    // ── Voice config ──
    const voiceCfg = cfg.voice || {};
    const voiceEnabled = voiceCfg.enabled !== false;
    const ttsToolPath = voiceCfg.ttsToolPath || '';
    const voiceReplyEnabled = voiceEnabled && !!ttsToolPath;
    // QQ data dir for resolving bare voice filenames (macOS default)
    const qqDataDir = voiceCfg.qqDataDir || path.join(
      process.env.HOME, 'Library', 'Containers', 'com.tencent.qq',
      'Data', 'Library', 'Application Support', 'QQ'
    );
    // Voice cache dir must be inside QQ's sandbox on macOS to avoid EPERM
    const VOICE_CACHE_DIR = voiceCfg.cacheDir || path.join(
      process.env.HOME, 'Library', 'Containers', 'com.tencent.qq',
      'Data', 'tmp', 'openclaw-qq-voice'
    );

    // ── Sessions directory (for context reset) ──
    const openclawDir = path.dirname(api.config?.agents?.defaults?.workspace || path.join(process.env.HOME, '.openclaw', 'workspace'));
    const sessionsDir = path.join(openclawDir, 'agents', 'main', 'sessions');
    const RESET_COMMANDS = ['/reset', '/重置'];

    // ── Dedup ──
    const processedMsgIds = new Map();
    function isDuplicate(msgId) {
      if (!msgId) return false;
      const key = String(msgId);
      if (processedMsgIds.has(key)) return true;
      processedMsgIds.set(key, Date.now());
      if (processedMsgIds.size > 1000) {
        const cutoff = Date.now() - 600000;
        for (const [k, v] of processedMsgIds) {
          if (v < cutoff) processedMsgIds.delete(k);
        }
      }
      return false;
    }

    // ── Media cache handling ──
    const MEDIA_CACHE_DIR = '/tmp/openclaw-qq-images';
    const MEDIA_MAX_AGE_MS = 60 * 60 * 1000;

    async function downloadImage(imageUrl) {
      try {
        log.info(`[Image] downloading ${imageUrl.slice(0, 100)}`);
        const response = await fetch(imageUrl);
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > 10 * 1024 * 1024) return null;
        await fs.mkdir(MEDIA_CACHE_DIR, { recursive: true });
        const ext = (buffer[0] === 0x89 && buffer[1] === 0x50) ? '.png'
          : (buffer[0] === 0x47 && buffer[1] === 0x49) ? '.gif' : '.jpg';
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        const filepath = path.join(MEDIA_CACHE_DIR, filename);
        await fs.writeFile(filepath, buffer);
        log.info(`[Image] saved ${filename} (${(buffer.byteLength / 1024).toFixed(1)}KB)`);
        return filepath;
      } catch (err) {
        log.error(`[Image] download failed: ${err.message}`);
        return null;
      }
    }

    async function cleanupMediaCache() {
      try {
        const files = await fs.readdir(MEDIA_CACHE_DIR).catch(() => []);
        const cutoff = Date.now() - MEDIA_MAX_AGE_MS;
        for (const file of files) {
          const filepath = path.join(MEDIA_CACHE_DIR, file);
          const stat = await fs.stat(filepath).catch(() => null);
          if (stat && stat.mtimeMs < cutoff) await fs.unlink(filepath).catch(() => {});
        }
      } catch {}
    }

    // ── Extract message content ──

    async function extractContent(message) {
      if (typeof message === 'string') return message;
      if (!Array.isArray(message)) return '';

      const textParts = [];
      const mediaParts = [];

      for (const seg of message) {
        if (seg.type === 'text') {
          textParts.push(seg.data?.text ?? '');
        } else if (seg.type === 'image') {
          const url = seg.data?.url;
          if (url) {
            const localPath = await downloadImage(url);
            if (localPath) {
              mediaParts.push(`[用户发送了一张图片]\n本地路径: ${localPath}\n请使用image工具分析这张图片并回复用户。`);
            } else {
              mediaParts.push(`[用户发送了一张图片]\n图片URL: ${url}`);
            }
          }
        } else if (seg.type === 'record' && voiceEnabled) {
          const src = seg.data?.file || seg.data?.url || seg.data?.path || '';
          if (src) {
            try {
              await fs.mkdir(MEDIA_CACHE_DIR, { recursive: true });
              const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
              const silkPath = path.join(MEDIA_CACHE_DIR, `voice-${stamp}.silk`);
              const wavPath = path.join(MEDIA_CACHE_DIR, `voice-${stamp}.wav`);

              let localPath = null;
              if (src.startsWith('file://')) {
                localPath = new URL(src).pathname;
              } else if (src.startsWith('/')) {
                localPath = src;
              } else if (src.startsWith('http://') || src.startsWith('https://')) {
                const response = await fetch(src);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buffer = Buffer.from(await response.arrayBuffer());
                await fs.writeFile(silkPath, buffer);
                localPath = silkPath;
                log.info(`[Voice] downloaded (${(buffer.byteLength / 1024).toFixed(1)}KB)`);
              } else {
                // NapCat may return bare filename like "xxx.amr"; search in QQ data dir
                const found = await execAsync('find', [qqDataDir, '-name', src], { timeout: 5000 })
                  .then(r => r.stdout.trim().split('\n')[0])
                  .catch(() => '');
                if (found) {
                  localPath = found;
                  log.info(`[Voice] resolved bare filename to: ${found}`);
                } else {
                  throw new Error(`Cannot find voice file: ${src}`);
                }
              }

              if (localPath && localPath !== silkPath) {
                await fs.copyFile(localPath, silkPath);
              }
              const stat = await fs.stat(silkPath);
              log.info(`[Voice] silk file ready (${(stat.size / 1024).toFixed(1)}KB)`);

              // Convert SILK to WAV using pilk (QQ voice is SILK_V3 format, not standard AMR)
              let finalPath = silkPath;
              try {
                await execAsync('python3', ['-c', `import pilk; pilk.silk_to_wav("${silkPath}", "${wavPath}")`], { timeout: 15000 });
                finalPath = wavPath;
                log.info(`[Voice] converted SILK to WAV`);
              } catch (convErr) {
                log.warn(`[Voice] pilk convert failed, using raw file: ${convErr.message}`);
              }

              mediaParts.push(`[用户发送了一条语音消息]\n本地路径: ${finalPath}\n请用语音识别工具将其转为文字，然后直接回复用户的问题。不要输出任何处理过程，直接回答用户说的内容。`);
            } catch (err) {
              log.error(`[Voice] failed: ${err.message}`);
              mediaParts.push(`[用户发送了一条语音消息，处理失败: ${err.message}]`);
            }
          } else {
            mediaParts.push(`[用户发送了一条语音消息，但未获取到文件路径]`);
          }
        }
      }

      let result = textParts.join('').trim();
      if (mediaParts.length > 0) {
        result = result ? `${result}\n\n${mediaParts.join('\n\n')}` : mediaParts.join('\n\n');
      }
      return result;
    }

    // ── Context reset ──

    async function resetSession(sessionId) {
      const sessionKey = `agent:main:openresponses-user:${sessionId.toLowerCase()}`;
      try {
        const sessionsFile = path.join(sessionsDir, 'sessions.json');
        const sessionsData = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
        const session = sessionsData[sessionKey];
        if (session?.sessionId) {
          const sessionFile = path.join(sessionsDir, `${session.sessionId}.jsonl`);
          await fs.rename(sessionFile, `${sessionFile}.reset.${Date.now()}`).catch(() => {});
          delete sessionsData[sessionKey];
          await fs.writeFile(sessionsFile, JSON.stringify(sessionsData, null, 2));
          log.info(`[Reset] session ${sessionKey} cleared`);
          return '上下文已重置，开始新的对话。';
        }
        log.info(`[Reset] no session found for ${sessionKey}`);
        return '当前没有活跃的对话上下文。';
      } catch (err) {
        log.error(`[Reset] error: ${err.message}`);
        return '重置失败，请稍后重试。';
      }
    }

    // ── Async exec helper ──

    function execAsync(cmd, args, opts = {}) {
      return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        });
      });
    }

    // ── OpenClaw API (via CLI) ──

    function callOpenClaw(text, sessionId) {
      log.info(`[OpenClaw ->] session=${sessionId} text=${text.slice(0, 100)}`);

      return new Promise((resolve, reject) => {
        const args = ['agent', '--message', text, '--session-id', sessionId, '--json'];
        const env = { ...process.env };
        if (gwToken) env.OPENCLAW_TOKEN = gwToken;

        execFile('openclaw', args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`CLI error: ${err.message}`));
            return;
          }
          try {
            const data = JSON.parse(stdout);
            const texts = [];
            if (data.result?.payloads) {
              for (const p of data.result.payloads) {
                if (p.text) texts.push(p.text);
              }
            }
            const reply = texts.join('\n').trim() || null;
            const lastText = texts.length > 0 ? texts[texts.length - 1].trim() : null;
            if (reply) log.info(`[OpenClaw <-] len=${reply.length} lastLen=${lastText?.length}`);
            resolve({ reply, lastText });
          } catch (parseErr) {
            reject(new Error(`Parse error: ${parseErr.message}`));
          }
        });
      });
    }

    // ── NapCat WebSocket ──

    let napcat = null;
    let reconnectTimer = null;
    let stopped = false;

    function sendToQQ(target, text, isGroup = false) {
      if (!napcat || napcat.readyState !== WebSocket.OPEN) {
        log.error('[NapCat] not connected, dropping message');
        return;
      }
      const payload = isGroup
        ? { action: 'send_group_msg', params: { group_id: Number(target), message: [{ type: 'text', data: { text } }] } }
        : { action: 'send_private_msg', params: { user_id: Number(target), message: [{ type: 'text', data: { text } }] } };
      napcat.send(JSON.stringify(payload));
      log.info(`[QQ -> ${isGroup ? 'group:' : ''}${target}] ${text.slice(0, 100)}`);
    }

    function sendVoiceToQQ(target, silkPath, isGroup = false) {
      if (!napcat || napcat.readyState !== WebSocket.OPEN) {
        log.error('[NapCat] not connected, dropping voice');
        return;
      }
      const echoId = `voice_${Date.now()}`;
      const payload = isGroup
        ? { action: 'send_group_msg', echo: echoId, params: { group_id: Number(target), message: [{ type: 'record', data: { file: `file://${silkPath}` } }] } }
        : { action: 'send_private_msg', echo: echoId, params: { user_id: Number(target), message: [{ type: 'record', data: { file: `file://${silkPath}` } }] } };
      napcat.send(JSON.stringify(payload));
      log.info(`[QQ voice -> ${isGroup ? 'group:' : ''}${target}] ${silkPath} (echo: ${echoId})`);
    }

    // ── TTS: text → WAV → SILK ──

    async function textToSilk(text) {
      await fs.mkdir(VOICE_CACHE_DIR, { recursive: true });
      const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const wavPath = path.join(VOICE_CACHE_DIR, `tts-${stamp}.wav`);
      const silkPath = path.join(VOICE_CACHE_DIR, `tts-${stamp}.silk`);

      const ttsText = text.length > 500 ? text.slice(0, 497) + '...' : text;

      // Step 1: TTS → WAV (using user-provided TTS tool)
      await execAsync('node', [ttsToolPath, 'tts', ttsText, wavPath], { timeout: 60000 });
      log.info(`[TTS] generated WAV: ${wavPath}`);

      // Step 2: WAV → SILK (for QQ, requires python3 + pilk)
      await execAsync('python3', ['-c',
        `import pilk; pilk.encode("${wavPath}", "${silkPath}", pcm_rate=24000, tencent=True)`
      ], { timeout: 15000 });
      log.info(`[TTS] converted to SILK: ${silkPath}`);

      return silkPath;
    }

    function connectNapCat() {
      if (stopped) return;
      const url = napcatToken
        ? `${napcatWs}${napcatWs.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(napcatToken)}`
        : napcatWs;

      napcat = new WebSocket(url);

      napcat.on('open', () => {
        log.info('[NapCat] connected');
      });

      napcat.on('message', async (raw) => {
        let data;
        // Log echo responses (API call results) for debugging
        try {
          const peek = JSON.parse(raw);
          if (peek.echo) {
            log.info(`[NapCat echo] ${peek.echo} status=${peek.status} retcode=${peek.retcode} msg=${peek.message || ''}`);
          }
        } catch {}

        try { data = JSON.parse(raw); } catch { return; }

        // Skip API responses
        if (data.echo) return;
        if (data.post_type !== 'message') return;

        const msgId = data.message_id;
        if (isDuplicate(msgId)) return;

        const isGroup = data.message_type === 'group';

        // Group messages are ignored for safety — the bot can send to groups
        // via the HTTP /send endpoint, but never processes incoming group messages.
        if (isGroup) return;

        const userId = String(data.user_id || '');

        // Filter: check allowlist for private chat
        if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) return;

        // Detect if incoming message contains voice
        const hasVoice = voiceEnabled && Array.isArray(data.message) && data.message.some(seg => seg.type === 'record');

        let text = await extractContent(data.message);
        if (!text) return;

        log.info(`[<- user:${userId}] ${text.slice(0, 100)}`);

        const sessionId = `qq_${userId}`;

        // Context reset
        if (RESET_COMMANDS.includes(text.trim().toLowerCase())) {
          const msg = await resetSession(sessionId);
          sendToQQ(userId, msg);
          return;
        }

        // Call OpenClaw
        try {
          const { reply, lastText } = await callOpenClaw(text, sessionId);
          if (reply) {
            if (hasVoice && voiceReplyEnabled) {
              // Voice in → voice out (use last payload for TTS, send text alongside)
              try {
                const voiceText = (lastText || reply).replace(/[*#`_~\[\]()>|]/g, '').replace(/\n{2,}/g, '\n').trim();
                const silkPath = await textToSilk(voiceText);
                sendVoiceToQQ(userId, silkPath);
                sendToQQ(userId, lastText || reply);
              } catch (ttsErr) {
                log.error(`[TTS] failed: ${ttsErr.message}, falling back to text`);
                sendToQQ(userId, lastText || reply);
              }
            } else {
              sendToQQ(userId, reply);
            }
          }
        } catch (err) {
          log.error(`[OpenClaw] error: ${err.message}`);
          sendToQQ(userId, '服务暂时不可用，请稍后再试。');
        }

        cleanupMediaCache();
      });

      napcat.on('close', (code) => {
        log.info(`[NapCat] disconnected (${code})`);
        if (!stopped) {
          reconnectTimer = setTimeout(connectNapCat, 5000);
        }
      });

      napcat.on('error', (err) => {
        log.error(`[NapCat] error: ${err.message}`);
      });
    }

    // ── Optional HTTP server for proactive messaging ──

    let httpServer = null;

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    }

    // ── Service registration ──

    api.registerService({
      id: 'qq-napcat',
      async start() {
        stopped = false;
        connectNapCat();

        if (httpPort > 0) {
          httpServer = http.createServer(async (req, res) => {
            if (req.method === 'POST' && new URL(req.url, `http://localhost:${httpPort}`).pathname === '/send') {
              try {
                const body = await readBody(req);
                const { userId, groupId, text } = JSON.parse(body);
                if ((!userId && !groupId) || !text) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'text and (userId or groupId) required' }));
                  return;
                }
                if (groupId) {
                  sendToQQ(String(groupId), text, true);
                } else {
                  sendToQQ(String(userId), text, false);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
              }
              return;
            }
            res.writeHead(404);
            res.end('not found');
          });

          await new Promise((resolve) => {
            httpServer.on('error', (err) => {
              log.error(`[HTTP] error: ${err.message}`);
              resolve();
            });
            httpServer.listen(httpPort, '127.0.0.1', () => {
              log.info(`[HTTP] proactive send endpoint on 127.0.0.1:${httpPort}/send`);
              resolve();
            });
          });
        }

        log.info(`openclaw-qq plugin started`);
        log.info(`  NapCat WS: ${napcatWs}`);
        log.info(`  OpenClaw:  CLI mode (openclaw agent)`);
        log.info(`  Bot QQ:    ${botQQ || '(not set)'}`);
        log.info(`  Users:     ${allowedUsers.length > 0 ? allowedUsers.join(', ') : '(all)'}`);
        log.info(`  Voice:     ${voiceEnabled ? 'on' : 'off'} | TTS: ${voiceReplyEnabled ? 'on' : 'off'}`);
        log.info(`  Groups:    send-only via /send endpoint`);
      },

      async stop() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (napcat) napcat.close();
        if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
        log.info('openclaw-qq plugin stopped');
      },
    });
  },
};

export default plugin;
