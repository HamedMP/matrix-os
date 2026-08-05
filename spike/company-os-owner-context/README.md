# Company OS owner-context spike

Status: isolated, throwaway architecture spike; not production code.

Worktree baseline: `origin/main` at
`70356175a8ad690609a77a6b435b257fd4290fdd` on 2026-08-03. Final current-main
delta audited through `d4e52381e674918839309510585714abb1fec612`;
it does not change these seams.

## Purpose

This spike tests the three seams that must be sound before Company OS can expose
organization data: a platform-issued actor/owner context, generic runtime
ownership with idempotent provisioning records, and a reusable resource
permission evaluator with revocation. It deliberately does not modify platform,
gateway, Clerk, production migrations, routes, or deployment configuration.

## Files

- `context-token.ts`: experimental JWT mint/verify contract with runtime binding
  and authoritative organization-membership/version rechecks.
- `runtime-model.ts`: PGlite/Postgres-compatible test schema and atomic generic
  runtime upsert.
- `resource-authorization.ts`: owner-aware, default-deny grant inheritance and a
  realtime authorization lease.
- `model.ts`: test-only exports.
- `../../tests/spike/company-os-owner-context.test.ts`: executable negative,
  concurrency, isolation, and revocation cases.

## TDD evidence

Red command:

```text
pnpm exec vitest run tests/spike/company-os-owner-context.test.ts --reporter=verbose
```

Initial result: failed before test collection because the intentionally absent
`spike/company-os-owner-context/model.js` could not be imported.

Green command:

```text
pnpm exec vitest run tests/spike/company-os-owner-context.test.ts --reporter=verbose
```

Final result on 2026-08-03: 1 file passed; 23 tests passed; 12.33 seconds. A first
green attempt exposed a test-harness cleanup mismatch (`pglite.close` is not a
function); after using the repository's normal `db.destroy()` cleanup, the suite
passed. The authorization and concurrency assertions had already passed in that
attempt.

## Findings

Confirmed:

- One canonical `OwnerRef` discriminated union can cross token, runtime, and
  resource seams without conflating member and owner.
- A context token can bind actor, immutable owner, runtime, slot, membership,
  role, membership version, and policy version while returning one generic
  failure for all invalid cases.
- Token claims are evidence, not the authorization database: org requests can
  recheck an active membership row and exact versions on every security-sensitive
  operation.
- A Postgres partial unique index plus one `INSERT ... ON CONFLICT ... DO UPDATE`
  converges 24 concurrent org-primary creates to one active runtime.
- The same atomic upsert converges retries after a simulated failed provision and
  advances the provisioning generation exactly once.
- Preview runtimes can be constrained to user owners, so preview collaborators
  cannot become the org access mechanism.
- Nearest-ancestor grants, deny precedence at equal depth, default deny, and a
  separate org-admin `administer` capability produce deterministic decisions.
- One evaluator can authorize file, app-data, AI-retrieval, and realtime surfaces.
- A membership/policy-version change can close a realtime lease on its next
  authorization check.

Rejected or constrained:

- A valid JWT alone is insufficient for org access; a stale membership token is
  unsafe without a current membership/policy recheck or an equivalent revocation
  service.
- Org admins must not be treated as owners of member-private resources.
- Current preview sharing must not be generalized into Company OS membership.
- Folder names/frontmatter cannot safely carry authorization.
- Long-lived presigned objects or offline replicas cannot meet immediate revoke
  semantics; they require short expiry, online mediation, and explicit cache
  policy.

## Performance observations

- HS256 token checks and pure permission decisions were each a few milliseconds
  or less in the local test process.
- PGlite database startup dominated the suite (about 1.7-2.3 seconds per DB test).
- The 24-way create race converged in about 1.9 seconds including fresh PGlite
  startup. This is correctness evidence, not a production latency benchmark.

## Deliberately throwaway

- IDs and token signing use test-only formats and an in-source test secret.
- The runtime tables are created only inside ephemeral PGlite databases.
- The permission evaluator uses injected arrays/callbacks instead of production
  repositories, audit, cache invalidation, or websocket infrastructure.
- Personal-resource sharing is intentionally absent; a Company OS evaluator
  always rejects user-owned resources unless a future verified shared-resource
  capability is introduced.

## Production work still required

- Add platform owner/membership/runtime schemas and compatibility views through a
  reviewed migration.
- Mirror Clerk organization and membership events idempotently, reconcile from
  Clerk Backend API, and maintain monotonic membership/policy versions.
- Replace the current user-only sync JWT with a short-lived context token and
  runtime-bound gateway principal; preserve personal-token compatibility during
  migration.
- Build one central authorization package/repository and require it from HTTP,
  websocket, bridge, file, room, job, and AI adapters.
- Implement transactional audit, revocation fanout, bounded caches, shutdown
  drains, and non-enumerating route errors.
- Migrate R2/manifest keys to immutable generic owner namespaces and prove
  backup/export/restore isolation.
- Bind iframe app sessions to app slug, owner, resource capabilities, and schema;
  the current bridge can accept another app name in forwarded bridge requests.

## Verdict and next slice

The architecture remains viable. The next implementation slice should be the
owner-context contract and platform generic runtime registry behind a disabled
feature flag, with compatibility reads for personal `user_machines`. It should
not include Company Vault UI, Oracle, Clerk configuration changes, or live
provisioning until the token, membership mirror, migration, and route matrix are
reviewed.
