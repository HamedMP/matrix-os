# S01 receipt — extract large composition seams (T006–T009)

**Packet:** S01. **Tasks:** T006, T007, T008, T009. **Date:** 2026-09-20.
**Base:** `124/s00` tip `3571cdb17` (on `main` `326108a39`; prerequisite PRs #1761 and #1765 baseline verified at `3b4662d28`).
**Result:** behavior-preserving extraction; no new ACL behavior, no new migration, no changed transaction scope or lock order. Three stacked Graphite layers, each under the 3,000-addition / 50-file limit.

## Layers

| Layer | Branch / head | Tasks | Diff vs parent | Contents |
| --- | --- | --- | --- | --- |
| 1 | `124/s01` `6c2f3e204` | T006, T007 | 22 files, +2,932 / −2,558 | Platform schema registration (`database/migrate.ts` + 11 ordered `database/migrations/*.ts`), user machine records/queries/lifecycle, host bundle queries, `tests/platform/collaboration-foundation.test.ts`, schema baseline fixture |
| 2 | `124/s01-billing` `31e9ceabe` | T006, T007 | 11 files, +2,130 / −1,805 | Billing records/subscription/entitlement queries and checkout attempt claims out of `db.ts`; Stripe client contracts, checkout schemas/support and webhook projection out of `billing-routes.ts` |
| 3 | `124/s01-gateway` `eef098241` | T006, T008, T009 | 14 files, +2,837 / −2,173 | Gateway collaboration routes split into per-resource modules + `route-support.ts`; repository facade + `grant-repository.ts` + `lifecycle-repository.ts` + `repository-types.ts`; `database-migrations.ts` versioned registry; `tests/gateway/collaboration-foundation.test.ts`; this receipt |

## RED → GREEN

| Test | RED (before extraction) | GREEN (after) |
| --- | --- | --- |
| `tests/platform/collaboration-foundation.test.ts` (schema/user-machine block) | `Cannot find module '../../packages/platform/src/database/migrate.js'` | 6/6 pass; baseline tables (48) and indexes (138) identical to the unextracted `migrateSchema` on `3b4662d28`; re-run idempotent; re-exports identical by reference |
| `tests/platform/collaboration-foundation.test.ts` (personal billing block) | `Cannot find module '../../packages/platform/src/database/billing.js'` | 2/2 pass; off-allowlist return path still collapses to `/` (guard preserved) |
| `tests/gateway/collaboration-foundation.test.ts` | `Cannot find module '../../packages/gateway/src/collaboration/database-migrations.js'` | 7/7 pass; 33 handler routes in baseline order from both `createCollaborationRoutes` and the per-resource registrars; prefix middleware `ALL/POST/PATCH/DELETE`; facade delegates to grant/lifecycle repositories; versions 1–6 recorded idempotently; shared queue FIFO, one active run, actor-scoped replay |

Regression suites run against the extracted code (`pnpm exec vitest run … --maxWorkers=4`, PGlite fixtures):

- Platform layer 1: `db`, `platform-db-migration-lock`, `platform-db-migration-workflow`, `platform-migration-retry`, all `customer-vps-*`, `host-bundle-*`, `golden-snapshot-*`, `prebilling-*`, `onboarding-*`: 40 files, all pass after the source-inspection test `golden-snapshot-repository.test.ts` was pointed at `database/host-bundles.ts` (it reads `promoteHostBundleChannel` source text). A first run with 14 default workers showed 60 s hook timeouts and an unbuilt `@matrix-os/observability`; both cleared by building prerequisites and using 4 workers.
- Platform layer 2: `billing-db`, `billing-entitlements`, `billing-portal-access`, `billing-routes`, `billing-runtime-actions`, `billing-settling`, `funded-ai-addon-checkout`, `prebilling-provisioning`, `proxy-routing-billing`, `signup-billing-handoff-*`, `stripe-billing` + foundation: 13 files, 218 tests pass.
- Gateway layer 3: every `tests/gateway/collaboration-*.test.ts`, `chat-shared-owner-reads`, every `tests/platform/collaboration-*.test.ts`: 58 files, 385 tests; 4 load-induced hook timeouts (`collaboration-proxy`, `collaboration-chat-controls`, `collaboration-project-transition`, `collaboration-routes`) pass on re-run with 2 workers (82 pass, 2 skipped).
- `bun run typecheck`: exit 0 on the full stack. `bun run check:patterns`: 0 violations; 5 pre-existing warnings, none in extracted files.
- `bun run test` (full unit suite): see the PR body of layer 3 for the recorded result.

Not run: no live Postgres races were needed (no lock or transaction moved); no React files changed, so `react-doctor` was not required.

## File ownership after S01 (for later packets)

| Path | Owner packet |
| --- | --- |
| `packages/platform/src/database/migrate.ts`, `database/migration-types.ts`, `database/migrations/*.ts` | Coordinator (platform schema registration); S03 adds `organizations/database.ts` as its own step, S05 adds runtime endpoints, S20 drops nothing here (rollout policy lives in `platform/src/collaboration/database.ts`) |
| `packages/platform/src/database/user-machine*.ts`, `database/host-bundles.ts` | Customer-VPS enrollment seam reused by S05 T026 (relay-routable home registration); read-only for other packets |
| `packages/platform/src/database/billing*.ts`, `database/checkout-attempts.ts`, `packages/platform/src/billing/*.ts` | Personal billing; S14 (deferred) would extend `billing/`; untouched by V1 packets |
| `packages/platform/src/db.ts` | Composition and export entrypoint only (types, `createPlatformDb`, containers/users/onboarding queries); coordinator owns edits |
| `packages/gateway/src/collaboration/routes.ts` | Coordinator (exact route registration) |
| `packages/gateway/src/collaboration/route-support.ts` | S04 (authorization evaluator inputs), S05 (direct-session auth replaces proof decoding) |
| `packages/gateway/src/collaboration/scope-routes.ts` | S04 (preset grants), S20 T101 (org-only invitation audience) |
| `packages/gateway/src/collaboration/chat-routes.ts`, `terminal-routes.ts` | S09 (cancel/approval actor rule), S12 T061 (standalone Chat/terminal scope routes) |
| `packages/gateway/src/collaboration/project-routes.ts`, `lifecycle-routes.ts` | S10 (share inventory, Git broker), S12 |
| `packages/gateway/src/collaboration/grant-repository.ts`, `repository-types.ts` | S04 (capability repository, per-member activation), S20 T101 (deriving organization on grants) |
| `packages/gateway/src/collaboration/lifecycle-repository.ts` | S12 |
| `packages/gateway/src/collaboration/database.ts`, `database-migrations.ts` | S04 adds versioned migrations ≥ 7 through the registry; S20 T100 removes cohort inputs elsewhere |

## Gates

- No open gates for S01. Registration/export changes needed by the coordinator: none beyond what is in the layers (every existing import path still resolves).
