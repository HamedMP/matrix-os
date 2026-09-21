# S18 direct owner routes receipt

**Packet:** T090 corrective direct-session admission; T095 authorization review finding. **Date:** 2026-09-21. **Base:** corrected ancestry `e5392e0520cd9a7ba90b196494ba804f02fb6c49`. **Code head:** `72e8cc9b8`. This child has not been pushed or submitted and still needs linearization with the S18 release stack.

## Scope and changed files

The code commit changes 14 files, **+524/−75**, below the 3,000-addition/50-file limits. Gateway owner routes for execution policy, project inventory/confirmation, lifecycle, scope/member reads, invitation acceptance, and pending grant acceptance now use a signed direct session when the home has direct sessions configured. A legacy actor proof alone cannot authorize them. Invitation authentication precedes identifier lookup, so unsigned requests cannot distinguish known from unknown invitations.

Private and preparing project scopes have no ordinary shared-scope ticket. An exact owner-runtime session admits only scope and member reads plus project inventory and confirmation for that state. Home authorization rechecks the current scope, accepted owner row, organization, runtime, and authority generation. The client obtains a fresh owner-runtime ticket for those exact paths. Its bounded, in-memory prepared-scope hint is recovered by the project's existing preflight-first Share flow after reload; it is not an authority source. The ordinary shared-scope direct client remains the path after project publication.

## RED → GREEN

Tests were written before each behavior change. The first real-Postgres direct-owner suite failed 11/11 on signed owner paths before route conversion. An unsigned known invitation returned 401 while an unknown one returned 404 before authentication was moved ahead of lookup. The prepared-project route test failed with 401 rather than the expected authorized path; the client test failed because it tried to acquire an ordinary scope ticket through `/api/collaboration/connections`. The owner-runtime allowlist test initially denied the exact prepared-project routes. The legacy pending-grant fixture exposed that the route still accepted an actor proof alone and was changed to require rejection.

Final focused command, with the protected real-Postgres test environment sourced: `pnpm exec vitest run tests/gateway/collaboration-direct-owner-routes.test.ts tests/gateway/collaboration-owner-runtime-sessions.test.ts tests/ui/collaboration-owner-runtime-client.test.ts --maxWorkers=2` — **3 files, 19/19 passed**. The UI client suite includes a fresh-client reload/preflight recovery. A later targeted real-Postgres run added negative stale-generation and foreign-organization cases for the private project: **1/1 passed, 13 skipped**. The changed policy denial fixture passed **1/1, 38 skipped**.

Adjacent real-Postgres gateway run: `pnpm exec vitest run tests/gateway/collaboration-capability-routes.test.ts tests/gateway/collaboration-owner-source.test.ts tests/gateway/collaboration-routes.test.ts --maxWorkers=2` — **78/79 passed** before updating one old non-owner 403 response-string expectation. The status and `forbidden` code had already matched; the generic error text now matches the new authorization mapper, and its targeted rerun passed as recorded above. The other 78 cases were not rerun after that assertion-only change. `bun run typecheck` exited 0; gateway `tsc --noEmit` exited 0; `bun run check:patterns` exited 0 with zero violations and five existing warnings; `git diff --check` was clean.

## Environment, surfaces, and limits

- **Database:** The gateway authorization, membership, invitation, project-state, and generation checks ran against the configured real Postgres test database. No migration was added by this child; rollback is a code revert after the corrected S18 ancestry is assembled. Tests use isolated fixtures and do not alter production data.
- **Host and transport:** Hono routes and Ed25519 request signatures were tested in process. The UI client used an instrumented fake network to prove exact owner-runtime route selection and reload recovery. A live owner-home network journey and production restart were not run.
- **Provider:** No AI provider or harness was called. Execution-policy route authorization was tested, not live shared AI execution.
- **Surfaces:** No React component changed, so React Doctor and Web Canvas/Web Desktop/Electron Desktop screenshots are not applicable to this route/client layer. Existing project Share uses the shared component; no live surface probe was run here.

## Integration gates

The parent coordinator must rebase this child above the final corrected S18 ancestry, then rerun affected route and client suites. The S18 platform retirement must keep a working direct path for existing 525 CLI Chat and terminal commands; that compatibility audit is separate from this owner-route commit. No live credentials, paid services, deployment, or external publication were used.
