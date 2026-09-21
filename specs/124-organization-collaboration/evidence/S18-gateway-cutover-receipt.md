# S18 gateway cutover receipt — owner-home journal and signed control

**Packet:** S18 gateway half of T088–T089. **Date:** 2026-09-21. **Base:** `124/s15` at `e2ded82520dc7ba92cd213b78f21b92cc1d695a3`. **Code head:** `d9b30a958`. This receipt follows the code commit; later Graphite restacks can change these SHAs. The platform journal, transport, startup extraction, final S18 cutover exercise, and S19 acceptance matrix are separate release gates.

## Changed files and behavior

The code layer is 11 files, **+997/−1**, within the 3,000-addition and 50-file limits. It adds `packages/gateway/src/collaboration/cutover.ts` and `cutover-route.ts`; changes gateway collaboration migration, repository lock, route support, routes, and wiring; and adds three cutover suites plus a production wiring assertion.

Gateway migration version 14 creates a durable per-scope cutover journal and shadow grants. Inventory stores a bounded immutable snapshot of scope, exact legacy role ceilings, grant expiry/source/revision, member IDs, and pending invitation IDs. It computes separate ceiling and source-ID digests and a backup reference. Person-to-person rows, overlapping existing grants for a legacy actor, missing disposition for pending legacy invitations, and changed grant expiry block import. The phase flow inventories, fences, drains canonical shared runs, stages deterministic shadow grants, verifies current inventory and shadow rows, then atomically activates the direct generation and retires imported legacy memberships. A compatible direct rollback preserves the target direct generation; disable fences admission. Neither mode reopens legacy ACL authority.

All owner collaboration HTTP mutations check the runtime maintenance fence before side effects. The locked scope write path rechecks the journal inside its transaction, closing the race between route admission and a committed fence. The internal operator route accepts only `POST /internal/collaboration/cutover/:scopeId/:phase` with the ordinary home bearer plus a fresh Ed25519 platform command. It binds owner, runtime, scope, phase, method and path, caps request bytes and command lifetime, and uses a bounded nonce cache. The normal gateway bearer middleware covers this internal path. The home injects its own canonical run-drain callback; the platform request cannot claim a fabricated zero remaining count.

## RED → GREEN

Tests were added before their corresponding implementation changes. The recorded RED observations were:

| Focus | RED observation |
| --- | --- |
| Initial real-Postgres suite | Cutover module import failed; one suite failed and no tests were collected. |
| Inventory and compatible rollback | Two failed, four passed: conflicting grant was accepted by inventory and `rollbackCompatible` was missing. |
| Fence/write race | One failed, six skipped: a writer waiting on the locked scope row resolved after the fence. |
| Pending invitation inventory | One failed, six skipped: invitation count was missing. |
| Compatible rollback admission | One failed, six skipped: maintenance blocked the explicit rollback. |
| False-zero drain | One failed, seven skipped: the cutover marked drained while a canonical run remained active. |
| Grant expiry drift | One failed, eight skipped: verification accepted a changed expiry. |
| Owner route guard | Seven failed, one passed before maintenance checks were registered. |
| Signed route | Initial module import failed; then two passed and one failed because an oversized streamed body returned 401 instead of 413. |
| Production composition | One failed and eleven skipped before the signed route was registered. |

Final command: `pnpm exec vitest run tests/gateway/collaboration-cutover-postgres.test.ts tests/gateway/collaboration-cutover-routes.test.ts tests/gateway/collaboration-cutover-transport.test.ts tests/gateway/collaboration-wiring.test.ts --maxWorkers=2`, with the protected real-Postgres test environment sourced. **Four files and 32/32 tests passed in 31.44 seconds:** Postgres cutover 9, owner route guard 8, signed transport 3, and production wiring 12. The final run includes the post-insert grant binding and ceiling check. `pnpm --filter '@matrix-os/gateway' exec tsc --noEmit` exited 0 after that change. A full `bun run typecheck` had exited 0 before the final post-insert query edit; the gateway typecheck above covers that edit. `bun run check:patterns` exited 0 with 0 violations and five existing warnings. `git diff --check` was clean before commit.

## Database, host, provider, surfaces and rollback

- **Database:** The nine cutover tests used the shared **real Postgres** test database, not PGlite. They exercised version 14 migration, row-lock race, idempotent import, exact ceilings, source-ID and ceiling digests, false drain, interruption, changed grant expiry, compatible rollback and disabled admission. The migration is additive. A destructive down migration was not run; old rows are retained for forward recovery and audit. The route/wiring tests were local Hono composition tests.
- **Host and transport:** The gateway signed route was exercised in process with real Ed25519 commands, normal bearer admission, replay, expiry, owner/runtime binding and body limit. The platform HTTP client, actual cross-host request, restart recovery, production backup store and a live owner-home cutover were **not run** here. The final integrated platform-to-home journal journey remains open after branch linearization. The replay cache is process-local and bounded; durable phase/idempotency checks carry retry safety across restart.
- **Provider:** No AI harness or model provider was called. Canonical shared-run cancellation was injected and tested; live provider interruption was not run.
- **Surfaces:** No React or OS view files changed. Web Canvas, Web Desktop and Electron Desktop are unaffected by this gateway layer and were not interactively probed here. No live credential, deployment, paid service or external publication was used.
- **Rollback:** The real-Postgres suite proved a compatible direct rollback retains the direct generation and a disabled rollback fences both ordinary writes and admission. It did not execute an operator rollout or restore a production backup. Non-organization source records require an explicit disposition before cutover, never silent conversion.

## Integration gates

The platform journal/adapter must be linearized with this home layer and perform an authenticated end-to-end phase sequence, including a real active shared-run drain and interruption/retry, before T089 can be accepted. The platform adapter maps the flat home counts and digests into its grouped journal result; it must preserve source IDs, grant total, deterministic fence digest, and exact generation CAS. The parent coordinator owns the final S18 cutover proof and S19 acceptance matrix. This receipt does not claim the whole S18 packet complete.
