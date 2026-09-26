# Architecture and Authorization Constraints

**Status:** Planning input, not a finalized API or implementation claim.
**Source baseline:** main `5f9fc536265ac0d22e0ccdf52f166fcc23a186c9`, inspected 2026-09-26.

## Verified starting points

| Existing seam | Observation | Required extension |
| --- | --- | --- |
| `shell/src/app/shared/**/page.tsx`, `OnboardingGate`, `BootSequence`, `ShellHome` | Shared entry currently traverses the machine onboarding and full shell bootstrap | Platform-served authenticated collaboration entry that does not load personal-runtime configuration or require billing |
| `shell/src/lib/collaboration.ts`, shared direct client | Resource connections already target the resource home, independent of selected personal computer | Reuse transport/session cleanup; add account-only discovery and scoped guest authorization |
| Platform identifier resolver and ticket issuer | Identifier resolution and connection admission currently require organization membership | Explicit personal-recipient and organization-guest grant paths; retain organization-member validation rather than removing it globally |
| Gateway collaboration authority, repositories, direct sessions and event registries | Owner-local authority, revisions, scoped sessions, replay and revocation exist | Guest-grant provenance and policy leases across every adapter, including queued execution |
| `shared-ai-runtime.ts`, shared Claude/Codex adapters | Current code contains both shared harness adapters and owner-source resolution | Reuse canonical queue/adapters; verify real capabilities and add safe document proposals, not a parallel AI stack |
| Shared UI and 525/124 evidence | Chat chrome and discovery components exist; recorded evidence has incomplete live/Native Mobile gates | Reuse components and measure real account-only journeys, including Native Mobile transport repair |

These source observations are not production verification. Both shared Claude and Codex adapters exist on this baseline; neither has run against a live provider, so the plan qualifies them rather than rebuilding them.

### Specific blockers on the baseline

