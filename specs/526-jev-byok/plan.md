# Implementation plan: Jev email triage

Updated: 2026-09-22. [Product spec](spec.md), [design](design.zh-en.md), [tasks](tasks.md).

## Technical context

- Runtime: Node.js 24+, strict TypeScript, ES modules, Zod 4.
- HTTP: Hono for the local Gateway and funded relay.
- Existing infrastructure: owner-scoped funded AI credentials, admission/credit settlement, Matrix integrations MCP, Gmail integration actions and bundled skill sync.
- External API: Cloudflare AI REST `POST /ai/run` with fixed `typesafe/jev` model and the existing central Workers AI credential.
- Testing: Vitest contract, unit, route and controlled-upstream integration tests; tests precede implementation.
- Persistence: reuse the existing Postgres/Kysely funded accounting and idempotency mechanisms. Do not add an embedded database or new ORM.

## Constitution check

- **Owner data**: email content stays in the owner's Gmail/Matrix runtime path; only bounded transient evidence is sent for evaluation. Normal logs and accounting do not persist bodies.
- **AI kernel**: Jev is a typed decision tool available to agents, while final action policy remains with Matrix.
- **Headless core**: Gateway/tool/skill work without a new UI and remain usable by every verified agent shell.
- **Defense in depth**: exact auth matrix, strict schemas, body limits, fixed upstream, timeout, redirect rejection, safe errors, idempotency and integration wiring tests are specified.
- **TDD**: each production slice begins with failing tests.
- **Worktree/PR**: implementation uses a new manual worktree and stacked PR based on the spec PR.
- **Public docs**: a separate Matrix site PR is a release deliverable.

## Phase 1 — Contracts and deterministic policy

Add shared Zod schemas for recipe request/result and the seven answer IDs. Add a pure `email-triage-v1` recipe definition and policy evaluator with the documented verification, label, Review and archive thresholds.

Tests cover request bounds, missing/duplicate/unknown answers, non-finite/out-of-range probability, all labels, overlapping labels, protected-category conflicts, recency, Review paths and the exact archive gate. This phase has no network or mailbox mutation.

Likely paths:

- `packages/contracts/src/jev.ts`
- `packages/contracts/src/index.ts`
- `packages/gateway/src/jev/email-triage-recipe.ts`
- `packages/gateway/src/jev/email-triage-policy.ts`
- `tests/contracts/jev.test.ts`
- `tests/gateway/jev-email-triage-policy.test.ts`

## Phase 2 — Funded relay evaluation adapter

Extend the funded relay with one strict `/v1/evaluate` route. Reuse bearer lease verification, owner policy, rate/concurrency admission, credit reservation, settlement and shutdown behavior. Accept only the fixed Jev model and bounded evaluation schema, call Cloudflare's fixed `/ai/run` origin with the account and gateway derived from validated operator configuration, an abort deadline and `redirect: "error"`, suppress payload logging, bound the response, validate all seven answers and normalize usage/cost metadata.

Gateway composition stays limited to repository bootstrap, service construction and `createJevRoutes` registration in `server.ts`. Before adding a second Jev workflow or another funded provider there, extract those bootstrap calls into `packages/gateway/src/jev/register.ts` with explicit database, credential and configuration dependencies; keep request validation, policy and retry semantics in the dedicated Jev modules. This avoids growing the gateway composition entrypoint with workflow behavior.

No database transaction spans the external call. Actual settlement uses Cloudflare-returned input-token usage and a reviewed Jev price snapshot selected before dispatch; calls stop when that price expires. When dispatch occurred but usage is unknown, the Platform retains the in-flight hold and owner admission barrier without charging or futile conservative-finalization retries. An operator reviews the upstream evidence after the hold expires and a ten-minute retry grace period passes, then uses `scripts/reconcile-jev-usage.ts` with an evidence reference, reviewer ID and verified microusd cost. An exact cost of zero releases the hold without a charge. The resulting settlement, evidence reference, reviewer and review time are written atomically. No blind retry occurs after an ambiguous timeout.

Likely paths:

- `packages/proxy/src/funded-relay-evaluation-request.ts`
- `packages/proxy/src/funded-relay-evaluation-response.ts`
- `packages/proxy/src/funded-relay-config.ts`
- `packages/proxy/src/funded-relay.ts`
- `tests/proxy/funded-relay-evaluation.test.ts`
- existing funded relay regression suites

## Phase 3 — Local Gateway route and service

Add `POST /api/jev/evaluate` behind the existing local Gateway bearer authentication and `bodyLimit`. Its schema accepts only recipe ID, state and idempotency key. Resolve the immutable recipe server-side, acquire the authenticated owner's funded credential, call the relay with a deadline, validate the normalized result and return safe typed errors.

Idempotency is owner scoped. Completed duplicates do not re-dispatch. Requests with unknown upstream outcomes remain reconcilable and are not automatically repeated. Dependency resolution happens at route/service registration.

