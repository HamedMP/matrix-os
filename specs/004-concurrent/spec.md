# 004: Concurrent Kernel Dispatch

## Problem

Currently the gateway serializes kernel requests -- one at a time. If you ask "Build me a CRM" and immediately "Make the theme darker", the second request waits for the first to finish. For a real OS, parallel execution is expected.

## Solution

Multiple `spawnKernel()` calls run simultaneously via `Promise.allSettled`. Each kernel instance registers itself in the SQLite tasks table with `touching` paths to avoid file conflicts. This replaces the conceptual `processes.json` -- SQLite is the single source of truth for active processes, and `state.md`/`processes.json` are generated views for the system prompt.

## Design

### Concurrent Dispatch

The dispatcher wraps each `spawnKernel()` in a promise and does not await before accepting the next request. WebSocket responses are tagged with a request ID so the shell can multiplex streaming responses.

### Process Registration

Each kernel instance, on startup:
1. Inserts a row into the tasks table: `{ type: "kernel", task: "description", status: "running", touching: [paths] }`
2. Reads existing active processes to know what paths are claimed
3. Avoids writing to paths claimed by other kernels
4. Deregisters on completion (or crash via cleanup)

### Conflict Avoidance

- File-level claiming via `touching` field
- Kernels naturally work in different directories (builder in `~/modules/new-app/`, theme change in `~/system/theme.json`)
- For rare collisions: re-read state, retry with awareness
- System prompt rule: "if 3+ kernels running, prefer direct handling over sub-agent spawning" to limit resource usage

## Dependencies

- Phase 3 (Kernel) -- complete
- Dispatcher exists in `packages/gateway/src/dispatcher.ts`
- SQLite tasks table exists in `packages/kernel/src/schema.ts`

## Scope

3 tasks (T054-T056). This is incremental work on existing dispatcher and kernel code.
