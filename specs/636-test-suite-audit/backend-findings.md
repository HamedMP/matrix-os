# Backend test audit

Ticket: [ENG-349](https://linear.app/matrix-os/issue/ENG-349/improve-engineering-workflows-and-shipping-velocity-from-the-pr-audit).
Baseline: `be6cce1404bfd6db3392c535bca2e0def32ec577`.

## Evidence and limits

- Full source screening covers **1,769 files**: the assigned 1,765 unit/contract files plus four separately named integration suites. Initial assigned source volume is 351,096 lines. The per-file evidence ledger distinguishes automated screening from targeted source review.
- **41 files** received targeted review of relevant bodies, imports, production seams, or runner wiring. **1,728 remain automated screening only**. Neither a good filename nor an imported production module establishes a good assertion.
- Parent execution produced five real PostgreSQL reports: **17/17 suites, 108/108 assertions passed**, with zero pending/failed assertions. This agent independently inspected the reports and matching qualified inventory. No live provider, VM, browser or mutation campaign was executed by this agent. Runner unit tests exercise qualification orchestration only.
- Import resolution, mock counts, source reads, test titles, and conditional-execution syntax are review signals. They are not automatic deletion criteria or proof of coverage.

## Changes justified by source review

| Change | Evidence | Coverage consequence |
| --- | --- | --- |
| Remove `tests/gateway/layout.test.ts` (9 tests, 209 lines) | Defines its own `readLayout` and `writeLayout`, imports no production implementation, and calls only those local copies. Breaking the production layout handlers cannot change these assertions. | Existing gateway E2E checks basic GET/PUT and invalid payload; `shell-bootstrap.test.ts` tests real bootstrap reads. Exact malformed/missing/roundtrip cases should target `registerHomeUtilityRoutes`, rather than retain copied algorithms. |
| Remove `tests/platform/customer-vps-real-hetzner.test.ts` (1 conditional test, 8 lines) | Only checks two environment variables exist. It makes no provider request and runs no recovery workflow. | **Real host recovery smoke remains unqualified.** Service tests with fake Hetzner are useful, but do not replace boot/restore/health/data-preservation evidence. |
| Add `scripts/ci/remaining-postgres.mjs` and focused runner tests | AST inventory finds 88 suites requiring a real PostgreSQL environment or factory. 17 had no selection in the existing funded or collaboration database lanes. | Existing valuable race tests can run in a required lane. Fresh exact file results, all assertions passed, and matching aggregate totals are required; skipped/empty/stale reports fail qualification. The parent real-database execution subsequently passed all 108 assertions in those 17 suites. |

Baseline removed-file proof: [layout tests](https://github.com/HamedMP/matrix-os/blob/be6cce1404bfd6db3392c535bca2e0def32ec577/tests/gateway/layout.test.ts), [environment-only smoke](https://github.com/HamedMP/matrix-os/blob/be6cce1404bfd6db3392c535bca2e0def32ec577/tests/platform/customer-vps-real-hetzner.test.ts).

### Additional orphan duplicate removal

Two colocated terminal files fell outside the root Vitest include and had collected counterparts already in the repository. Their four callbacks match after TypeScript AST normalization that substitutes an immutable local `const` initializer into its assertion. Token comparison preserves literal contents.

| Removed file | Source SHA-256 | Retained counterpart | Cases |
| --- | --- | --- | --- |
| `shell/src/components/terminal/__tests__/preferences-panel.test.tsx` | `3239fb29127bd62058e49ece941286b30fe4251ff496a07db12b12df87e9fc9c` | `tests/shell/preferences-panel.test.tsx` | 1 |
| `shell/src/components/terminal/__tests__/web-link-provider.test.ts` | `c533ff3adeca4c1b93bf93885e3091c2409e5caedc37484a5d8c1c1a02699a66` | `tests/shell/web-link-provider.test.ts` | 3 |

The preferences copy starts at theme `system` instead of `dark`; both assert the same explicit theme-change outcome. The retained suite also tests preference loading and legacy theme display. These four uncollected cases are removed to prevent duplication/confusion; **no CI runtime savings are claimed**.

## Priority findings

### 1. Real PostgreSQL tests existed but were not selected

The ordinary unit lane leaves `MATRIX_TEST_POSTGRES_URL` unset. The existing funded job provides it only to explicit file selections; collaboration qualification follows its own manifest and real collaboration fixture graph. The following suites were outside both selections:

- Bot concurrency and migration: `bots/custom-direct-chat-postgres`, `bots/deployed-v6-schema-postgres`, `bots/interactions-repository`, `bots/managed-custom-recovery`, `bots/memory-repository`, `bots/sessions-repository`, `bots/tasks-repository` under `tests/gateway/`.
- Inbox durable claims/checkpoints: `tests/gateway/jev-inbox-batch-postgres.test.ts`, `tests/gateway/jev-repository-postgres.test.ts`.
- Sites runtime/setup: `tests/gateway/sites-bootstrap-postgres.test.ts`, `tests/platform/sites-postgres.test.ts`, `tests/platform/sites-publish-admission-postgres.test.ts`, `tests/platform/sites-recovery-postgres.test.ts`.
- Speech billing/cancellation races: `tests/platform/speech-postgres-concurrency.test.ts`.
- Trial cleanup versus paid conversion/deletion: `tests/platform/trial-retention-postgres.test.ts`.
- Composed Slack/Pi flow's real-database variant: `tests/gateway/slack-pi-integration.test.ts`.
- Chat ordering/title's real-database variant: `tests/gateway/chat-order-title.test.ts`, which uses `CHAT_TEST_DATABASE_URL` rather than the standard variable.

Some files execute useful PGlite cases in ordinary CI while skipping or falling back from their real-server variants. This finding does **not** mean every test in those files was previously unrun.

The new lane explicitly maps the legacy Chat variable to the disposable database URL, remains disjoint from existing hosted selections, and rejects newly unassigned real-Postgres consumers. The existing funded/collaboration overlap for `company-brain-owner-data.test.ts` is preserved and reported, rather than silently changed. Static inventory follows known real factory calls/import aliases and helper wrappers; arbitrary reflective loading is outside its reach.

### 2. Production composition often has static guards instead of runtime proof

Examples:

- `tests/gateway/project-deletion-wiring.test.ts` checks string positions in server/lifecycle source. It protects a real ordering invariant, but cannot prove that startup binds the usable canonical Chat deletion callback.
- The first case of `tests/gateway/provider-settings-runtime-wiring.test.ts` checks many server source strings. The same file's subsequent store/capability/expiry tests exercise production behavior and should be retained.
- `tests/platform/platform-db-migration-lock.test.ts` checks source ordering of transaction/lock/migration calls. A literal can remain while lock behavior is ineffective.

Recommended replacement layer: boot the real composition factory with controlled external dependencies, then drive one request/action through the registered dependency. For migration serialization, use independently pooled PostgreSQL sessions with a known lock holder and observable loser/winner outcomes. Keep useful guards until their invariant is protected by an executable replacement.

### 3. Checkout/provisioning/recovery needs explicit journey qualification

`billing-routes.test.ts`, `stripe-billing.test.ts`, and `customer-vps-provisioning-durability.test.ts` provide useful real route/service/database coverage at their seams. Stripe, Hetzner, and parts of prebilling are injected. These tests do not alone prove that an authenticated user completes hosted Checkout, webhook authorization, exact-machine provisioning, shell readiness, reconnect, or recovery.

A required journey should cover one owner and exact runtime identity through:

1. Checkout selection and server-owned price/region.
2. Verified payment webhook, duplicate/out-of-order delivery, and immutable checkout identity.
3. Durable job accepted, process restart/retry, and exactly one VM/provider creation.
4. Registration, health, authorization, and usable shell.
5. Recovery keeps old data/server until replacement is proven healthy; failed cleanup retries safely.

Use sandbox external providers and a disposable test VM for scheduled/release qualification. Keep deterministic adapter and service tests in faster lanes. Do not use live paid production resources as test fixtures.

### 4. Terminal security tests cannot qualify browser paste

`terminal-ws-routes.test.ts` mounts the real route with injected workspace and WebSocket transport. It meaningfully checks authorization order, retired route behavior, and capability projection. `terminal-acceptance-auth.test.ts` meaningfully rejects stale, forged, replayed, and concurrent duplicated signed commands.

Retain these tests. Browser clipboard -> focused xterm -> `/ws/terminal/tab` -> real workspace tab -> command execution requires a separate user journey. Its oracle must include executed-command output and correct tab identity, rather than only a captured mock frame.

### 5. Valuable source-reading tests must not be deleted wholesale

The initial import/mocking screen suggested three removal candidates that source review disproved:

- `coding-agents-delivered-steering.test.ts` reaches real thread services through a shared harness and asserts admission/history/target fencing.
- `slack-preview-runtime.test.ts` calls the production operator script and tests the ownership gate with controlled DB results.
- `targeted-fleet-maintenance.test.ts` calls production selection/retry/pagination/budget functions.

Other source-reading tests execute the actual extracted shell/teardown code. `background-agent-runner.test.ts` spawns the real runner and checks bounded output/stdin/shutdown; `app-ai-shutdown.test.ts` runs the production teardown body and real worker fencing failure. These are materially different from copying an algorithm into the test.

Deployment configuration is also an artifact worth testing. Worker custom-domain restrictions, environment propagation, origin delimiter handling, and append-only owner group changes can merit focused static contracts. They must be labeled as configuration coverage, not a claim that a live runtime is qualified.

## Business journey checklist

This is a required coverage map, not a claim that all rows are currently automated or passing.

| Journey | Existing lower-level evidence | Required end state and failure/recovery checks |
| --- | --- | --- |
| Signup/payment/provision | Billing route/DB, Stripe adapter, prebilling and customer-VPS service tests | Real login/Checkout/webhook -> exact authorized runtime -> usable shell; duplicate payment, expired checkout, restart and failed provisioning. |
| Funded AI/speech | Independent-pool funded admission/settlement and speech operation suites | One affordable execution; exactly-once settlement; cancellation, unknown upstream result, retry, late receipt, no double grant/debit. |
| Own-account provider setup | CLI lifecycle/login/store tests | Visible login -> exact account/model selected -> real run -> resume/cancel/logout; expired/ended terminals and conflicting retry retain truthful UI/state. |
| Chat/bots/tasks | Repository, queue, grant, memory and migration tests | Start -> streamed result/tool -> interruption/question -> resume/restart with durable order; ownership, concurrent edits, archive and old-schema upgrades. |
| Terminal | Route/auth/workspace/input tests | Create/paste/execute/tab switch/reconnect on each applicable surface; correct tab, Unicode/multiline and no duplicate/lost input. |
| Files/documents/apps | File, application DB, app runtime and bridge tests in census | Create/save/reopen/export/delete with actual owner state; conflict, permission denial, sandbox CSP/bridge and failure preserve user edits. |
| Integrations/messaging | Grant receipts, integration repositories, composed Slack/Pi and collaboration suites | Connect -> consent -> tool action -> durable external result -> revoke; replay/owner mismatch/cancel must not spend another action's grant. |
| Sharing/organizations | Collaboration PostgreSQL manifest with strict result accounting | Two owners/homes, membership revocation while action is admitted, role changes, shared terminal/Chat; personal data never appears in shared results. |
| Publish site/form | Sites service and real-PG suites | Deploy -> public read/submit -> durable owner result -> unpublish/recover; admitted request versus revoke/deletion serialized. |
| Account deletion/trial retention | Independent-pool deletion/recovery and retention tests | Delete/cleanup pauses behind admitted write, blocks later writes, handles late paid conversion, retries external cleanup without losing other owners. |
| Release/update/restore | Bundle/workflow/host-script contracts, service recovery tests | Install exact artifact -> healthy services -> retained owner data -> rollback/reconnect; distinguish subscription from artifact provenance. |

## Instructions to preserve test value

- State the protected outcome/invariant and a realistic fault that would make the assertion fail.
- Invoke production behavior. Never implement the tested algorithm only inside its own test.
- Choose the narrowest layer that detects that fault; add a complete journey for high-risk cross-component or platform interactions.
- Keep controlled external seams deterministic; do not mock the first-party component whose integration is the subject of the test.
- For concurrency, use independent PostgreSQL sessions and bounded synchronization with an observable admission/lock condition. PGlite or one connection cannot establish multi-session serialization.
- Record fixture bypasses, surface, required environment and exact CI lane. A required test missing prerequisites must fail qualification, rather than produce a green skipped suite.
- Replay known fixed regressions against the faulty behavior. Use scoped fault injection/mutation for critical logic; no aggregate score alone justifies removal.
- For every removal, record the assertion's lack of production influence or the specific retained replacement covering the same fault. Do not estimate CI savings from removed line count.

## Additional Swift and Python census correction

A second naming pass found **34 additional files: 18 Swift XCTest files and 16 `*.test.py` files**, totaling 8,094 baseline lines. All 34 files were read in full, including fixture adapters/setup/teardown and assertions; per-file reviewed-source hashes, findings, production references and runner ownership are recorded in the audit evidence ledger. These are source reviews, not runtime or mutation qualification.

- Swift has six test targets in `macos/Package.swift` and a dedicated `macos-086.yml` workflow (`swift test -v`). This is the separate Swift native macOS target. It must not be treated as Electron Desktop or Native Mobile qualification; current release/support status was not independently established.
- Twelve funded-host Python suites are explicitly selected by the network-disabled disposable-root runner, which rejects skipped execution. Portable TS wrappers also cover archive/epoch/sync initialization and runner accounting. Browser runtime/bootstrap Python tests are called by a collected Vitest wrapper. The browser diagnostic spike's two Python tests have no CI owner found.
- The host suites execute actual shipped/generated/installed programs over real temporary or protected disposable filesystem paths. External network/systemctl/health behavior is controlled. These fixtures protect valuable archive, file permission, journal, lock, interruption and rollback behavior and should be retained; they do not establish live VM/browser/service readiness.
- Removed only Swift `BoardStoreTests.testReloadAfterFailureCanSucceed`: it never injects failure, and its successful load/state/card-count assertions are subsumed by retained `testLoadSuccessPopulatesCardsAndState`, which additionally checks the requested slug. Original file SHA-256: `8ae02139575f40638536836e854aac2e8d257cf827d714ff6107e014e6ff6e20`. A genuine failed-load -> successful retry remains a coverage gap. Swift execution and CI savings were not measured.
- Strengthen native HTTP POST/PUT tests to inspect actual encoded payload bytes; strengthen approved-auth-callback tests to show an in-flight polling state is preserved (approved callbacks are intentionally no-ops). The first/fourth hosted-auth prompt tests repeat the same steps; other auth/retry contexts differ and were preserved.
- Add bounded failure deadlines to native `ShellWSClient` test transport/clock waiters and stream drains. Current helpers can wait indefinitely on a broken state transition until the workflow's 30-minute job timeout.
- The 1,023-line generated-program Python test has strong real-code/fault oracles but too many stateful scenarios in one case. Extract reusable fixture machinery and independently named scenarios so one failure does not suppress later checks. Preserve real emitted-source execution and fixed historical regression fixtures.
