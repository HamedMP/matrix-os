# Research: Email Invitations for Matrix.page Apps

**Feature**: `2691-email-app-invitations`  
**Date**: 2026-11-09

## Decision 1 — Preserve the literal same-URL Clerk requirement as a spike gate

**Decision**: The supported product journey remains an inline Clerk component
on the canonical `https://matrix.page/<publication-id>` page, using the existing
Matrix Clerk identity and shared browser sign-in state. A person already signed
in to Matrix enters an authorized app without a second login; a new viewer
signs up at the app URL without Matrix onboarding or billing. A production-
domain spike must prove this before implementation can enable `private_email`.
It must also prove that sign-out on either origin ends the shared Matrix
session in that browser, supplies a stable Clerk session ID, and reliably
invalidates associated Matrix.page viewer sessions across sites on the next
request. Main Matrix sign-out requires a trusted synchronous revocation hook
before Clerk sign-out completes; a signed session event may provide backup
cleanup but cannot alone prove next-request denial. The spike must establish
the hook and its failure behavior. Failure blocks the
feature and requires an explicit product decision.

**Rationale**: The user explicitly rejected sending recipients into Matrix main
onboarding or another Matrix funnel. Clerk's current satellite-domain guide says
the primary domain holds auth state and demonstrates satellite sign-in by
redirecting to the primary domain and back. Matrix.page is a different
registrable domain from matrix-os.com, and this repository currently contains
no Matrix.page satellite configuration. The exact behavior of the repo's
installed Clerk versions is therefore not something the design can assume.

The main Matrix URL retains its existing onboarding and billing behavior for
people explicitly entering the full Matrix product. The shared app URL never
invokes that funnel. If the exact-URL Clerk flow needs custom callback state,
use only a server-issued, site-bound, single-use context valid for at most ten
minutes with a server-derived destination. If it does not, create none.

**Evidence**:

