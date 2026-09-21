# S18 receipt — gateway server composition extraction

**Packet:** S18 (issue #1799 prerequisite). **Date:** 2026-09-21. **Branch:** `124/s18-server-composition`, based on `124/s18-terminal-ws`. **Result:** `packages/gateway/src/server.ts` shrank from 3,842 to 1,886 lines by moving route and startup composition into focused modules. No endpoint contract, authorization policy, collaboration migration, database transaction, or lock order is intended to change in this layer.

## Layer and ownership

The layer changes 14 files at +2,606 / -2,222 relative to `124/s18-terminal-ws`, within the 3,000-addition and 50-file PR limits. It creates `server/main-ws-routes.ts`, `voice-ws-routes.ts`, `coding-agent-thread-ws-routes.ts`, `message-layout-routes.ts`, `home-utility-routes.ts`, `system-operator-routes.ts`, `shell-terminal-routes.ts`, `operational-routes.ts`, `canvas-gateway-routes.ts`, `collaboration-chat-routes.ts`, `deferred-runtime-routes.ts`, and `startup/channels.ts`. `server.ts` remains the composition entrypoint. `main-ws-routes.ts` is 543 lines because it owns one WebSocket lifecycle; it is the only new module above the 500-line review target.

The extraction was committed in small Conventional Commit increments (`35177392c` through `cb227b68d`) so each route group could be typechecked and tested before the next move. `tests/gateway/chat-terminal-gateway-wiring.test.ts` now inspects the extracted terminal route module as well as the composition entrypoint; its runtime expectations are unchanged.

## RED → GREEN and regression evidence

- Existing `chat-terminal-gateway-wiring.test.ts` source-inspection assertion went RED immediately after `registerTerminalWebSocketRoutes` moved to the extracted module. The test was updated to inspect that module, then its 20 targeted checks passed. This was an assertion-location change, not a runtime behavior change.
- Gateway `tsc --noEmit` passed after every extraction increment and after the final import cleanup.
- Focused existing suites passed during extraction: 38 main WebSocket tests; 17 voice/onboarding WebSocket tests; 81 channel startup tests; 29 coding-agent thread tests; 34 message/layout tests; 78 home utility tests; 98 system operator tests; 55 shell/terminal tests; 59 operational tests; 41 canvas tests; and 92 app runtime, integration, metrics, and Chat tests. These runs overlap; the counts are not a deduplicated total.
- `tests/gateway/chat-agent-routes.test.ts` initially could not import `packages/kernel/dist/tools/integrations.js` in this new worktree because the kernel package had not been built. After `pnpm --filter @matrix-os/kernel build` passed, this suite passed 10/10. The missing built artifact was a worktree setup issue, not an application assertion failure.
- Final full `bun run typecheck`: exit 0, including gateway, platform, proxy, edge router, and Electron Desktop. Final `bun run check:patterns`: exit 0, 0 violations and 5 existing scanner warnings. `git diff --check`: clean.

## Invariants

- **Source of truth:** unchanged. Owner-home Postgres remains the collaboration source of truth; this layer adds no persistent state.
- **Lock/transaction scope:** unchanged. Existing route handler calls and database operations moved behind registration functions; no network call entered a transaction.
- **Acceptable orphan states:** none introduced by route composition.
- **Auth source of truth:** unchanged. Existing gateway authentication middleware and collaboration route authorization remain in their respective modules.
- **Deferred scope:** the actual S18 direct-protocol cutover, journal, signed transport, legacy path removal, and S19 acceptance are separate layers. Live owner/VPS cutover was not run for this extraction.

## Remaining gates

The parent S18 branches and this layer still require final ancestry restack, Graphite PR submission, current-head Greptile 5/5, and CI. The full unit suite was not run locally for this refactor; focused affected suites and the full typecheck are recorded above. No live credentials or customer deployment were used.
