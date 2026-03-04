# Spec 037: Kernel Operation Logging

**Goal**: Full visibility into every kernel operation for debugging, billing, and security. Every dispatch, tool call, agent spawn, and file operation is logged with structured data.

## Problem

1. Token counts hardcoded to 0 -- Agent SDK returns `cost` but `tokensIn`/`tokensOut` not captured
2. Tool arguments and outputs not logged -- can't debug failures or understand patterns
3. Batch dispatch path doesn't log at all
4. No per-user cost isolation -- can't bill users or enforce quotas
5. No file operation audit trail -- can't detect rogue writes
6. Agent/sub-agent spawning invisible -- can't trace multi-agent chains
7. Error details lost (caught as string, stack discarded)
8. Activity log never rotated -- unbounded disk growth

## Solution

### A: Enhanced Interaction Logger

Extend the existing JSONL interaction logger with:
- Token breakdown (input/output) from Agent SDK response
- Sender user ID (from DispatchContext)
- Tool execution details (name, duration, truncated args/output)
- Agent spawn events (agent name, parent, input summary)
- Structured error data (type, message, stack trace)

### B: Batch Dispatch Logging

Wire the batch dispatch path (`runBatch`) into the interaction logger with the same fields as serial dispatch.

### C: Usage Tracking

Wire the existing `createUsageTracker` (currently dead code) into the dispatcher:
- Per-user cumulative cost tracking
- Per-model token tracking
- Daily/monthly aggregation
- GET /api/usage endpoint for user-facing cost visibility

### D: File Operation Audit

Lightweight audit log for file mutations performed by the kernel:
- Log to `~/system/logs/audit.jsonl`
- Track: operation (read/write/delete), path, size, actor (agent name), timestamp
- Instrument via PreToolUse/PostToolUse hooks (already exist in kernel)

### E: Log Rotation

- Daily rotation for activity.log (rename to activity-{date}.log)
- Retention policy: keep 30 days, delete older
- Run rotation in heartbeat or cron

## Non-Goals

- Replacing Prometheus metrics (those are for time-series, this is for event logs)
- Building a log viewer UI (use Grafana/Loki)
- Real-time streaming of logs (use file watcher)

## Dependencies

- Spike: verify Agent SDK V1 `query()` result includes token counts (or only cost)
- Existing: interaction logger, dispatcher, file watcher, heartbeat
