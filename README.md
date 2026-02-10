# OpenClaw QQ Plugin

QQ 智能助手桥接插件，通过 NapCat (OneBot v11) 将 OpenClaw AI 接入 QQ。

[![npm version](https://img.shields.io/npm/v/@creatoraris/openclaw-qq.svg)](https://www.npmjs.com/package/@creatoraris/openclaw-qq)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 特性

- 支持私聊和群聊
- 群聊中 @机器人 触发回复
- 支持图片消息（自动下载并交给 AI 分析）
- 支持上下文重置（发送 `/reset` 或 `/重置`）
- 自动消息去重
- 用户/群组白名单控制
- 可选 HTTP 接口用于主动推送消息
- 作为 OpenClaw 插件运行，随 Gateway 自动启停

## 前置条件

- OpenClaw 已安装并运行
- Node.js >= 18.0.0
- [NapCat](https://github.com/NapNeko/NapCatQQ) 已安装并配置好 OneBot v11 WebSocket
- 一个用于挂机的 QQ 账号

## 快速开始

### 步骤 1：安装 NapCat

参考 [NapCat 文档](https://github.com/NapNeko/NapCatQQ) 安装并登录 QQ 账号。

确保 NapCat 配置中启用了 OneBot v11 正向 WebSocket，记录：
- WebSocket 地址（如 `ws://127.0.0.1:3001`）
- access_token（如果设置了的话）

### 步骤 2：安装插件

```bash
openclaw plugins install @creatoraris/openclaw-qq
```

### 步骤 3：配置插件

编辑 `~/.openclaw/openclaw.json`，在 `plugins.entries` 中添加：

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

### 步骤 4：重启 OpenClaw

```bash
systemctl --user restart openclaw-gateway
```

### 步骤 5：测试

在 QQ 中给机器人发送私聊消息，应该会收到 AI 回复。

## 配置说明

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `napcatWs` | 是 | - | NapCat OneBot v11 WebSocket 地址 |
| `napcatToken` | 否 | `""` | NapCat access_token |
| `botQQ` | 否 | `""` | 机器人 QQ 号，用于群聊过滤自身消息 |
| `allowedUsers` | 否 | `[]` | 允许私聊的 QQ 号列表，空数组 = 允许所有人 |
| `allowedGroups` | 否 | `[]` | 允许群聊的群号列表，空数组 = 禁用群聊 |
| `port` | 否 | `0` | HTTP 主动推送端口，0 = 禁用 |

## 内置命令

在 QQ 聊天中发送以下命令：

| 命令 | 说明 |
|------|------|
| `/reset` | 重置当前对话上下文 |
| `/重置` | 同上（中文别名） |

## 群聊使用

1. 将 `allowedGroups` 配置为允许的群号列表
2. 将 `botQQ` 配置为机器人的 QQ 号
3. 在群内 @机器人 + 消息内容 即可触发回复

## 主动推送消息

启用 `port` 配置后，可以通过 HTTP 接口主动向 QQ 发送消息：

```bash
# 私聊
curl -X POST http://127.0.0.1:<port>/send \
  -H 'Content-Type: application/json' \
  -d '{"userId": "111111111", "text": "你好"}'

# 群聊
curl -X POST http://127.0.0.1:<port>/send \
  -H 'Content-Type: application/json' \
  -d '{"groupId": "222222222", "text": "你好"}'
```

## 架构说明

```
QQ 客户端 -> QQ 服务器 -> NapCat (OneBot v11) -> 本插件 (WebSocket) -> OpenClaw Gateway -> AI 模型
```

本插件作为 OpenClaw 的内置服务运行，随 Gateway 自动启停，无需单独部署。

## 故障排查

查看日志：

```bash
journalctl --user -u openclaw-gateway -f
```

常见问题：

- **NapCat 连接失败**：确认 NapCat 正在运行且 WebSocket 地址和 token 正确
- **群聊无回复**：确认群号在 `allowedGroups` 中，且消息中 @了机器人
- **私聊无回复**：确认 QQ 号在 `allowedUsers` 中（或 `allowedUsers` 为空数组允许所有人）

## License

MIT License - 详见 [LICENSE](LICENSE) 文件
