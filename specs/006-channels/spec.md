# 006: Multi-Channel Messaging

## Problem

Matrix OS is only accessible through the web shell. If the browser tab is closed, there's no way to interact. Users live in Telegram, WhatsApp, Discord, and Slack -- the OS should meet them where they are.

## Solution

Channel adapters in the gateway that accept messages from messaging platforms and route them through the existing dispatcher to the kernel. Each channel is a "shell" per Principle III (Headless Core, Multi-Shell). Channel config lives in `~/system/config.json` (Everything Is a File).

## Design

### ChannelAdapter Interface

```typescript
interface ChannelAdapter {
  readonly id: ChannelId;
  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  onMessage: (msg: ChannelMessage) => void;
}

type ChannelId = "telegram" | "whatsapp" | "discord" | "slack";

type ChannelMessage = {
  source: ChannelId;
  senderId: string;
  senderName?: string;
  text: string;
  chatId: string;
  replyToId?: string;
};
```

### Message Flow

```
Messaging Platform --> Adapter.onMessage()
  --> ChannelManager --> Dispatcher.dispatch()
  --> Kernel (with channel context injected)
  --> Response --> formatForChannel() --> Adapter.send()
```

### Channel Context

When a message comes from a channel, the kernel prompt gets:
- `[Channel: telegram] [User: @hamed]` prefix
- `channel-routing.md` knowledge file (formatting rules per channel)

### Session Management

Each `{channelId}:{senderId}` maps to a conversation. Shared with web shell's ConversationStore. Start a conversation on Telegram, continue on web desktop.

### Formatting

Kernel outputs markdown. `formatForChannel()` converts:
- Telegram: MarkdownV2 (escape special chars)
- WhatsApp: plain text (basic formatting)
- Discord: native markdown (mostly passthrough)
- Slack: mrkdwn (`**bold**` -> `*bold*`)

### Channel Config

```json
{
  "channels": {
    "telegram": { "enabled": true, "token": "...", "allowFrom": ["user_id"] },
    "whatsapp": { "enabled": false, "authDir": "system/whatsapp-auth", "allowFrom": [] },
    "discord": { "enabled": false, "token": "", "allowFrom": [] },
    "slack": { "enabled": false, "botToken": "", "appToken": "", "allowFrom": [] }
  }
}
```

### Implementation Order

1. **Telegram** -- simplest. HTTP polling via `node-telegram-bot-api`. ~100 lines.
2. **WhatsApp** -- Baileys (QR code pairing). ~200 lines.
3. **Discord** -- `discord.js` with Gateway Intents. ~150 lines.
4. **Slack** -- `@slack/bolt` Socket Mode. ~150 lines.

## Dependencies

- Phase 3 (Kernel) -- complete
- Dispatcher exists in `packages/gateway/src/dispatcher.ts`
- ConversationStore exists in `packages/gateway/src/conversations.ts`

## File Locations

```
packages/gateway/src/channels/
  types.ts       # ChannelAdapter interface, types
  manager.ts     # ChannelManager lifecycle
  format.ts      # formatForChannel()
  telegram.ts    # Telegram adapter
  whatsapp.ts    # WhatsApp adapter
  discord.ts     # Discord adapter
  slack.ts       # Slack adapter
```
