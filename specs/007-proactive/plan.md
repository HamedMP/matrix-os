# Plan: Cron + Heartbeat

**Spec**: `specs/007-proactive/spec.md`
**Depends on**: Phase 3 (complete), 006-channels (for routing heartbeat responses)
**Estimated effort**: Medium (10 tasks + TDD, cron and heartbeat are parallelizable)

## Approach

Two parallel tracks that integrate at the end.

### Track 1: Cron Service

1. Write tests for CronService (add, remove, list, trigger timing, persistence, deduplication)
2. Write tests for cron store (CRUD, corrupt file handling, atomic writes)
3. Implement `CronService` in `packages/gateway/src/cron/service.ts`
4. Implement cron store in `packages/gateway/src/cron/store.ts`
5. Add `cron` IPC tool to kernel's MCP server
6. Create default `home/system/cron.json`

### Track 2: Heartbeat Runner

7. Write tests for HeartbeatRunner (interval, skip if busy, read heartbeat.md, inject events, active hours)
8. Implement `HeartbeatRunner` in `packages/gateway/src/heartbeat/runner.ts`
9. Implement heartbeat prompt builder in `packages/gateway/src/heartbeat/prompt.ts`
10. Add active hours support
11. Wire heartbeat responses to channels
12. Add default `heartbeat.md` content to home template

### Integration

13. Wire cron + heartbeat into gateway startup/shutdown
14. Add status to `GET /health`

## Files to Create

- `packages/gateway/src/cron/service.ts`
- `packages/gateway/src/cron/store.ts`
- `packages/gateway/src/heartbeat/runner.ts`
- `packages/gateway/src/heartbeat/prompt.ts`
- `home/system/cron.json`
- `tests/gateway/cron/service.test.ts`
- `tests/gateway/cron/store.test.ts`
- `tests/gateway/heartbeat/runner.test.ts`

## Files to Modify

- `packages/kernel/src/ipc.ts` -- add `cron` tool
- `packages/gateway/src/server.ts` -- wire cron + heartbeat, health endpoint
- `home/agents/heartbeat.md` -- update default content
