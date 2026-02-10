<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
  <img alt="github contribution snake animation" src="https://raw.githubusercontent.com/CreatorAris/CreatorAris/dist/github-snake.svg" />
</picture>

# OpenClaw QQ Plugin

QQ channel plugin for [OpenClaw](https://openclaw.ai) via [NapCat](https://github.com/NapNeko/NapCatQQ) (OneBot v11).

[![npm version](https://img.shields.io/npm/v/@creatoraris/openclaw-qq.svg)](https://www.npmjs.com/package/@creatoraris/openclaw-qq)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![GitHub stars](https://img.shields.io/github/stars/CreatorAris/openclaw-qq-plugin.svg)](https://github.com/CreatorAris/openclaw-qq-plugin/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/CreatorAris/openclaw-qq-plugin.svg)](https://github.com/CreatorAris/openclaw-qq-plugin/commits)

[中文文档](README_ZH.md)

</div>

## Features

- Private chat and group chat support
- Group chat triggered by @mention
- Image message support (auto download for AI analysis)
- Context reset (`/reset`)
- Auto message deduplication
- User/group allowlist
- Optional HTTP endpoint for proactive messaging
- Runs as an OpenClaw plugin, auto start/stop with Gateway

## Prerequisites

- OpenClaw installed and running
- Node.js >= 18.0.0
- [NapCat](https://github.com/NapNeko/NapCatQQ) installed with OneBot v11 WebSocket enabled
- A QQ account for the bot

## Quick Start

### Step 1: Set up NapCat

Follow the [NapCat documentation](https://github.com/NapNeko/NapCatQQ) to install and log in with your QQ account.

Make sure OneBot v11 forward WebSocket is enabled. Note down:
- WebSocket URL (e.g. `ws://127.0.0.1:3001`)
- access_token (if configured)

### Step 2: Install Plugin

```bash
openclaw plugins install @creatoraris/openclaw-qq
```

> **Note**: You may see a security warning `Plugin contains dangerous code patterns: Environment variable access combined with network send` during installation. This is expected — the plugin needs network access to connect to NapCat WebSocket. Safe to ignore.

### Step 3: Configure

Edit `~/.openclaw/openclaw.json`, add to `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-qq": {
        "enabled": true,
        "config": {
          "napcatWs": "ws://127.0.0.1:3001",
          "napcatToken": "your_napcat_token",
          "botQQ": "123456789",
          "allowedUsers": ["111111111"],
          "allowedGroups": []
        }
      }
    }
  }
}
```

> **Important**: The plugin won't start without `napcatWs` configured. Check logs for `qq: missing napcatWs, plugin disabled`.

### Step 4: Restart OpenClaw

```bash
systemctl --user restart openclaw-gateway
```

### Step 5: Test

Send a private message to the bot on QQ. You should receive an AI reply.

## Configuration

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `napcatWs` | Yes | - | NapCat OneBot v11 WebSocket URL |
| `napcatToken` | No | `""` | NapCat access_token |
| `botQQ` | No | `""` | Bot's QQ number (for filtering self-messages in groups) |
| `allowedUsers` | No | `[]` | Allowed QQ user IDs for private chat. Empty = allow all |
| `allowedGroups` | No | `[]` | Allowed group IDs. Empty = groups disabled |
| `port` | No | `0` | HTTP port for proactive `/send` endpoint. 0 = disabled |

## Commands

| Command | Description |
|---------|-------------|
| `/reset` | Reset conversation context |

## Group Chat

1. Add group IDs to `allowedGroups`
2. Set `botQQ` to the bot's QQ number
3. @mention the bot in group to trigger a reply

## Proactive Messaging

Enable the `port` config to use the HTTP endpoint:

```bash
# Private message
curl -X POST http://127.0.0.1:<port>/send \
  -H 'Content-Type: application/json' \
  -d '{"userId": "111111111", "text": "Hello"}'

# Group message
curl -X POST http://127.0.0.1:<port>/send \
  -H 'Content-Type: application/json' \
  -d '{"groupId": "222222222", "text": "Hello"}'
```

## Architecture

```
QQ Client -> QQ Server -> NapCat (OneBot v11) -> Plugin (WebSocket) -> OpenClaw Gateway -> AI Model
```

## Troubleshooting

View logs:

```bash
journalctl --user -u openclaw-gateway -f
```

Common issues:

- **Security warning on install**: `Plugin contains dangerous code patterns` is expected, safe to ignore
- **Plugin not starting / `missing napcatWs`**: Check `napcatWs` is configured in `openclaw.json`
- **Duplicate replies**: Only one client should connect to NapCat at a time. Check for duplicate processes
- **NapCat connection failed**: Verify NapCat is running and WebSocket URL/token are correct
- **No reply in group**: Ensure group ID is in `allowedGroups` and bot is @mentioned
- **No reply in private chat**: Ensure QQ ID is in `allowedUsers` (or leave empty to allow all)

## License

MIT

