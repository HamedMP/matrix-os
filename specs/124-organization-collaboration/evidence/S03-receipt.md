# S03 receipt — Clerk membership projection and control authority (T015–T019)

**Packet:** S03. **Tasks:** T015, T016, T017, T018, T019. **Date:** 2026-09-20.
**Base:** `124/s02` @ `762c76bb2` (S02 contracts on the S20 → S01 stack). **Branch:** `124/s03`.
**Commits:** `1a0a1916a` (RED tests), `1f1bd7245` (T016 projection), `5a5ef7ad7` (T017 control authority), `265d89b22` (T018 routes, Clerk upstream, gateway client), `2ebc6f1ab` (T019 composition, gateway default source, live probe), plus this receipt.

## What landed

| Area | Files | Behaviour |
| --- | --- | --- |
| Projection tables | `packages/platform/src/organizations/database.ts` | `organizations`, `organization_memberships` (tombstones), `organization_webhook_inbox`, `collaboration_denials`, `collaboration_denial_runtimes`. Bootstrapped by `bootstrapPlatformOrganizationDatabase` beside the collaboration platform tables (not a `PLATFORM_MIGRATION_STEPS` entry: the S01 characterization fixture pins that table set). |
| Vocabulary | `organizations/roles.ts` | Clerk default roles stored verbatim and bounded (no application authority), `collaboration.aiSubmission` projected from organization public metadata (anything but `"members"` is owner-only), Zod parsing of `organization.*` and `organizationMembership.*` webhook payloads, unknown types ignored. |
| Webhook ingress | `organizations/webhook-signature.ts`, `organizations/commands.ts`, `organizations/routes.ts` | Standard Webhooks HMAC verification on the raw bounded body (256 KiB `bodyLimit`, timing-safe, ±300 s), inbox dedupe keyed by `svix-id` with payload-hash conflict detection, one transaction per event, Clerk source timestamps decide staleness. 200 applied/duplicate/stale/ignored, 400 bad signature or schema, 409 same-id different payload, 503 storage failure. |
| Repository | `organizations/repository.ts` | Organization row locked `FOR UPDATE`; membership epoch is monotonic and unique per applied change; reordered older events are `stale`; remove/rejoin keeps the tombstone history and a new membership identity; reconciliation tombstones unlisted members and records `verified_at`. |
| Projection | `organizations/projection.ts`, `organizations/clerk-resolver.ts` | Positive evidence requires an active membership **and** an upstream verification younger than 60 s; a webhook alone never creates positive authority. Evidence expires 20 s after the upstream request start (skew-clamped), never from receipt. Reconciliations are coalesced per organization, recurring every 10 s for organizations active in the last 5 min (bounded 1,000, LRU). Upstream failure lets verification age out (fail closed). No `CLERK_SECRET_KEY` ⇒ nothing is ever verified. |
| Control authority | `packages/platform/src/collaboration/control-authority.ts` | Denial fences with generation = membership epoch and a 25 s lease; pending until every affected runtime acknowledges a fence at/after it, or completed at lease expiry by the recurring sweep; per-runtime delivery outbox with exponential backoff and dead-letter after 8 attempts once S05 registers the control transport; batched membership assertions (≤100, deduplicated, one request start). |
| Routes | `organizations/routes.ts`, `organizations/wiring.ts` | `GET /api/organizations`, `GET /api/organizations/:orgId/members` (U+O, fresh members only, limit ≤100, opaque cursor, hidden existence 404), `POST /webhooks/clerk/organizations`, `POST /internal/organizations/access/resolve` (R, protocol 2, ≤100 actors), `POST /internal/collaboration/control/ack` (R, logical runtime must match). Composition registers routes and drains timers with the collaboration runtime. |
| Seams | `collaboration/runtime-identity.ts`, `collaboration/bootstrap.ts`, `collaboration/wiring.ts` (platform); `collaboration/organization-membership-client.ts`, `collaboration/wiring.ts` (gateway) | `logicalRuntimeIdFor("vps:<uuid>") = "vps-<uuid>"` because the frozen contracts forbid `:`/`.` in logical runtime ids (S05 reuses it). Bootstrap registers the projection as the identifier resolver's `membershipProjection`. Gateway wiring defaults the S20 `organizationMembershipSource` to `OrganizationMembershipClient` (5 s control timeout, 64 KiB bound, cache only until the platform's expiry, coalesced, capped at 1,000). |

