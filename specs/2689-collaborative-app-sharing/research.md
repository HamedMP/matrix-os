# Phase 0 Research: Collaborative App Sharing

This research resolves the implementation choices behind [spec.md](spec.md), [journeys.md](journeys.md), and [readiness-contract.md](readiness-contract.md). No product clarification remains open.

## 1. Reuse the collaboration control plane

**Decision**: Reuse `collaboration_scopes`, owner-runtime direct sessions, the platform directory, resource catalog, event registry, operation receipts, audit records, and the owner Postgres app bridge. Add app-specific readiness and exact-build bindings instead of a second sharing subsystem.

**Rationale**: Existing collaboration already provides owner-hosted routing, fresh organization membership, stable identities, transactional receipts, bounded signals, and revocation fences. A parallel stack would duplicate security-critical behavior.

**Alternatives considered**: Project sharing contradicts the direct-app boundary; platform-hosted app data contradicts creator hosting; recipient copies diverge from the one live record set.

## 2. Separate registration and exact-build identity

**Decision**: Keep the current registration incarnation for delete/recreate safety and add a build ID over the incarnation, canonical manifest, declared schema, immutable asset digest, bridge contract, and runtime ABI.

**Rationale**: Current `appRegistryIncarnation()` distinguishes a replacement but does not change for every in-place rebuild. Readiness and sharing must bind to the bytes and contract that passed.

**Alternatives considered**: Slug and semantic version are mutable; process generation would incorrectly invalidate ordinary compatible restarts.

## 3. Use an immutable build and authenticated launch facade

**Decision**: Capture an immutable owner-hosted build snapshot under the existing build lock. Serve it through a same-origin authenticated facade that rechecks the platform session, active share, membership, exact build, and owner availability on every HTML/asset request.

**Rationale**: Iframe subresources cannot attach owner direct-session proof headers. A same-origin facade preserves normal code-split apps without exposing owner cookies, proof keys, or bearer URLs.

**Alternatives considered**: Owner sessions confuse principals; self-contained HTML excludes normal Vite chunks/workers; third-party cookies are unreliable; URL tokens leak through logs/history/referrers.

## 4. Derive access from current organization membership

**Decision**: For new active app scopes, authorize full app use from `active exact app share + current organization membership`. Any current organization member may share an app they own, and every current member, including a guest, receives full app functionality. Do not require admin approval or create recipient grants, activations, invitations, acceptance records, roles, permissions, or per-member rows. Keep only an owner invariant row if generic scope code requires it.

**Rationale**: The membership projection is already authoritative and expiring. Materialized app members would duplicate Clerk state, delay newcomers, and create synchronization races.

**Alternatives considered**: Auto-activation retains rejected role/acceptance semantics; materializing the organization creates fan-out and stale authority; organization admin status is not app ownership.

## 5. Share the owner's existing Postgres records

**Decision**: Route owner and recipient reads/writes to the creator's existing declared app tables. The share scope is authorization, not a row namespace. V1 applies no record filter.

**Rationale**: This is the confirmed experience, and `scoped-app-bridge.ts` already targets registered schemas/tables without using the derived namespace as a row predicate.

**Alternatives considered**: A new organization schema starts empty; copying rows creates divergence; record ACLs are explicitly deferred.

## 6. Use one canonical mutation coordinator

**Decision**: While shared, owner and recipient writes use the same coordinator. App-table mutation, global app data-revision CAS, idempotency receipt, audit, and event commit in one Kysely transaction.

**Rationale**: Recipient writes already have this shape, but the ordinary owner bridge bypasses collaboration revisions/events. Two write paths would hide owner changes and permit lost updates.

**Alternatives considered**: Polling cannot make writes safe; app-specific `payload` CAS is not schema-general; per-record revisions are deferred in favor of a conservative global V1 revision.

## 7. Make retries and conflicts explicit

**Decision**: Every mutation carries a stable request ID, payload hash, and expected data revision. Same ID/payload replays; same ID/different payload conflicts; revision is enforced in the write transaction. A stale writer receives a bounded conflict and retains local input.

**Rationale**: This prevents duplicate response-lost retries and silent overwrites under PostgreSQL `READ COMMITTED`.

**Alternatives considered**: Pre-transaction checks race; client-only deduplication is not authoritative; last-write-wins violates the spec.

## 8. Keep realtime as a bounded invalidation signal

**Decision**: Reuse the event registry. Signals carry sequence/event/app/build/revision metadata, not record payloads. Clients deduplicate and reread authoritative Postgres state. Open, resume, broadcast, and reconnect reauthorize.

