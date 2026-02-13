# 007: Cron + Heartbeat (Proactive Behavior)

## Problem

Matrix OS only acts when asked. A real assistant anticipates needs -- reminders, scheduled reports, pattern-based suggestions. The OS should be proactive, not just reactive.

## Solution

Two complementary systems in the gateway:

1. **Cron** -- scheduled jobs stored in `~/system/cron.json`. The kernel can create/remove jobs via IPC. Jobs fire at configured times and either send a message directly or invoke the kernel.

2. **Heartbeat** -- periodic kernel invocation (default every 30min). Reads `~/agents/heartbeat.md` for pending tasks, checks cron events, acts on what's needed.

## Cron System

### Job Format

```json
{
  "id": "cron_abc123",
  "name": "water-reminder",
  "message": "Time to drink water!",
  "schedule": { "type": "interval", "intervalMs": 7200000 },
  "target": { "channel": "telegram", "chatId": "123456" },
  "createdAt": "2026-02-12T10:00:00Z"
}
```

### Schedule Types

| Type | Field | Example |
|------|-------|---------|
| `cron` | `cron` | `"0 8 * * *"` (daily at 8am) |
| `interval` | `intervalMs` | `7200000` (every 2 hours) |
| `once` | `at` | `"2026-02-12T14:45:00Z"` |

### IPC Tool

Kernel creates/manages cron jobs via `cron` IPC tool:
- `cron({ action: "add", name, message, schedule, target })`
- `cron({ action: "list" })`
- `cron({ action: "remove", jobId })`

Uses `node-cron` for cron expressions, `setInterval` for intervals, `setTimeout` for one-shot.

## Heartbeat System

### How It Works

```
Every N minutes (default 30):
  1. Check active hours (skip if outside)
  2. Read ~/agents/heartbeat.md
  3. Check CronService for pending events
  4. Build heartbeat prompt
  5. Invoke kernel via dispatcher (source: "heartbeat")
  6. Route responses to appropriate channels
```

### Active Hours

Heartbeat respects configured hours to avoid night-time disturbance:
```json
{
  "heartbeat": {
    "enabled": true,
    "everyMinutes": 30,
    "activeHours": { "start": "08:00", "end": "22:00", "timezone": "Europe/Stockholm" }
  }
}
```

Outside active hours: health checks only, no proactive messaging.

### Default heartbeat.md

```markdown
# Heartbeat Tasks

## Health Checks
- [ ] Ping all running web modules (check /health endpoint)
- [ ] If a module fails 3 consecutive checks, spawn healer

## Pending Reminders
(Managed by cron system)

## Observations
(Write patterns you notice here. Suggest automation when appropriate.)
```

## Dependencies

- Phase 3 (Kernel) -- complete
- 006-channels (for routing heartbeat responses to messaging platforms)
- Dispatcher and ConversationStore exist

## File Locations

```
packages/gateway/src/
  cron/
    service.ts    # CronService: schedule, trigger, persist
    store.ts      # Read/write ~/system/cron.json
  heartbeat/
    runner.ts     # HeartbeatRunner: periodic invocation
    prompt.ts     # Build heartbeat prompt
```