## RED → GREEN

| Suite | RED (commit `1a0a1916a`) | GREEN (head) |
| --- | --- | --- |
| `tests/platform/organization-authority-postgres.test.ts` (real Postgres, `MATRIX_TEST_POSTGRES_URL` → `matrixos_test_124`) | module resolution failure | 6/6: duplicate + forged replay, reordered event, remove/rejoin epochs, 12 concurrent webhooks with unique monotonic epochs, outage denies then restores, denial completes only on full ack or lease expiry under concurrent acks |
| `tests/platform/organization-projection.test.ts` | module resolution failure | 6/6 |
| `tests/platform/collaboration-control-authority.test.ts` | module resolution failure | 5/5 |
| `tests/platform/organization-routes.test.ts` | module resolution failure | 5/5 |
| `tests/platform/organization-webhook-signature.test.ts` | module resolution failure | 3/3 |
| `tests/gateway/organization-membership-client.test.ts` | module resolution failure | 4/4 |
| Regression: `collaboration-bootstrap`, `collaboration-wiring` (platform + gateway), `collaboration-org-precondition` (platform + gateway), `collaboration-identifier-resolver`, `collaboration-internal-routes`, `collaboration-foundation` (platform + gateway) | — | all pass (the bootstrap characterization forced the organizations composition into `wiring.ts`; `bootstrap.ts` still makes no lifecycle calls) |
| `tests/integration/collaboration-authority-boundaries.integration.ts` | — | 2 pass, 5 explicitly unrun (new: "S03 projection observes a live removal within the 60s bound", gated on `COLLABORATION_PROBE_CLERK_SECRET_KEY/ORG_ID/MEMBER_USER_ID`) |

`tsc --noEmit`: contracts, gateway and platform clean. `bun run check:patterns`: 0 violations (5 pre-existing warnings). `git diff --check` clean. Full `bun run test` was not run on this host by coordinator instruction (load); CI covers it after retarget to `main`.

## Invariants

- **Source of truth:** Clerk. The projection is a cache whose positive answers are valid only with a ≤60 s upstream verification and expire 20 s after the upstream request start.
- **Lock/transaction scope:** inbox row + organization upsert + membership change in one transaction under `SELECT … FOR UPDATE` on the organization; Clerk API calls happen outside every transaction; denial creation and acknowledgement are single transactions.
- **Acceptable orphan states:** an inbox row with `outcome = failed`; a denial whose transport delivery dead-letters (the lease still completes it); a pending denial for a runtime that never acks (completed at `ackDeadline`).
- **Auth source of truth:** verified Clerk session/sync JWT for `U`; the existing customer-VPS verification token for `R`; the webhook signing secret for the public ingress. The selected organization is never authority; every answer is keyed by explicit organization + actor.
- **Deferred scope:** custom Clerk permissions, groups, guests, invitation quotes and the administration routes (contract rows retained, not served); the control WebSocket transport (S05 registers it through `registerTransport`); the live 60 s removal measurement (unrun until the Clerk fixture exists); organization-wide denial fan-out to runtimes (only actor-scoped denials resolve affected runtimes; organization-level denials rely on evidence expiry).

## Open gates

- `CLERK_ORGANIZATION_WEBHOOK_SIGNING_SECRET` (Clerk dashboard endpoint secret, `whsec_…`) and `CLERK_SECRET_KEY` must be configured on the platform; without them the webhook returns 503 and no organization is ever verified.
- Live Clerk fixture for the removal bound and webhook ordering probes (owner approval pending).
- S05 must call `controlAuthority.registerTransport` for pushed denials and adopt `logicalRuntimeIdFor` in runtime registration.
