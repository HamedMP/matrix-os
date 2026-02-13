# Tasks: Multi-Channel Messaging

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T106-T119 (from original plan)

## User Stories

- **US8** (P0): "I can message the OS from Telegram/WhatsApp/Discord/Slack"

## Tests (TDD -- write FIRST)

- [ ] T106a [P] [US8] Write `tests/gateway/channels/manager.test.ts` -- test `ChannelManager`: starts adapters from config, stops all on shutdown, routes inbound to dispatcher, routes outbound to correct adapter, handles adapter crash gracefully

- [ ] T106b [P] [US8] Write `tests/gateway/channels/telegram.test.ts` -- test Telegram adapter: config parsing, message normalization, send formatting (markdown to MarkdownV2), `allowFrom` filtering

- [ ] T106c [P] [US8] Write `tests/gateway/channels/message-format.test.ts` -- test `formatForChannel()`: converts kernel markdown to Telegram MarkdownV2, Discord markdown, Slack mrkdwn, WhatsApp plain text

## Infrastructure

- [ ] T106 [US8] Define `ChannelAdapter` interface in `packages/gateway/src/channels/types.ts` -- `ChannelAdapter`, `ChannelId`, `ChannelMessage`, `ChannelReply`, `ChannelConfig` types

- [ ] T107 [US8] Implement `ChannelManager` in `packages/gateway/src/channels/manager.ts` -- reads config from `~/system/config.json`, instantiates enabled adapters, sets `onMessage` callback routing through dispatcher, handles adapter lifecycle

- [ ] T108 [US8] Implement `formatForChannel()` in `packages/gateway/src/channels/format.ts` -- markdown to Telegram MarkdownV2, Discord markdown, Slack mrkdwn, WhatsApp plain text

- [ ] T109 [US8] Modify `packages/gateway/src/dispatcher.ts` to accept `ChannelMessage` -- add `source` field to dispatch context, inject channel info into kernel prompt

- [ ] T110 [US8] Add channel context to kernel prompt -- `[Channel: {id}] [User: {senderName}]` prefix, load `channel-routing.md` knowledge file

## Adapters

- [ ] T111 [US8] Implement Telegram adapter in `packages/gateway/src/channels/telegram.ts` -- `node-telegram-bot-api` polling mode, config `{ token, allowFrom }`, MarkdownV2 output

- [ ] T112 [US8] Add `channels` section to `home/system/config.json` -- Telegram/WhatsApp/Discord/Slack config blocks (all disabled by default)

- [ ] T113 [US8] Implement WhatsApp adapter in `packages/gateway/src/channels/whatsapp.ts` -- `@whiskeysockets/baileys`, QR code pairing, auth persistence in `~/system/whatsapp-auth/`

- [ ] T114 [P] [US8] WhatsApp QR login flow -- `GET /api/channels/whatsapp/qr` returns current QR code for scanning

- [ ] T115 [US8] Implement Discord adapter in `packages/gateway/src/channels/discord.ts` -- `discord.js` Gateway Intents, responds to DMs and @mentions

- [ ] T116 [US8] Implement Slack adapter in `packages/gateway/src/channels/slack.ts` -- `@slack/bolt` Socket Mode, responds to DMs and @mentions

## Integration

- [ ] T117 [US8] Wire `ChannelManager` into gateway startup in `packages/gateway/src/server.ts` -- start after watcher, stop on SIGTERM, add `GET /api/channels/status`

- [ ] T118 [US8] Add channel status to shell -- connected channels indicator (green dots), status in ActivityFeed

- [ ] T119 [P] [US8] Create `home/agents/knowledge/channel-routing.md` -- instructions for kernel on channel-appropriate response format

## Checkpoint

Configure Telegram token in `config.json`, restart gateway. Send message to bot from Telegram. Kernel processes it, responds with properly formatted text. Same message appears in web shell conversation. `GET /api/channels/status` shows `telegram: connected`.