**Rationale**: Existing caps, replay bounds, stale/dead sender eviction, and shutdown drains satisfy the resource-management requirements. Content-free signals cannot become a second data source.

**Alternatives considered**: Record payload broadcasts diverge after missed messages; unbounded replay is unsafe; polling alone misses the active-update target.

## 9. Model lifecycle outcomes separately

**Decision**: Stop-share CASes scope/binding, bumps auth epoch, and records operation/audit/event/directory state transactionally before session revocation. Membership loss fences that actor. Build drift yields `needs_recheck`. Host outage keeps the active share/data and yields a retryable unavailable state.

**Rationale**: These states have different recovery and disclosure. Data must survive every one.

**Alternatives considered**: Generic deletion loses distinctions; automatic build rebind would serve unqualified bytes.

## 10. Readiness is an exact-build capability certificate

**Decision**: Persist readiness when the bounded collaboration declaration matches the immutable build, declared owner schema, bridge/runtime compatibility, Matrix-managed participant identity, revisioned mutation coordinator, content-free signal path, provider policy, and managed build lifecycle. Prove recipient launch, existing owner records, CRUD, retry, conflict, signal, reload, and recovery with two normal authenticated Matrix accounts during end-to-end qualification.

**Rationale**: Readiness can validate the Matrix-managed technical contract without fabricating a second credential. Live qualification, rather than a hidden pre-share identity, proves the rendered recipient UI and common persistence boundary.

**Alternatives considered**: An unchecked declaration admits browser-local apps; a synthetic readiness account adds an identity system the product does not have; replacing live two-account qualification with mocks would not prove production boundaries.

## 11. Participant identity is context, not authority

**Decision**: Inject only bounded actor/display/organization/scope/share/build fields. Never expose membership assertions, direct-session keys, owner cookies, provider tokens, connected accounts, paths, or owner AI spending authority.

**Rationale**: Apps need attribution, while every authorization decision remains server-side. Readiness blocks required functionality that cannot work under existing shared-provider policy.

**Alternatives considered**: Raw Clerk claims add credentials/coupling; creator integration delegation is outside V1.

## 12. Use typed launch targets and preserve unsaved state

**Decision**: Carry an owner/shared launch union through Web Canvas, Web Desktop, web mobile, window managers, and Electron IPC. Web surfaces share one renderer with separate transports; Electron loads the authenticated facade in its isolated `WebContentsView`. Offline, access-ended, conflict, uncertain-save, and recheck states overlay a still-mounted app.

**Rationale**: A synthetic slug can collide with a recipient app or fall back to owner transport. Keeping the renderer mounted preserves unsaved DOM state and fulfills recovery requirements.

**Alternatives considered**: Slug/path encoding is fragile; a second web renderer drifts; automatic reload destroys input.

## 13. Reviewable Matrix stack with a ten-PR maximum

**Decision**: Use the fewest dependency-ordered Matrix OS PRs practical, splitting logical layers whenever a PR would approach 3,000 changed lines. Never exceed ten Matrix OS PRs. The final `FinnaAI/matrix-os-site` docs PR is separate and does not count toward ten. All PRs link ENG-29.

**Rationale**: The five logical code layers isolate readiness, share authority, owner runtime/data, recipient surfaces, and owner UX/qualification, while flexible splits keep review size safe. The separate deliverable keeps public docs in the canonical repository.

**Alternatives considered**: One large PR is not reviewable at this risk; a fixed five-PR limit can force oversized diffs; more than ten Matrix OS layers create excessive restacking and integration overhead.

## 14. Qualify the stack head on a disposable VPS

**Decision**: Validate the union at the final Matrix OS stack head with an exact VPS-native host bundle and owner/member/guest/newcomer/departed/wrong-org/outsider accounts. No authorization or rollout feature flag participates. Rollback targets the compatibility foundation; owner data is never rolled back.

**Rationale**: Production is VPS-native, and only the stack head proves the whole journey.

**Alternatives considered**: Docker is not production parity; isolated-layer demos do not prove the feature; a flag must not become an authorization input.

## 15. Use normal Matrix identities for qualification

**Decision**: Readiness creates no credential source. An exact compatible build may become `ready`; the owner shares it explicitly, and recipients authenticate through their normal Matrix sessions. At every recipient boundary, `active share + current organization membership` is the complete V1 authorization rule.

**Rationale**: Organization members are already authenticated Matrix principals. A second readiness identity would duplicate authentication and add a permission concept outside the confirmed V1 experience.

**Alternatives considered**: Silently impersonating a member violates the identity boundary; bypassing current membership would widen access; requiring an additional acceptance, grant, or readiness login would create the permission system explicitly excluded from V1.