Retention must preserve that promise across restarts and across the seven-day result-data window. The Gateway Postgres primary key on `(owner_id, idempotency_key)` and payload hash remain the replay authority. After seven days, prune only a completed result's JSON and retain a `completed_pruned` tombstone. A matching retry gets an explicit `result_expired` response without acquiring a credential or dispatching; a different payload still conflicts. Unknown outcomes retain their tombstone. Claim and pruning run in one database transaction; no transaction spans the relay call. An additive, idempotent migration expands the existing table status constraint without dropping rows. Historical keys already deleted by the old cleanup cannot be reconstructed. Before rollback to a binary with the old delete behavior, disable the Jev route and drain traffic; that binary would remove retained unknown rows and does not understand `completed_pruned`.

The retained owner/key/hash/status/timestamps are owner data. The current workspace export and deletion path in `packages/gateway/src/state-ops.ts` handles workspace files, not this Postgres table. Integrating this table with the owner database export/deletion lifecycle remains a separate tracked task; this change does not invent a new API or claim that owner deletion is already wired. Tombstones cannot be age-evicted without reintroducing paid replay, so monitor their growth and define an owner-controlled deletion lifecycle before enabling sustained use.

For this retention fix, validation requires the red-to-green repository, service, route and full-path Jev suites, TypeScript typecheck, pattern checks, and exact-head PR review/CI. PGlite tests prove persisted semantics in the fixture database; concurrent transactions across independent PostgreSQL connections require a real-Postgres check when that environment is available. There is no new frontend surface, dependency or lockfile change. The public docs-site PR remains the Phase 5 deliverable for Jev product behavior; this internal replay fix changes only the safe expired-result API response. Cloudflare wire shape, effective account pricing, and live funded acceptance remain separate gates.

Likely paths:

- `packages/gateway/src/jev/service.ts`
- `packages/gateway/src/jev/routes.ts`
- the focused Gateway composition file that mounts authenticated routes
- `tests/gateway/jev-routes.test.ts`
- `tests/gateway/jev-service.test.ts`

## Phase 4 — MCP tool and bundled skill

Expose `jev_evaluate` through the existing `matrix-integrations` MCP. The tool delegates to the local Gateway using the same runtime authentication as existing integration calls. It does not accept credentials, owner IDs, model IDs or arbitrary questions.

Bundle `matrix-jev-email-triage` through the existing skill source/sync path. The skill uses existing Gmail list/get/history/label actions, builds bounded snippet/full states, computes fingerprints, calls Jev, previews unauthorized mutations and applies only authorized labels/`INBOX` removal.

Likely paths:

- `packages/kernel/src/tools/integrations.ts`
- `packages/integrations-mcp/src/server.ts`
- `skills/matrix/jev-email-triage/SKILL.md`
- skill sync/build tests and generated outputs, if any
- `tests/integrations/mcp-server.test.ts`
- `tests/deploy/customer-vps/integrations-mcp-registration.test.ts`
- `tests/gateway/jev-email-triage-workflow.test.ts`

## Phase 5 — Acceptance and documentation

Run the focused suites, typecheck, pattern scanner and relevant full test suites. Verify one exact-head owner-scoped evaluation, credit settlement, zero-credit denial, personal-primary-model independence, supported-agent discovery/invocation and a controlled Gmail fixture/demo. Inspect logs for raw body/credential leakage.

Create a separate PR in `FinnaAI/matrix-os-site` that documents Matrix-funded Jev access, unchanged primary-model selection, Gmail permissions, label/Review/archive behavior and recovery when credit, auth or Jev is unavailable.

Availability remains disabled until runtime evidence and required CI/review gates pass. Production deployment is separately authorized.

## Stacked PR plan

| Stack | Scope | Base | Independent acceptance |
|---|---|---|---|
| A | Spec/design/tasks | `origin/main` | Spec checklist and prerequisite validation |
| B | Contracts, policy, relay adapter and local route | A | Controlled upstream call settles once and returns seven valid probabilities |
| C | MCP tool, skill and Gmail orchestration | B | Supported agent completes fixture-backed triage with safe mutations |
| D | Public docs in site repository | Released product behavior | Docs build and reviewed screenshots/copy |

Each code PR stays reviewable and demoable. Stack B must not wait for Gmail mutation; Stack C must not duplicate the relay client or recipe contract.

## Risks and controls

- **Double charge after timeout**: stable idempotency, no blind retry, existing reservation reconciliation.
- **Unsafe archive**: full-context-only archive, strict conflict thresholds, pure policy tests and only `INBOX` removal.
- **Prompt injection in email**: email is serialized as evidence under fixed server recipe; it cannot supply instructions or tool arguments.
- **Credential leakage**: service keys remain in relay config; client schemas exclude them and safe errors/log tests assert absence.
- **Unbounded inbox work**: bounded batches, state sizes, message count, rate/concurrency and incremental fingerprints.
- **Advertised but unwired capability**: registration-time dependency checks and a full-path integration test.
