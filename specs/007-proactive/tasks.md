# Tasks: Cron + Heartbeat

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T120-T129 (from original plan)

## User Story

- **US9** (P1): "The OS proactively reaches out with reminders and updates"

## Tests (TDD -- write FIRST)

- [x] T120a [P] [US9] Write `tests/gateway/cron/service.test.ts` -- test `CronService`: add job, remove job, list jobs, trigger fires at correct time, persists to `cron.json`, survives restart, deduplicates job IDs

- [x] T120b [P] [US9] Write `tests/gateway/cron/store.test.ts` -- test cron store: CRUD on `cron.json`, handles corrupt file, atomic writes

- [x] T120c [P] [US9] Write `tests/gateway/heartbeat/runner.test.ts` -- test `HeartbeatRunner`: invokes kernel on interval, skips if kernel already active, reads heartbeat.md content, injects cron events, respects active hours

## Cron Service

- [x] T120 [US9] Implement `CronService` in `packages/gateway/src/cron/service.ts` -- manages scheduled jobs. Uses `node-cron` for cron expressions, `setInterval` for intervals, `setTimeout` for one-shot. On trigger: dispatch immediately or enqueue for heartbeat.

- [x] T121 [US9] Implement cron store in `packages/gateway/src/cron/store.ts` -- reads/writes `~/system/cron.json`. Atomic writes (write temp + rename). Load on startup, save on mutation.

- [x] T122 [US9] Add `cron` IPC tool to kernel MCP server in `packages/kernel/src/ipc.ts` -- `cron({ action: "add"|"remove"|"list", name?, message?, schedule?, jobId? })`. Enables: "Remind me to drink water every 2 hours" -> kernel creates cron job.

- [x] T123 [P] [US9] Create `home/system/cron.json` -- empty array `[]` in home template

## Heartbeat Runner

- [x] T124 [US9] Implement `HeartbeatRunner` in `packages/gateway/src/heartbeat/runner.ts` -- fires every N minutes (configurable, default 30m). Reads `~/agents/heartbeat.md`, checks cron events, builds prompt, invokes kernel via dispatcher with `{ source: "heartbeat" }`.

- [x] T125 [US9] Implement heartbeat prompt builder in `packages/gateway/src/heartbeat/prompt.ts` -- includes heartbeat.md content, pending cron events, current time, channel status. Instructions: execute due tasks, relay cron messages, write observations, respond HEARTBEAT_OK if nothing to do.

- [x] T126 [US9] Add active hours support -- heartbeat only fires between configured hours. Config in `~/system/config.json`: `{ heartbeat: { everyMinutes, activeHours: { start, end, timezone } } }`. Outside active hours: health checks only.

- [x] T127 [US9] Wire heartbeat responses to channels -- if heartbeat kernel produces a channel-targeted message, route through `ChannelManager.send()`

## Integration

- [x] T128 [US9] Wire cron + heartbeat into gateway startup in `packages/gateway/src/server.ts` -- start after channels, stop on SIGTERM, add status to `GET /health`

- [x] T129 [US9] Update `home/agents/heartbeat.md` -- default tasks: health checks, pending reminders, observations section

## Checkpoint

Start gateway. Set `everyMinutes: 1` for testing. Heartbeat fires, kernel reads heartbeat.md, reports HEARTBEAT_OK. Ask kernel "Remind me to stretch every hour" -> cron job created -> appears in cron.json -> heartbeat picks it up -> sends reminder to configured channel.
