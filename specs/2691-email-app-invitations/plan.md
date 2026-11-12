# Implementation Plan: Email Invitations for Matrix.page Apps

**Branch**: `2691-email-app-invitations` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)  
**Tracking**: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os)  
**UI dependency**: [PR #3200](https://github.com/HamedMP/matrix-os/pull/3200)

## Summary

Add `private_email` as a third Matrix.page publication mode alongside `public`
and `private_link`. The owner manages named recipients in PR #3200's existing
Share app panel. Matrix and Matrix.page use the same existing Clerk identity
and shared sign-in state: an already signed-in Matrix user enters an authorized
app without another login, while a new viewer signs up on the app URL without
entering Matrix onboarding or billing. Matrix Postgres remains authoritative for invitations and
durable site-scoped viewer grants. A Matrix.page authentication gate proves a
Clerk identity, the platform checks its authoritative verified-email set, and
then mints an opaque, path-scoped viewer session. Every protected publication
route rechecks that local grant; no Matrix runtime, onboarding, billing, or VPS
is created for a viewer.

The exact-url and shared-session requirements are hard feasibility gates. Current Clerk guidance
documents sign-in on the primary domain for satellite domains. Before feature
implementation, a disposable spike MUST prove that the existing Clerk instance
can render and complete sign-in/sign-up on the canonical Matrix.page app URL,
recognize an existing Matrix sign-in without a second prompt, and make sign-out
on either origin end the shared Matrix sign-in state in that browser and revoke
its site viewer sessions. The spike must prove a reliable Clerk session ID and
trusted synchronous termination path from both origins; a surviving viewer
cookie on the next request fails the gate. A signed lifecycle event is backup
cleanup, not the next-request authority boundary.
If it cannot, work stops for a product decision; a redirect through the Matrix
main auth flow is not an authorized fallback.

## Technical Context

**Language/Version**: Node.js 24+, TypeScript 5.5+ strict ES modules  
**Primary Dependencies**: Hono, Zod 4 (`zod/v4`), Kysely, PostgreSQL, React 19,
Next.js 16, Clerk (`@clerk/backend` in Platform and ClerkJS in the isolated
Matrix.page gate), Cloudflare Worker runtime for the Matrix.page edge  
**Storage**: Platform PostgreSQL/Kysely for owner-scoped invitation, grant,
viewer-session, delivery-outbox, and audit metadata; existing owner PostgreSQL
continues to own visitor form/app data; immutable site artifacts remain in the
existing site object store  
**Testing**: Vitest unit/contract/route tests, real independent-connection
PostgreSQL race tests, Worker tests, full-path integration tests, UI tests, and
live browser evidence  
**Target Platform**: Matrix.page on desktop and mobile web; owner controls in
Web Desktop, Web Canvas, and Electron Desktop; Linux Platform/Gateway services;
Cloudflare Worker edge  
**Project Type**: Monorepo web platform with shared contracts, Hono services,
Next.js/Electron owner shells, and a server-rendered Matrix.page wrapper  
**Performance Goals**: Return an explicit result for 100 invitees in under 10
seconds excluding inbox delivery; restore an accepted viewer in under 30
seconds; make completed owner revocation effective on the next request and
visible within five seconds; keep normal authorized publication reads free of
Clerk network calls  
**Constraints**: 32 KiB/100-address owner batch, 2 KiB viewer exchange, 254-char
email limit, 7-day pending invitation expiry, keyset pages of at most 100,
10-second external API timeout with redirect rejection, no authorization cache,
no transaction across an external call, no raw provider errors or PII in logs
or analytics, no source/app secrets exposed to viewers; any custom callback
context is server-issued, site-bound, single-use, and valid for at most ten
minutes
**Scale/Scope**: One active invitation per normalized email and publication,
one active grant per Clerk user and publication, capped site-scoped sessions,
bounded delivery workers, and five affected live surfaces. Existing public and
one-time-link publications remain behaviorally unchanged.

## Constitution Check

*GATE: Passed for design. Re-evaluated after Phase 1 below.*

| Principle | Design evidence | Result |
| --- | --- | --- |
| Data belongs to its owner | Publication access metadata is owner-scoped, exported and erased with the publication. Visitor form/app data remains in the owner's Postgres. Recipient email PII never enters general analytics. Recipient deletion revokes identity references and sessions. | PASS |
| AI is the kernel | This is deterministic access-control infrastructure; it neither bypasses nor adds competing agent logic. | PASS |
| Headless core, multi-shell | Platform service and shared contracts are authoritative. Web Desktop, Web Canvas, and Electron consume one shared client; the recipient flow is independent of an owner shell. | PASS |
| Quality over shortcuts | The design keeps three modes distinct, uses the sealed private package, and blocks release rather than substituting unsupported auth behavior. | PASS |
| App ecosystem and ownership | The publisher retains source and ownership; viewers receive only declared visitor capabilities and never an installation or owner runtime. | PASS |
| Multi-tenancy | Owner, publication, invitation, and recipient identities are explicit. No invitation grants org membership or merges personal/org scope. | PASS |
| Defense in depth | [contracts/http-api.openapi.yaml](contracts/http-api.openapi.yaml) and [contracts/runtime-boundaries.md](contracts/runtime-boundaries.md) define route auth, validation, cookie/token handling, limits, timeouts, safe errors, lifecycle, and full-path wiring. | PASS |
| TDD | Every implementation slice starts with a named failing production-boundary test, including real PostgreSQL acceptance and revoke races. | PASS |
| Worktree, PR, Greptile | This plan is in a manual worktree on `2691-email-app-invitations`; delivery requires a linked ENG-29 PR and Greptile 5/5 before merge. | PASS |
| Public documentation | A separate `FinnaAI/matrix-os-site` PR is a release deliverable. | PASS |

### Feasibility gate (not a constitution waiver)

The inline Clerk experience on a different registrable domain is not supported
by the currently documented satellite-domain happy path. Phase 0 must prove the
literal requirement using the production Clerk instance and Matrix.page DNS.
No code beyond an isolated throwaway spike may enable `private_email` until this
passes. Failure is a product blocker, not permission to redirect through Matrix
onboarding or to create a second identity universe.

## Project Structure

### Documentation (this feature)

```text
specs/2691-email-app-invitations/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-api.openapi.yaml
│   └── runtime-boundaries.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
packages/contracts/src/
└── sites.ts                         # shared modes, invitation/grant DTOs and limits

packages/platform/src/sites/
├── migration.ts                     # generation-3 schema and widened mode CHECK
├── types.ts                         # Kysely table types
├── service.ts                       # publication lifecycle orchestration only
├── email-invitations.ts             # owner invitation/grant transactions
├── email-viewer-sessions.ts         # exchange, session lookup and revocation
├── invitation-delivery.ts           # durable bounded outbox worker
├── invitation-mailer.ts             # narrow provider interface/adapter
├── invitation-audit.ts              # bounded security-event writes/reads
├── auth-contexts.ts                  # conditional one-use callback context if spike requires it
├── management-routes.ts             # internal owner management routes
├── public-routes.ts                 # Matrix.page gate and exchange route
├── renderer.ts                      # branded auth gate; app-frame CSP stays isolated
├── account-lifecycle.ts             # owner and recipient cleanup
└── registration.ts                  # explicit dependency construction/wiring

packages/platform/src/account-deletion/
├── cleanup-data.ts                  # recipient grant/session cleanup
├── export.ts                        # bounded owner export without secrets/hashes
└── routes.ts                        # idempotent Clerk user lifecycle events

packages/gateway/src/sites/
├── routes.ts                        # owner-authorized public API
└── platform-client.ts               # machine-bound Platform transport

packages/edge-router/src/sites.ts    # exact route/header/cookie allowlists

shell/src/components/app-sites/
├── AppSitePanel.tsx                 # PR #3200 integration seam
└── SiteEmailInvitations.tsx         # invitation inventory and actions

shell/src/lib/site-client.ts         # shared owner client contract
shell/src/components/app-sites/web-site-client.ts
desktop/src/renderer/src/features/app-sites/site-client.ts

tests/contracts/sites.test.ts
tests/platform/sites-email-invitations*.test.ts
tests/platform/sites-private-routes.test.ts
tests/platform/sites-edge.test.ts
tests/platform/sites-renderer.test.ts
tests/platform/sites-fullpath.test.ts
tests/platform/sites-management.test.ts
tests/platform/account-deletion-*.test.ts
tests/gateway/sites-*.test.ts
tests/ui/app-sites*.test.tsx
tests/desktop/sites-client.test.ts
```

**Structure Decision**: Extend the existing Sites vertical slice. Keep
`service.ts` as publication composition and extract invitation, delivery, audit,
and session responsibilities before it crosses 500 LOC. Do not create a second
sharing panel or fork Web/Electron business logic. PR #3200 owns placement;
this feature owns the disabled email row's behavior.

**PR #3200 seam check (T003)**: PR #3200 is merged at
`6df707a83cf209805f8f7c2eededa1a71aafbea0`. Its
`AppSiteSharePanel` renders `AppSitePanel` with `variant="share"`, and
`ShareInviteSection` in `AppSitePanel.tsx` contains the disabled email input
and Invite button above the one-time-link controls. Integrate behavior there;
preserve `AppSiteSharePopover` and the one existing Share app panel. This
feature branch predates that merge, so reconcile with current `main` before
touching the UI. The expected conflict is `AppSitePanel.tsx`'s two-mode
`accessMode` state and disabled email row, not a new panel or duplicate link
flow.

**Main sign-out wiring**: The existing Platform
`DELETE /api/auth/app-session` route in
`packages/platform/src/app-session-routes.ts` has a 1 KiB body limit and
verifies the Clerk session cookie before revoking that Clerk session. Extend
this route to synchronously revoke keyed Matrix.page viewer sessions before
Clerk session revocation or cookie clearing. A failure to revoke viewer
authority must stop sign-out completion and return a coarse retryable error.
Update all callers, including `shell/src/lib/sign-out.ts`,
`shell/src/components/runtime/RuntimeManager.tsx`,
`shell/src/components/UserButton.tsx`,
`shell/src/components/taskbar/Win11ManagedAccountActions.tsx`, and the
Platform auth page. The Matrix.page gate's sign-out ordering lives in
`packages/platform/src/sites/renderer.ts`. The production-domain spike must
prove this mechanism before any production change.

## Delivery Phases

### Phase 0 — Prove Clerk and delivery behavior

Run the throwaway spike in [quickstart.md](quickstart.md) before production
implementation. It must prove inline email-code and OAuth sign-in/sign-up at
`https://matrix.page/<site-id>`, reuse of an already signed-in Matrix browser
session without another prompt, authoritative session-token retrieval,
verified primary/secondary email lookup, fixed same-site return behavior,
account switching, shared Matrix sign-out from either origin, session-ID binding
and synchronous trusted revocation before sign-out completion, and zero calls to app-session, billing,
onboarding, or provisioning routes. Test Chrome, Safari, mobile Safari, private
browsing, and restricted-cookie settings. Also prove the selected invitation
mailer can deliver only the canonical app URL without treating link possession
as verified-email authority.

If Clerk requires any custom callback context, the spike identifies its exact
boundary. Implement only a server-issued random, single-use, site-bound
context with a ten-minute maximum lifetime and a server-derived canonical
destination; write a failing replay/cross-site/expiry test first. If no custom
context is needed, document that result and create none. The main Matrix URL
keeps its existing full-product onboarding and billing flow; the shared app
URL never invokes it.

The spike is discarded and its credentials/captures remain outside the repo.
A negative result blocks Phase 1 and is recorded on ENG-29.

### Phase 1 — Contracts and generation-3 persistence (TDD)

Write failing shared-contract and migration tests first. Extend the access-mode
union to `private_email`; add strict create/list/resend/revoke/exchange schemas,
limits, cursors, capability advertisement, and safe response enums. Replace the
existing PostgreSQL access-mode CHECK explicitly—`ADD COLUMN IF NOT EXISTS`
cannot widen it—and bump the Sites migration marker.

Add separate invitation, grant, viewer-session, delivery-outbox, and audit
tables as described in [data-model.md](data-model.md), plus a durable keyed
recipient lifecycle and Clerk-session-termination projections for race-safe
revocation and, only if the spike
requires one, the short-lived callback-context table. Write failing migration,
replay, and audit tests before related implementation. Complete the audit
repository before acceptance or owner mutation services call it. Use owner advisory lock
then site row lock for owner mutations. Acceptance takes the site/invitation
row locks and recipient account-deletion admission in the US1 acceptance slice;
its targeted write enforces
the invitation generation/state predicate. Related writes and audit events are
one transaction. No transaction spans email or Clerk calls.

### Phase 2 — Headless invitation and authorization services (TDD)

Extract focused services from the current 399-line Sites service. Implement
idempotent batch creation, resend generation, revocation, keyset inventory,
durable outbox leasing, atomic acceptance, returning-viewer session exchange,
and lifecycle cleanup. Store hashes only for Matrix-issued secrets; compare
fixed-length values with `timingSafeEqual`.

The owner batch response uses `queued | existing | invalid |
duplicate_in_batch | policy_rejected`. `queued` and `existing` always include
the invitation summary and its current state; rejected results do not reveal
an invitation. This provides one result per input in order.

The delivery worker claims at most 25 jobs with `FOR UPDATE SKIP LOCKED`, a
five-minute lease, at most five attempts, exponential backoff capped at one
hour, and recurring cleanup. Every provider request has a 10-second timeout,
`redirect: "error"`, bounded response parsing, and generic persisted failure
codes. Shutdown stops the timer, waits up to five seconds for an active batch,
then releases owned resources. Provider ambiguity stays retryable and never
changes publication authority.

### Phase 3 — Matrix.page gate and edge exchange (TDD)

Redirect every private friendly alias to the permanent publication ID. Add one
canonical `POST /:siteId/access/email` exchange route. The Worker forwards a
bounded bearer only on that exact same-origin route, never on wrapper/frame/
form/content routes. Platform verifies Clerk identity, fetches the authoritative
Backend User with a 10-second deadline, rejects banned/locked/deprovisioned
users, and accepts only `verification.status === "verified"` emails.

On success, issue the existing strict path-scoped HttpOnly viewer-cookie
envelope backed by a new email viewer-session row. Subsequent wrapper, sealed
frame, declared data/form/action, and package requests use only this cookie and
revalidate publication mode, grant, and session locally on every request.
Generalize sealed private packages to both private modes; direct private asset
routes remain denied. Add the narrow Clerk origins only to the trusted auth
gate CSP, never to the opaque app-frame CSP.

The first recipient increment includes the complete protected visitor route
set, not merely the gate or landing wrapper. Owner/private-runtime denial is
qualified in the later visitor-permissions story. A same-origin sign-out route
uses a verified bounded Clerk bearer and/or the exact site cookie to resolve a
keyed Clerk session ID, requires both to agree when both are present, writes a
terminal marker, revokes that browser session's viewer authority across sites,
and expires the cookie. The trusted gate then completes Clerk sign-out. Main
Matrix sign-out must await the same keyed revocation through the T001-proven
trusted hook before Clerk sign-out completes. A signed session event may provide
backup cleanup but cannot meet next-request denial. Exchange takes the session-key lock
before recipient/site locks and rejects a terminated marker; this closes the
sign-out versus acceptance race. Account switching revokes old viewer
authority before activating another account.

Extend the signed Clerk user webhook with idempotent/out-of-order-safe lifecycle
handling. `user.deleted`, and `user.updated` states that are banned, locked, or
deprovisioned, revoke recipient grants/sessions. Late update events cannot
resurrect deleted authority. Persist the keyed recipient event ID, timestamp,
and state in the generation-3 projection; an in-memory replay cache is not
authority. Inactive/deleted projection and grant/session revocation share one
transaction, and acceptance checks recipient admission after Clerk lookup.

### Phase 4 — Owner API and PR #3200 UI integration (TDD)

Add Gateway and machine-authenticated Platform management routes from the
OpenAPI contract. Enable only PR #3200's disabled email invitation seam and
extract `SiteEmailInvitations.tsx`. The component uses the shared site client,
shows per-address results and paginated status, catches every mutation/export
failure, refreshes after success or conflict, and preserves one-time-link UI.

Use `@matrix-os/brand` primitives/tokens. The transient Share panel retains
trigger-toggle, outside-click, Escape, focus return, reduced-motion, and no-
layout-shift behavior. Do not rebase PR #3200; resolve its expected component
conflict after both diffs are ready.

### Phase 5 — Lifecycle, export, telemetry, rollout, and evidence

Extend owner export/deletion and viewer deletion. Export non-secret invitation,
grant, delivery, and audit metadata with strict caps; omit tokens, hashes,
provider responses, and other owners' data. Unpublish or a mode change away
from `private_email` revokes invitations, grants, sessions, and queued delivery
in the same owner-locked transition. Updating/rolling back while retaining the
mode preserves them.

Emit only coarse best-effort outcomes (`created`, `delivery_succeeded`,
`delivery_failed`, `accepted`, `revoked`) with access mode; exclude email,
Clerk IDs, site IDs, URLs, tokens, provider names, and content.

Deploy persistence/Platform, Matrix.page edge, Gateway, then UI capability
enablement. Old UI keeps the row disabled until the backend advertises
`privateEmailInvitations`. Rollback disables the capability and UI first,
leaves additive tables/columns in place, and restores the prior edge allowlist;
never down-migrate or restore revoked grants.

Qualify the exact commit/build with live evidence on Web Desktop, Web Canvas,
Electron Desktop, Matrix.page desktop web, and Matrix.page mobile web. Attach
the captures to the code PR and post the same evidence with ENG-29 and the PR
in Slack `#tech`; link that permalink back to the PR. Keep captures out of the
repo. Create a separate `FinnaAI/matrix-os-site` docs PR explaining the three
access modes, recipient journey, revocation, and limitations.

## Test Effectiveness Map

| Journey / named fault | Real boundary and red proof | Green checkpoint |
| --- | --- | --- |
| New viewer enters the intended app, not onboarding | Real Clerk spike plus full-path route test fails if app-session/provision routes are called or return target changes | Same canonical app loads after verified-email acceptance |
| Existing Matrix sign-in is reused | Real production-domain browser spike starts signed in at Matrix and opens the app URL | No second login; authorized app opens and sign-out ends the shared session |
| Callback cannot replay or redirect | If the spike requires custom context, a real DB-bound test reuses/changes/expires it | Exactly one same-publication completion; otherwise document no custom context |
| Concurrent invite creation does not duplicate authority | Independent PostgreSQL connections race normalized variants against the unique key | One invitation/generation and explicit result per input |
| Concurrent acceptance has one winner | Independent PostgreSQL connections race two Clerk users on one invitation | One accepted identity, one active grant, no partial state |
| Revocation closes every route | Full-path wrapper/frame/form/action requests use a real DB grant, then owner revokes | Every later request denies; cached immutable bytes are never served before fresh auth |
| Modes remain independent | Existing public and private-link suites run unchanged beside email-mode suite | Public stays anonymous; one-time link stays browser-bound; email session never crosses mode |
| Delivery ambiguity does not invent success | Controlled provider times out after dispatch and worker restarts | Durable retry state remains; no grant or `sent` claim is fabricated |
| Recipient deletion wins races | Real account-deletion admission and acceptance use independent connections | New acceptance is blocked and all existing sessions are revoked |
| Late Clerk event cannot revive access | Durable recipient lifecycle projection is exercised by duplicate/out-of-order signed webhook events | Older or duplicate update cannot undo inactive/deleted revocation |
| UI uses one source of truth | PR #3200 component test injects stale revision and transport failure | Panel retains state, shows safe error, refreshes authoritative inventory |

Each code phase runs focused tests first, then relevant package typechecks and
`bun run test`. Required integration lanes fail rather than skip when Postgres,
Clerk spike credentials, browsers, or live surfaces are unavailable.

## Post-Design Constitution Re-check

Phase 1 design introduces no alternate database/ORM, no unbounded collection,
no wildcard CORS, no cross-site open redirect, no external call without a
deadline, and no client-supplied identity authority. Multi-write flows and audit
records are transactional; delivery is a durable outbox outside those
transactions. Auth is route-specific and the full runtime chain is testable.
The feasibility gate prevents a UX/security requirement from being weakened by
implementation convenience. All constitution gates remain **PASS**.

## Complexity Tracking

No constitution violation is requested. The five-table model is justified by
separate security lifecycles: recipient intent, durable authority, revocable
browser sessions, retryable external side effects, and append-only audit. These
cannot be safely collapsed without mixing external delivery state with access
authority or losing immediate session revocation.