| Area | Observation (file:line on the baseline) | Milestone |
| --- | --- | --- |
| Unrouted-account fallback | When the platform cannot proxy the app shell for an account without a routed computer, it redirects to billing setup (`packages/platform/src/session-routing-middleware.ts:360-362`). Shared and invitation destinations must be excluded before the React boundary is reached | M1 |
| Recipient resolution | Email resolution requires an existing Clerk user and current organization membership; an unknown address or non-member fails like an unknown identifier (`packages/platform/src/collaboration/identifier-resolver.ts:84-116`). Pending email invitations need a separate recipient-bound path, not a relaxed resolver | M2 |
| Organization context | No in-product organization create, switch or member invitation exists in `shell/`, `desktop/`, `apps/` or `packages/`; web sharing depends on an active organization set elsewhere, and Electron never supplies `organizationId` to Share controls (absent from `desktop/src/main`) | M1 |
| Native Mobile transport | Mobile still requests `/api/collaboration/scopes/:id/connection-tickets` and non-`/direct/` sockets (`apps/mobile/lib/requests/collaboration.ts:407,452`); the platform retires the former and the relay rejects the latter (issue #1881) | M1 |
| Terminal Share parity | The terminal Share control renders only in the mobile chrome (`shell/src/components/terminal/TerminalApp.tsx:1236`, issue #1798) | M1 |
| Not-found masking | The direct terminal socket is registered only when its dependency exists, so a missing dependency answers 404 and reads as "not shared" (`packages/gateway/src/collaboration/direct-websocket.ts:198`, issue #1829) | M0 |
| Recipient views | Accepting a file, folder or app share opens a Chat, and a shared project renders its ID as the title and its contents as a non-navigable list of resource IDs (`packages/ui/src/collaboration/ChatCollaboration.tsx:159-162,192-194,345-360`); no client calls the scoped file, app or project-Git home routes | M1 |
| File-share concurrency | Only collaborator writes advance the catalog revision, so owner edits outside the share are invisible to `expectedRevision` (`packages/gateway/src/collaboration/resource-actions.ts:156-163`); the share is pinned to device, inode and birth time (`owner-resource-driver.ts`), which an atomic replace-and-rename save changes | M1 |
| Cross-account testing | `tests/e2e/fixtures/collaboration.ts` requires hand-captured Playwright storage state per account, and `tests/e2e/collaboration-project.spec.ts` still targets the retired person-to-person identifier/editor model and cookie-only requests | M0 |
| Real-Postgres suites | Collaboration suites guarded by `MATRIX_TEST_POSTGRES_URL` are skipped in CI because no workflow sets it; race behavior is therefore unexercised | M0 |

### Current limits the plan must reconcile

- Scope participants are capped at 8 (`MAX_SCOPE_PARTICIPANTS`, `packages/gateway/src/collaboration/repository-shared.ts:6`); pending invitations must reserve against the same cap.
- Per-scope event sockets are capped at 32, 4 per actor per scope and 256 per home (`packages/gateway/src/collaboration/events.ts:6-8`). Presence must fit or explicitly revise these caps, including multi-device participants.
- Direct sessions live 300 seconds (`identitySessionTtlSeconds`, `packages/contracts/src/collaboration-direct.ts:28`). The 60-second partition lease in SC-005 therefore needs a per-operation policy-lease check on the home or a shorter renewable session; the session lifetime must not become the effective revocation bound.

## Authority and data ownership

The platform authenticates stable account IDs, stores bounded invitation/discovery/control metadata, resolves the resource home and issues short-lived scoped tickets. The home remains authoritative for resource grants, content, document edits/history/comments, queues and execution. Postgres/Kysely remains the persistence standard in each owner boundary. The existing relay forwards opaque content; it must not acquire a second document store or log content. Existing relay visibility and inference-provider processing must be described accurately; do not claim end-to-end secrecy.

Invitation delivery may use a platform outbox containing only the target address, opaque invitation ID, expiry and a generic link. Resource titles, document excerpts and Chat content are retrieved from the home only after intended-recipient authentication. Do not disclose account existence through invitation creation or lookup. The full technical plan must specify address encryption/access/retention, digest normalization, actor binding and deletion propagation before implementing email invitation storage.

An unregistered-email invitation binds to an immutable account ID only after current verified-email proof matches. Home acceptance commits the grant, invitation state, audit and directory-outbox event atomically; an identity match alone never creates a connection grant. Duplicate acceptance returns the original result. Pending invitation credentials can access only their acceptance preview/decision, never normal content, execution or a parent resource. Renewed verification is required on a mismatched or stale identity proof.

Guest is a relationship, not an organization role or blanket permission. A personal share needs no organization. An organization guest grant is additionally constrained by that organization's external-sharing policy and policy epoch; removal/disable invalidates derived tickets and sessions. A former org member cannot retain an old org-bound guest grant by falling back to a different grant source. An independently created personal grant to a different personal resource is unaffected. Duplicate grants within a scope must have explicit effective-capability derivation, last-grant revocation and audit tests.

Existing member-owned content stays member-owned; hosting does not transfer ownership and authorship does not silently create organization ownership. Export/deletion flows must include new documents and comments under the same authority.

## Runtime wiring

```mermaid
flowchart LR
  A[Owner shares on existing computer] --> H[Resource home: grants, content and execution]
  B[Recipient browser or app: free account] --> P[Platform: identity, discovery and scoped tickets]
  P --> B
  B --> R[Existing opaque relay]
  R --> H
  H --> R
  R --> B
```

The `/shared/*` web entry loads platform identity and metadata, then obtains a resource-specific ticket, establishes the existing direct session through the relay, and renders common resource components. It must neither select a recipient machine nor accidentally issue personal `/api/system/info`, desktop-config or private Chat-history requests as a boot prerequisite. A recipient without any machine can also enter `/shared` directly. Explicit shared routes must survive platform routing, signup handoff and billing middleware before the React boundary is reached.

An authenticated owner creates a home-authorized invitation, commits a directory/delivery outbox event, and sees delivery status. The platform sends a generic email with retry/deduplication. The recipient verifies identity and accepts against the home; grant commit precedes ticket/content admission. If the home is offline, the invitation can be discovered but acceptance remains pending/retryable. Never invent successful acceptance in a platform projection.

Clients share schemas, capability derivations, identity-keyed drafts and document state transitions. Surface adapters supply chrome/navigation only. A minimal collaboration frame can render without personal machine state while using the same Chat/Terminal/document components as the full OS view. Free participants must be able to switch among authorized resource homes.

## Required authorization matrix

Paths marked proposed are logical route families to finalize in the technical plan. The final route map must enumerate concrete endpoints, including errors and WebSocket upgrades; no family below is anonymous content access.

| Route or operation family | Authentication and authority | Public behavior |
| --- | --- | --- |
| `/shared`, `/shared/invitations/:id`, `/shared/{chat,project,terminal,document}/:id` (document proposed) | Account session before resource hydration; validated return destination | Signed-out frame/sign-in only, no title, membership or content preview |
| Existing `/api/collaboration/inbox`, `/api/collaboration/shared` | Platform account session, actor-bound bounded directory projection | None; no machine/subscription prerequisite |
| Invitation create/resend/revoke (home, proposed guest extension) | Owner direct session, scope ownership, current org policy if applicable, idempotency/revision | None; uniform recipient lookup behavior |
| Invitation preview/accept/decline (proposed recipient path) | Platform-verified recipient proof bound to invitation and intended account; home state and expiry | Link alone grants nothing; preview contains only intended share disclosure |
| Existing `/api/collaboration/connections` | Account session; exact resource grant or narrowly scoped invitation-purpose proof; applicable policy freshness | None; guest proof cannot mint owner-runtime tickets |
| Existing `/api/collaboration/direct-sessions` and renew | Home validates ticket, actor, audience, purpose, grant/policy epoch, expiry and resource | None |
| Existing `/ws/collaboration/direct/scopes/:scopeId/:purpose`; new presence/document purposes | Scoped browser-compatible session authentication and frame schemas; home reauthorization and bounded replay | None; register exact browser upgrade paths, never trust client actor/role |
| Document/comment/history/export/proposal route families (proposed home APIs) | Current scoped direct session; read/edit/export/approve capability per operation; revision guards | None |
| Mention/activity metadata/read state (proposed) | Actor session for own activity; home authorizes content hydration and mention targets | None; no cross-scope recipient enumeration |
| External-sharing policy (proposed platform org setting) | Fresh organization owner/admin authority; server-derived org; versioned update and audit | None; policy permission grants no content access |
| Organization create, active-organization switch, member invitation (proposed platform operations) | Account session; fresh owner/admin authority for member invitations; per-account creation and invitation rate limits; idempotent member invitation per organization and address | None; never provisions a machine or starts checkout; invitation lookup does not disclose account existence |
| Existing internal runtime/control/directory operations | Existing runtime/service authentication plus exact owner/runtime binding | None; never substitute a guest credential |

Every mutating HTTP endpoint, including DELETE, requires streaming body limits; boundary schemas bound all IDs, strings, frames, cursors and arrays. Validate return paths and reject cross-origin redirects. Reuse request-origin/CSRF protections for cookie-authenticated mutations. External delivery/identity calls use bounded timeouts. User-controlled fetches retain SSRF and redirect protections. Safe errors reveal no credentials, raw provider errors, private paths or account existence.

## Concurrency, recovery and lifetime rules

- Grant/invitation/policy mutations update authoritative rows, audit and outbox in a transaction. Conditional revision updates or row locks enforce races at the write; retries carry actor-scoped idempotency keys and bounded retention.
- The technical plan must select and spike an operation-merging editor protocol against concurrent edits, comment anchors, scoped undo, persistence, compaction and browser/mobile compatibility. Do not prescribe a new database or treat a last-writer whole-document save as simultaneous editing.
- Acknowledgment follows durable commit. Restore and AI-accept commit document change, revision/provenance and notification outbox atomically. Stale target revisions must fail or be explicitly rebased; accepting a proposal is idempotent.
- AI admission atomically reserves available managed funding where supported and enforces owner per-scope/requester limits. For sources without reliable cost reservation, enforce request/concurrency bounds and display unknown usage rather than guaranteeing currency ceilings. Pin the original source and payer across retry/recovery.
- Guest document-AI runs receive only authorized document context and tools. Existing organization-member broad integration behavior is not silently inherited by external guests. If the adapter cannot constrain indirect integration/Git/terminal access, guest AI remains unavailable while reading/editing works. The next plan must define supported broader guest capabilities explicitly before offering them.
- Reauthorize queued work at dispatch and proposals at apply. Following grant loss, reject all new reads/writes/tool operations. Stop or cancel guest-authorized active runs best-effort, reconcile their durable state, discard unpublished results for the removed audience and record already committed side effects honestly. Do not retry an unknown paid/external outcome automatically.
- Policy/grant freshness leases expire within 60 seconds, including partitions; healthy connected revocation converges within five seconds. Existing longer-lived tickets must not override a shorter policy lease. Home-local revocation denies new operations at commit; remote org disable/departure takes effect through invalidation or bounded lease expiry. Clock skew and renewal are acceptance cases.
- Presence is ephemeral and resource-scoped, with a 30-second stale cutoff, bounded actor/device/scope registries, send-failure eviction and shutdown drains. Durable history is not an unbounded presence log.
- Machine-free accounts consume platform relay capacity without a paying runtime. Enforce per-account concurrent collaboration sockets and daily relay bytes at the relay using connection metadata only, and record usage for cost review; exceeding a limit yields an actionable state, never a silent disconnect loop.
- Planning must set and test caps for pending invitations, send rate, per-account attempts, sockets, document/operation/comment sizes, history pages, retained notification metadata and idempotency records. Start with the existing eight-participant cap; pending reservations must be released on decline/expiry and acceptance capacity must be atomic.
- Private drafts and pending document edits are keyed by actor/resource home/scope/document. Bound cache size/retention; clear renderable shared previews and sessions on sign-out/revoke. Do not silently delete an unsent private draft on transient network failure. Local recovery text must never be sent under a different account or to a different audience.
- Account/resource deletion schedules bounded recurring cleanup of pending email deliveries, discovery metadata, activity, grants and caches; parent deletion cascades or tombstones child history consistently. Owners close shared DB pools; shutdown stops timers/subscribers before dependencies.

## Planning proof obligations

Before implementation, finalize schema migrations, endpoint-by-endpoint auth, email invitation capability format and redemption, guest/member policy union rules, editor protocol, retention limits, Native Mobile compatibility, managed/custom-source budgets and exact active-run interruption semantics. Add fail-first tests for each boundary and full real-Postgres races. Probe undocumented editor/harness behavior before depending on it.

No rollout flag or cohort policy from retired collaboration architecture is reintroduced. Compatible host capability negotiation may expose unavailable states until an implementation milestone is supported. Old hosts must reject unknown guest/document tickets and never fall back to an owner session or unrestricted legacy route. Upgrade/rollback preserves grants and content; downgrades that cannot represent new grants must fail closed and keep owner export/recovery available.
