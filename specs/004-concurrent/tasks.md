# Tasks: Concurrent Kernel Dispatch

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T054-T056 (from original plan)

## User Story

- **US5** (P1): "Multiple requests run without blocking each other"

## Critical Pre-Requisite: Serial Dispatch Queue

This task must be completed BEFORE Phase 006 (channels). Without it, web shell + Telegram + cron can all call `dispatcher.dispatch()` simultaneously, corrupting home directory state.

- [x] T053a [P] [US5] Write `tests/gateway/dispatcher-queue.test.ts` -- test: second dispatch waits for first to finish, queue drains in order, errors don't block queue, queue reports length
- [x] T053 [US5] Add serial dispatch queue to `packages/gateway/src/dispatcher.ts` -- FIFO queue with mutex. Second `dispatch()` call waits for first to complete before spawning kernel. No parallel execution yet (that's T054). Prevents file corruption from concurrent kernel writes.

## Tests (TDD)

- [x] T054a [P] [US5] Write `tests/gateway/dispatcher-concurrent.test.ts` -- test: fires multiple kernels in parallel, each gets unique process ID, `Promise.allSettled` returns all results, processes table has correct entries during execution

## Dependencies

- T053 must be completed before Phase 006 (channels). It serializes dispatch; T054 later upgrades to parallel.
- T054 modifies `dispatcher.ts` -- coordinate with T109 (006 channel-aware dispatch) which also modifies dispatcher. Complete T109 first.
- T056 modifies `prompt.ts` -- coordinate with T110 (006 channel prompt context) which also modifies prompt builder. Complete T110 first.

## Implementation

- [x] T054 [US5] Implement concurrent kernel dispatch in `packages/gateway/src/dispatcher.ts` -- `maxConcurrency` option (default Infinity), bounded concurrent queue, parallel `spawnKernel()` calls with independent events, `activeCount` tracking. (Depends on: T109)

- [x] T055 [US5] Implement process registration in `packages/gateway/src/dispatcher.ts` -- kernel processes register in SQLite tasks table on dispatch start (`{ type: "kernel", status: "in_progress" }`), deregister on complete/fail via IPC functions. Active processes queryable via `listTasks`.

- [x] T056 [US5] Add conflict avoidance in `packages/kernel/src/prompt.ts` -- `buildSystemPrompt` accepts optional `db` parameter, reads active kernel processes, includes "Active Processes" section in system prompt, adds "3+ kernels" concurrency warning. `kernelOptions` passes `db` to prompt builder.

## Checkpoint

Send "Build me a CRM" and immediately "Make the theme darker". Both run in parallel. Theme changes while CRM builds. No file conflicts.
