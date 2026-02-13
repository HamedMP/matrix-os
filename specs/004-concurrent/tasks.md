# Tasks: Concurrent Kernel Dispatch

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T054-T056 (from original plan)

## User Story

- **US5** (P1): "Multiple requests run without blocking each other"

## Tests (TDD)

- [ ] T054a [P] [US5] Write `tests/gateway/dispatcher-concurrent.test.ts` -- test: fires multiple kernels in parallel, each gets unique process ID, `Promise.allSettled` returns all results, processes table has correct entries during execution

## Implementation

- [ ] T054 [US5] Implement concurrent kernel dispatch in `packages/gateway/src/dispatcher.ts` -- `Promise.allSettled` for parallel `spawnKernel()` calls, tag responses with request ID for WebSocket multiplexing, no blocking between requests

- [ ] T055 [US5] Implement process registration in `packages/kernel/src/index.ts` -- kernel instances register in tasks table on spawn (`{ type: "kernel", task: description, status: "running", touching: [paths] }`), deregister on complete/crash. Replaces `processes.json` as source of truth. Generate `processes.json` and `state.md` from SQLite for system prompt L1 cache.

- [ ] T056 [US5] Add conflict avoidance in `packages/kernel/src/prompt.ts` -- kernel reads active processes before starting, system prompt includes active process list, avoids paths claimed by other kernels. Add rule: "if 3+ kernels running, prefer direct handling over sub-agent spawning"

## Checkpoint

Send "Build me a CRM" and immediately "Make the theme darker". Both run in parallel. Theme changes while CRM builds. No file conflicts.
