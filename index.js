import WebSocket from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const plugin = {
  register(api) {
    const cfg = api.pluginConfig || {};
    const napcatWs = cfg.napcatWs || process.env.NAPCAT_WS;
    const napcatToken = cfg.napcatToken || process.env.NAPCAT_TOKEN || '';
    const botQQ = String(cfg.botQQ || process.env.BOT_QQ || '');
    const allowedUsers = cfg.allowedUsers || [];
    const allowedGroups = cfg.allowedGroups || [];
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

    // ── Image handling ──
    const IMAGE_CACHE_DIR = '/tmp/openclaw-qq-images';
    const IMAGE_MAX_AGE_MS = 60 * 60 * 1000;

    async function downloadImage(imageUrl) {
      try {
        log.info(`[Image] downloading ${imageUrl.slice(0, 100)}`);
        const response = await fetch(imageUrl);
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > 10 * 1024 * 1024) return null;
        await fs.mkdir(IMAGE_CACHE_DIR, { recursive: true });
        const ext = (buffer[0] === 0x89 && buffer[1] === 0x50) ? '.png'
          : (buffer[0] === 0x47 && buffer[1] === 0x49) ? '.gif' : '.jpg';
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        const filepath = path.join(IMAGE_CACHE_DIR, filename);
        await fs.writeFile(filepath, buffer);
        log.info(`[Image] saved ${filename} (${(buffer.byteLength / 1024).toFixed(1)}KB)`);
        return filepath;
      } catch (err) {
        log.error(`[Image] download failed: ${err.message}`);
        return null;
      }
    }

    async function cleanupImageCache() {
      try {
        const files = await fs.readdir(IMAGE_CACHE_DIR).catch(() => []);
        const cutoff = Date.now() - IMAGE_MAX_AGE_MS;
        for (const file of files) {
          const filepath = path.join(IMAGE_CACHE_DIR, file);
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
      const imagePrompts = [];

      for (const seg of message) {
        if (seg.type === 'text') {
          textParts.push(seg.data?.text ?? '');
        } else if (seg.type === 'image') {
          const url = seg.data?.url;
          if (url) {
            const localPath = await downloadImage(url);
            if (localPath) {
              imagePrompts.push(`[用户发送了一张图片]\n本地路径: ${localPath}\n请使用image工具分析这张图片并回复用户。`);
            } else {
              imagePrompts.push(`[用户发送了一张图片]\n图片URL: ${url}`);
            }
          }
        }
      }

      let result = textParts.join('').trim();
      if (imagePrompts.length > 0) {
        result = result ? `${result}\n\n${imagePrompts.join('\n\n')}` : imagePrompts.join('\n\n');
      }
      return result;
    }

    function stripMention(text) {
      // Remove CQ-style @mentions and plain @mentions of bot
      return text.replace(/\[CQ:at,qq=\d+\]/g, '').replace(new RegExp(`@${botQQ}\\s*`, 'g'), '').trim();
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

    // ── OpenClaw API ──

    async function callOpenClaw(text, sessionId) {
      const headers = { 'Content-Type': 'application/json' };
      if (gwToken) headers['Authorization'] = `Bearer ${gwToken}`;

      log.info(`[OpenClaw ->] session=${sessionId} text=${text.slice(0, 100)}`);

      const res = await fetch(openclawApi, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'openclaw', input: text, user: sessionId, stream: false }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json();
      const texts = [];
      if (data.output && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === 'output_text' && part.text) texts.push(part.text);
            }
          }
        }
      }
      const reply = texts.join('\n').trim() || null;
      if (reply) log.info(`[OpenClaw <-] len=${reply.length}`);
      return reply;
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
        try { data = JSON.parse(raw); } catch { return; }

        // Skip API responses
        if (data.echo) return;
        if (data.post_type !== 'message') return;

        const msgId = data.message_id;
        if (isDuplicate(msgId)) return;

        const isGroup = data.message_type === 'group';
        const userId = String(data.user_id || '');
        const groupId = String(data.group_id || '');

        // Filter: skip bot's own messages in groups
        if (isGroup && botQQ && userId === botQQ) return;

        // Filter: check allowlists
        if (isGroup) {
          if (allowedGroups.length === 0) return;
          if (!allowedGroups.includes(groupId)) return;
        } else {
          if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) return;
        }

        // In groups, only respond when @mentioned
        if (isGroup) {
          const mentioned = Array.isArray(data.message) && data.message.some(
            seg => seg.type === 'at' && String(seg.data?.qq) === botQQ
          );
          if (!mentioned) return;
        }

        let text = await extractContent(data.message);
        if (isGroup) text = stripMention(text);
        if (!text) return;

        const source = isGroup ? `group:${groupId}:${userId}` : `user:${userId}`;
        log.info(`[<- ${source}] ${text.slice(0, 100)}`);

        const sessionId = isGroup ? `qq_group_${groupId}` : `qq_${userId}`;

        // Context reset
        if (RESET_COMMANDS.includes(text.trim().toLowerCase())) {
          const msg = await resetSession(sessionId);
          sendToQQ(isGroup ? groupId : userId, msg, isGroup);
          return;
        }

        // Call OpenClaw
        try {
          const reply = await callOpenClaw(text, sessionId);
          if (reply) {
            sendToQQ(isGroup ? groupId : userId, reply, isGroup);
          }
        } catch (err) {
          log.error(`[OpenClaw] error: ${err.message}`);
          sendToQQ(isGroup ? groupId : userId, '服务暂时不可用，请稍后再试。', isGroup);
        }

        cleanupImageCache();
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
        log.info(`  OpenClaw:  ${openclawApi}`);
        log.info(`  Bot QQ:    ${botQQ || '(not set)'}`);
        log.info(`  Users:     ${allowedUsers.length > 0 ? allowedUsers.join(', ') : '(all)'}`);
        log.info(`  Groups:    ${allowedGroups.length > 0 ? allowedGroups.join(', ') : '(disabled)'}`);
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
