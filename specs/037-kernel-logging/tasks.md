# Tasks: Kernel Operation Logging

**Spec**: spec.md
**Task range**: T1350-T1379
**Deps**: None (extends existing infrastructure)

## User Stories

- **US58**: "I can see exactly what every kernel dispatch cost in tokens and dollars"
- **US59**: "I can trace which tools were called, what they received, and what they returned"
- **US60**: "I can see per-user costs to bill accurately and enforce quotas"
- **US61**: "File mutations are audited so I can detect rogue agent behavior"

---

## Phase A: Token + User Tracking (T1350-T1355)

### Tests (TDD)

- [ ] T1350a [US58] Write `tests/gateway/logger-enhanced.test.ts`:
  - Logger records tokensIn/tokensOut from kernel result
  - Logger records senderId from dispatch context
  - Logger handles missing token data gracefully (defaults to 0)
  - Logger records sessionId for conversation threading
  - JSONL entry has all required fields

### T1350 [US58] Spike: Agent SDK token reporting
- [ ] Write `spike/token-reporting.ts`: call `query()`, inspect result object for token fields
- [ ] Document: does `KernelResult` have `inputTokens`/`outputTokens`? Or only `cost`?
- [ ] If tokens available: document the field names
- [ ] If NOT available: document workaround (estimate from cost + model pricing)
- [ ] Delete spike file after documenting findings

### T1351 [US58] Enhanced interaction log schema
- [ ] Update `InteractionLogEntry` type in `packages/gateway/src/logger.ts`
- [ ] Add fields: `senderId`, `conversationId`, `model`, `agentName`
- [ ] Update `tokensIn`/`tokensOut` to use real values from kernel result (per T1350 findings)
- [ ] Ensure backward compatibility (old log entries still parseable)

### T1352 [US60] Wire senderId into interaction logger
- [ ] Pass `context.senderId` from dispatcher to logger
- [ ] Pass `context.conversationId` (or sessionId) to logger
- [ ] Update `runSerial()` to include user context in log call
- [ ] Update `runBatch()` to log per-entry (currently no logging)

### T1353 [US59] Tool execution logging
- [ ] Capture tool events from kernel streaming: name, duration, truncated input (500 chars), status
- [ ] Store as `tools` array in log entry: `[{name, durationMs, inputPreview, status}]`
- [ ] Replace current `toolsUsed: string[]` with richer tool array
- [ ] Keep tool output out of logs (too large) -- only log errors

### T1354 [US58] Structured error logging
- [ ] On dispatch error: capture `Error.name`, `Error.message`, `Error.stack` (truncated)
- [ ] Store as `error` object in log entry (not just status string)
- [ ] Include which turn/tool caused the error if available
- [ ] Log entry still written on error (with partial data)

### T1355 [US58] Batch dispatch logging
- [ ] Wire `runBatch()` path into interaction logger
- [ ] Log each batch entry as separate JSONL entry with `batch: true` flag
- [ ] Include batch ID for correlation
- [ ] Track per-entry success/failure

---

## Phase B: Usage Tracking + API (T1360-T1364)

### Tests (TDD)

- [ ] T1360a [US60] Write `tests/gateway/usage-tracker.test.ts`:
  - Tracks cumulative cost per user
  - Tracks token usage per model
  - Returns daily/monthly aggregations
  - Handles concurrent updates safely
  - Persists to disk (JSONL or SQLite)

### T1360 [US60] Wire usage tracker into dispatcher
- [ ] Connect existing `createUsageTracker` to dispatcher
- [ ] On each dispatch completion: record cost + tokens per senderId
- [ ] Aggregate by: user, model, day
- [ ] Persist to `~/system/logs/usage.jsonl` (or SQLite if volume warrants)

### T1361 [US60] GET /api/usage endpoint
- [ ] Add route to gateway server
- [ ] Query params: `userId`, `startDate`, `endDate`, `groupBy` (day/model)
- [ ] Returns: `{ totalCost, totalTokensIn, totalTokensOut, entries: [...] }`
- [ ] Auth: requires valid session or admin token

### T1362 [US60] Per-user cost limits
- [ ] Add `costLimits` to config.json: `{ daily: number, monthly: number }` per user
- [ ] Dispatcher checks cost before dispatch
- [ ] If over limit: reject with 429 + message "Daily cost limit reached"
- [ ] Configurable: disabled by default (limit: 0 = unlimited)

---

## Phase C: File Audit Trail (T1370-T1374)

### Tests (TDD)

- [ ] T1370a [US61] Write `tests/kernel/audit-logger.test.ts`:
  - Logs file write operations with path, size, actor
  - Logs file delete operations
  - Handles rapid successive writes (batching)
  - Rotates daily
  - JSONL format is parseable

### T1370 [US61] File audit logger
- [ ] Create `packages/kernel/src/audit.ts`
- [ ] `createAuditLogger(logDir)` factory
- [ ] Log entry: `{ timestamp, op: "write"|"delete"|"mkdir", path, sizeBytes, actor, agentName }`
- [ ] Write to `~/system/logs/audit.jsonl`
- [ ] Async write (non-blocking, buffered)

### T1371 [US61] Instrument kernel file tools
- [ ] In PreToolUse/PostToolUse hooks: detect file mutation tools (Write, Edit, Bash with file ops)
- [ ] Call audit logger on file mutations
- [ ] Extract agent name from context for `actor` field
- [ ] Don't audit read operations (too noisy)

### T1372 Log rotation
- [ ] Rotate `activity.log` daily: rename to `activity-{YYYY-MM-DD}.log`
- [ ] Rotate `audit.jsonl` daily: rename to `audit-{YYYY-MM-DD}.jsonl`
- [ ] Delete files older than 30 days
- [ ] Run rotation in heartbeat service (daily check)
- [ ] Interaction logs already daily-rotated by filename

---

## Checkpoint

1. [ ] `bun run test` passes with all new logging tests
2. [ ] Send message via web: JSONL entry has senderId, tokensIn/Out, tools array
3. [ ] Send via batch: each entry logged separately with batch correlation
4. [ ] GET /api/usage returns per-user cost summary
5. [ ] Builder creates a file: audit.jsonl records the write
6. [ ] activity.log rotated after 1 day (simulated)
7. [ ] Cost limit: send message over limit -> 429 response