- [Clerk: authentication across different domains](https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains)
- [Clerk: JavaScript SignIn component](https://clerk.com/docs/js-frontend/reference/components/authentication/sign-in)
- `packages/platform/src/auth-pages.ts` currently exchanges normal auth through
  the Matrix app-session path.
- `shell/src/app/sign-up/[[...sign-up]]/page.tsx` currently returns signup to
  `/`, not a Matrix.page publication.

**Alternatives considered**:

- **Redirect to a dedicated primary-domain viewer auth page**: technically
  compatible with documented satellites and avoids provisioning, but violates
  the exact-URL requirement. It is documented only as a product-decision
  fallback, not authorized by this plan.
- **Second Clerk application with Matrix.page as primary**: keeps auth inline
  but creates a second identity universe, duplicate accounts, separate deletion
  hooks, and non-portable user IDs. Rejected.
- **Move the existing Clerk primary domain to Matrix.page**: too broad and risky
  for this feature; it would turn every Matrix shell into a satellite. Rejected.
- **Cross-origin iframe or undocumented custom flow**: unsupported and adds
  clickjacking/CSP risk. Rejected.

## Decision 2 — Matrix Postgres, not Clerk or the browser, is access authority

**Decision**: Clerk proves identity and verified-email ownership only. Platform
Postgres stores invitation intent, the accepted account binding, durable grant,
viewer sessions, delivery state, and audit history. After acceptance, the
stable Clerk user ID plus active local grant is authoritative.

**Rationale**: Email may change after acceptance, while the product promises
durable person-level access until owner revocation. Browser-supplied email and
mutable JWT custom claims are insufficient. Platform authority also lets
Matrix.page keep serving while the publisher's VPS is offline.

**Alternatives considered**:

- **Clerk Organizations**: grants organization membership rather than one-site
  viewer access and changes product semantics. Rejected.
- **Clerk invitation state as the grant**: application-wide, external, and not
  coupled atomically to publication mode, unpublish, or owner deletion.
  Rejected.
- **Match email on every request**: makes access disappear on benign address
  changes, requires Clerk network access on every request, and turns an
  external outage into an app outage. Rejected.
- **JWT email claims**: commonly primary-only and can be stale. Rejected for
  acceptance authority.

## Decision 3 — Fetch authoritative verified emails only during exchange

**Decision**: After verifying a short-lived Clerk session token, Platform calls
the fixed Clerk Backend user endpoint with a 10-second timeout, redirect
rejection, a bounded response, and a strict Zod schema. It accepts any account
email whose verification status is exactly `verified`; trimming and Unicode-
independent lowercase comparison are the only normalization.

**Rationale**: Clerk's Backend User contains all account email addresses, and
the EmailAddress object carries verification state. This supports secondary
verified emails without trusting the browser or inflating session cookies.

**Evidence**:

- [Clerk Backend User](https://clerk.com/docs/reference/backend/types/backend-user)
- [Clerk Backend EmailAddress](https://clerk.com/docs/reference/backend/types/backend-email-address)
- [Clerk custom session claims limitations](https://clerk.com/docs/guides/sessions/customize-session-tokens)

**Alternatives considered**:

- **Primary email helper in `@matrix-os/clerk-sync`**: does not model
  verification status. Rejected.
- **Client `useUser()` email list**: client assertions are not authorization.
  Rejected.
- **Clerk lookup on every app request**: slow, rate-limited, and outage-prone.
  Rejected.

## Decision 4 — Exchange Clerk proof for an opaque site session

**Decision**: Add one same-origin canonical exchange route,
`POST /:siteId/access/email`. Only that route and the exact same-origin
`POST /:siteId/access/email/sign-out` route may carry a bounded Clerk bearer
through the Matrix.page Worker. Successful exchange mints an opaque,
publication-path-scoped HttpOnly cookie using the existing strict cookie
envelope. Content requests never forward Clerk cookies or bearer tokens.

**Rationale**: The current Worker deliberately strips credentials except the
site viewer cookie. Preserving that boundary minimizes credential exposure and
lets each content request revalidate local grant/session state without an
external call.

**Alternatives considered**:

- **Forward Clerk `__session` everywhere**: exposes a broad identity credential
  to unrelated site paths and weakens the Worker's exact allowlist. Rejected.
- **Put a grant token in URL/query**: leaks into history, logs, referrers, and
  analytics. Rejected.
- **Signed self-contained long-lived cookie**: cannot be revoked immediately
  without a denylist, which recreates server state less clearly. Rejected.

## Decision 5 — Keep invitation delivery separate from authority

**Decision**: Introduce a narrow injected `SiteInvitationMailer` and a durable
Postgres outbox. The initial deployment must use a reviewed platform
transactional-mail adapter that sends the canonical app URL and does not treat
link possession as verified-email proof. If no adapter is configured, the
backend capability remains false and PR #3200 keeps the email row disabled.

**Rationale**: The repository has no general product transactional-email
service. Gmail is owner-credential based and unsuitable. Clerk application
invitations send email, but their ticket can verify the invited address and the
documented custom flow may redirect across domains; that is stronger link
authority than this product intends. A provider boundary keeps delivery
replaceable while Matrix remains authoritative.

Every delivery call uses a fixed reviewed origin, a 10-second timeout,
`redirect: "error"`, bounded response parsing, and generic failure codes. The
outbox is committed with the invitation; a worker lease happens later. A mail
failure never removes the invitation or grants access.

**Alternatives considered**:

- **Clerk application invitations as the final authority**: application-wide,
  link possession can bootstrap verification, and its documented custom flow
  does not prove the exact same-URL requirement. Rejected as publication
  authority; it may only be reconsidered if the Phase 0 spike proves all
  security semantics.
- **Clerk Organizations**: wrong authorization model. Rejected.
- **Owner Gmail/managed integration**: would expose owner credentials and make
  access management depend on owner runtime availability. Rejected.
- **Synchronous send inside create request/transaction**: external ambiguity
  would cause partial state or long-held locks. Rejected.

## Decision 6 — Separate five persistence lifecycles

**Decision**: Use distinct tables for invitations, grants, viewer sessions,
delivery outbox, and audit events. Widen `public_sites.access_mode` with an
explicit generation-3 constraint replacement.

**Rationale**:

- An invitation represents owner intent and recipient PII.
- A grant represents durable authorization bound to a stable account.
- A viewer session is a short-lived browser credential that must be revocable.
- Delivery is an asynchronous external side effect with leases/retries.
- Audit is append-only security evidence.

Collapsing them makes external delivery state part of access decisions or makes
immediate session revocation impossible. Existing `public_site_access_links`
remains dedicated to anonymous one-time links.

**Alternatives considered**:

- **Extend `public_site_access_links`**: mixes anonymous possession credentials
  with authenticated person grants and risks mode confusion. Rejected.
- **One invitation row with a session secret**: cannot support multiple devices
  or revoke one browser safely without mutating recipient intent. Rejected.
- **Audit only in telemetry**: telemetry is best-effort, not owner-exportable,
  and must not contain recipient PII. Rejected.

## Decision 7 — Lock order and conflict-safe writes

**Decision**: Owner mutations reuse `withSiteOwnerAdmission()`, owner advisory
lock, then site row `FOR UPDATE`. Acceptance acquires recipient account-deletion
admission, locks the site and invitation in a documented fixed order, and uses
a targeted update predicate on invitation generation, pending state, expiry,
and `accepted_clerk_user_id IS NULL`. Grant insert uses unique constraints and
`ON CONFLICT`; audit writes occur in the same transaction.

**Rationale**: Pre-reading a revision under PostgreSQL READ COMMITTED does not
prevent another writer. The write itself must enforce current state. Fixed lock
order avoids owner/reviewer deletion deadlocks.

**Alternatives considered**:

- **Check then insert**: TOCTOU race. Rejected.
- **Rely only on UI `baseRevision`**: stale or malicious clients bypass it.
  Rejected.
- **Hold a transaction over Clerk/email calls**: unbounded lock duration and
  ambiguous rollback. Rejected.

## Decision 8 — Reuse sealed private packaging for every private mode

**Decision**: Generalize private frame packaging from `private_link` to both
private modes. Direct private assets remain denied. Wrapper, frame, declared
data/forms/actions, and any future visitor route dispatch authorization by the
exact access mode and recheck the active local authority on every request.

**Rationale**: The current one-time-link design already avoids public immutable
asset URLs for private builds. Email access needs the same protection. Gating
only the wrapper would expose the frame or visitor mutation routes.

**Alternatives considered**:

- **Gate only `GET /:reference`**: direct-route bypass. Rejected.
- **Make private assets public with unguessable version IDs**: obscurity is not
  authorization. Rejected.
- **Cache grant decisions with packaged bytes**: delays revocation. Rejected.

## Decision 9 — User lifecycle events revoke local authority

**Decision**: Extend the existing signed Clerk user webhook and account-
deletion cleanup. Idempotently revoke grants and viewer sessions for
`user.deleted`; treat banned, locked, or deprovisioned `user.updated` states as
inactive. Persist a keyed per-recipient state and verified event ID/time in a
generation-3 PostgreSQL projection, updated atomically with revocation, so
duplicate or out-of-order delivery cannot resurrect authority after restart.
Deleted is terminal; a newer active update never restores an old grant.
Acceptance also uses account-deletion and lifecycle admission.

**Rationale**: A Matrix.page viewer cookie is separate from a Clerk session;
Clerk revocation alone cannot clear it. Clerk documents webhooks as at-least-
once and unordered, so lifecycle projection must be monotonic.

**Evidence**:

- [Clerk webhook delivery and ordering](https://clerk.com/docs/guides/development/webhooks/overview)
- [Clerk user sync events](https://clerk.com/docs/guides/development/webhooks/syncing)

**Alternatives considered**:

- **Call Clerk on every content request**: rejected for availability and
  latency.
- **Wait only for session expiry**: does not meet deletion/revocation behavior.
  Rejected.
- **Delete grants on email changes**: durable grants are identity-bound after
  acceptance; changing an email must not silently remove access. Rejected.

## Decision 10 — Integrate PR #3200 through its disabled seam

**Decision**: Preserve `AppSiteSharePanel`/`AppSitePanel` placement and extract
`SiteEmailInvitations`. Web and Electron use the same shared site-client
contract. Do not rebase or rewrite PR #3200 now; resolve its expected component
conflict when implementation is integrated.

**Rationale**: PR #3200 already owns title-bar placement, portal behavior, and
the disabled "Invite by email" row across Web Desktop, Web Canvas, and Electron
Desktop. A second panel would fragment sharing semantics and duplicate state.

**Alternatives considered**:

- **New settings page/dialog**: competes with the approved Share app surface.
  Rejected.
- **Put email users into one-time links UI**: hides the identity/durability
  difference. Rejected.
- **Rebase PR #3200 during planning**: explicitly not requested and risks its
  in-progress changes. Rejected.

## Decision 11 — Capability-gated rollout and non-destructive rollback

**Decision**: Platform advertises `privateEmailInvitations` only when the
generation-3 schema, inline Clerk gate, lifecycle webhook, and mail adapter are
ready. Deploy Platform/database and Matrix.page edge before Gateway/UI. The UI
row remains disabled otherwise. Rollback disables capability and UI first and
retains additive schema/data; it never restores revoked access.

**Rationale**: UI-first rollout would expose a dead or unsafe control. Dropping
tables or narrowing the mode constraint while rows exist is destructive.

**Alternatives considered**:

- **Feature flag only in the client**: can drift from backend readiness.
  Rejected.
- **Automatic down-migration**: could erase access/audit state and strand an
  active publication mode. Rejected.

## Resolved Unknowns and Remaining Gate

Architecture, persistence, auth authority, route boundaries, lifecycle,
delivery isolation, UI integration, testing, rollout, and rollback are resolved
in this plan. One empirical compatibility gate remains by design: whether the
existing production Clerk instance can satisfy the literal inline Matrix.page
auth requirement. That is not a spec ambiguity and has no assumed fallback;
[quickstart.md](quickstart.md) defines the pass/fail spike.
