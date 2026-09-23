# S18 receipt — canonical terminal binding prerequisite

**Packet:** S18 / T090 terminal compatibility. **Date:** 2026-09-21. **Branch:** `124/s18-terminal-wiring-probe`, based on `124/s18-server-extraction` `9b80ddae9`. This layer adds owner-Postgres migration v15 after cutover v14 and a canonical workspace/tab bridge. It does not enable terminal sharing until the output and route-composition child is green.

## RED → GREEN

- RED production wiring probe: `pnpm exec vitest run tests/gateway/collaboration-terminal-production-wiring.test.ts --maxWorkers=2` — 1 failed, 1 passed. The missing canonical bridge/`enableSharedTerminal` registration is intentionally reserved for the next layer.
- RED canonical binding suite: `pnpm exec vitest run tests/gateway/collaboration-canonical-terminal-bridge-postgres.test.ts --maxWorkers=2` — failed module import, zero tests collected before the bridge existed.
- RED daemon ID-reuse test: `pnpm exec vitest run tests/terminal-runtime/runtime.test.ts -t 'rejects stale collaboration input' --maxWorkers=2` — 1 failed because input to a replacement tab was accepted.
- RED frozen-clock reuse test: `pnpm exec vitest run tests/terminal-runtime/runtime.test.ts -t 'unique persisted incarnation' --maxWorkers=2` — 1 failed because the public tab had no incarnation.
- GREEN terminal runtime: `pnpm exec vitest run tests/terminal-runtime/runtime.test.ts tests/terminal-runtime/socket-control-ref.test.ts tests/terminal-runtime/socket-attach-order.test.ts --maxWorkers=2` — 3 files, 56/56 passed. This includes same-millisecond tab-ID reuse, restart persistence, strict Unix-socket ref separation, and stale attach/output denial.
- GREEN real PostgreSQL: `pnpm exec vitest run tests/gateway/collaboration-canonical-terminal-bridge-postgres.test.ts --maxWorkers=2` with the local test database env — 5/5 passed. Binding is scoped to exact owner/workspace/tab/nonce, a missing canonical incarnation fails closed, preflight/share rejects rotation, actions revalidate, resize fails closed, and interrupted migration v15 rolls back both table and version row before a successful retry.
- `pnpm --filter @matrix-os/contracts exec tsc --noEmit -p tsconfig.json`, `pnpm --filter @matrix-os/terminal-runtime exec tsc --noEmit -p tsconfig.json`, and `pnpm --filter @matrix-os/gateway exec tsc --noEmit -p tsconfig.json` — all exited 0 after the nonce correction.
- `/home/nima/.bun/bin/bun run check:patterns` — exit 0 after the nonce correction, zero violations and five existing warnings. `git diff --check` was clean.

## Binding and authority

Each canonical tab already has a fresh 128-bit random internal name persisted in the owner's terminal workspace store. The public `ti_` incarnation is a domain-separated digest of that name; the internal name is never exposed. Owner Postgres binds a scope to `tws_*:tt_*`, the public tab incarnation, created-at audit value, owner ID, and execution generation. The terminal daemon checks the expected incarnation inside write, terminate, attach, and soft-resize admission, so a deleted caller-supplied tab ID cannot regain a stale scope even with a frozen clock. Personal terminal callers that do not supply an expected incarnation retain their existing protocol behavior. Shared terminal actions will always supply it once the next layer enables registration.

Two related DB writes remain transactional: migration v15 table/version, and private-scope row lock plus binding insert. The unique terminal ID and scope constraints prevent a second binding. On a failed share, the existing adapter removes the exact private binding; on restart, its private-binding reconciliation can remove an orphan. A stale tab is unavailable rather than mapped to a replacement. The owner home remains the source of truth; platform holds no PTY data.

## Limits and extraction plan

The bridge currently refuses workspace-wide resize; it cannot safely treat it as a terminal-scoped action. Output, controller lease, revoke, and direct owner-home route proof belong to the next child. No live owner/VPS, provider, Web Canvas, Web Desktop, or Electron Desktop probe ran in this layer.

`packages/terminal-runtime/src/runtime.ts` exceeds 1,000 LOC. This layer adds only incarnation comparisons at existing admission points. Before further behavior is added there, extract terminal identity admission and the write/terminate/attach/resize guards into a focused helper, then split tab lifecycle and observer management into separate modules; preserve the serialized mutation/queue boundaries during that refactor.
