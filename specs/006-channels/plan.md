# Plan: Multi-Channel Messaging

**Spec**: `specs/006-channels/spec.md`
**Depends on**: Phase 3 (complete)
**Estimated effort**: Large (14 tasks + TDD, but adapters are parallelizable)

## Approach

Build infrastructure first (types, manager, format), then adapters one at a time. Telegram first (simplest, most common), then WhatsApp, Discord, Slack.

### Phase A: Infrastructure

1. Define `ChannelAdapter` interface + types
2. Implement `ChannelManager` (lifecycle, routing)
3. Implement `formatForChannel()` (markdown conversion per channel)
4. Modify dispatcher to accept `ChannelMessage`
5. Add channel context injection to kernel prompt
6. Create `channel-routing.md` knowledge file

### Phase B: Telegram (first adapter)

7. Implement Telegram adapter (polling, `node-telegram-bot-api`)
8. Add channel config section to `home/system/config.json`

### Phase C: WhatsApp

9. Implement WhatsApp adapter (Baileys, QR pairing)
10. QR code login endpoint

### Phase D: Discord

11. Implement Discord adapter (discord.js, Gateway Intents)

### Phase E: Slack

12. Implement Slack adapter (@slack/bolt, Socket Mode)

### Phase F: Integration

13. Wire ChannelManager into gateway startup
14. Add channel status to shell (status indicator, API endpoint)

## Files to Create

- `packages/gateway/src/channels/types.ts`
- `packages/gateway/src/channels/manager.ts`
- `packages/gateway/src/channels/format.ts`
- `packages/gateway/src/channels/telegram.ts`
- `packages/gateway/src/channels/whatsapp.ts`
- `packages/gateway/src/channels/discord.ts`
- `packages/gateway/src/channels/slack.ts`
- `home/agents/knowledge/channel-routing.md`
- `tests/gateway/channels/types.test.ts`
- `tests/gateway/channels/manager.test.ts`
- `tests/gateway/channels/telegram.test.ts`
- `tests/gateway/channels/message-format.test.ts`

## Files to Modify

- `packages/gateway/src/dispatcher.ts` -- accept ChannelMessage
- `packages/gateway/src/server.ts` -- wire ChannelManager, add status endpoint
- `packages/kernel/src/prompt.ts` -- channel context injection
- `home/system/config.json` -- add channels section
