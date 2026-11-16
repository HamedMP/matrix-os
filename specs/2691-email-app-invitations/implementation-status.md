# Implementation checkpoint — 2026-11-16

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os).
Native stack: [#3341](https://github.com/HamedMP/matrix-os/pull/3233), ten draft layers #3233 and #3332–#3340.
Public documentation remains the separate [site PR #358](https://github.com/FinnaAI/matrix-os-site/pull/358).

## Requester direction

Finish implementation and rebase onto current main. Defer spikes, automated
checks, regression work, and runtime/visual qualification. This overrides the
earlier test-first and spike-before-code sequence for this work only. Previous
checkmarks and test counts describe historical revisions; none qualify the
rewritten stack or the new implementation. Keep every PR draft.

The production email-invitation capability remains disabled. No production
Clerk, DNS, deployment, provider, sender, or delivery changes are authorized.
Assuming Clerk compatibility for coding is not proof of domain compatibility.

## Current implementation

- The merged Share UI from #3401–#3404 is authoritative. Web Desktop and Web
  Canvas enter through AppSiteButton; Electron enters through
  DesktopAppSiteButton. Both use packages/ui/src/share and the same real
  site-client invitation adapter. The old AppSitePanel remains for legacy
  consumers; it is not the primary invitation surface.
- An authenticated capability read works before a publication exists. It does
  not publish an app, send mail, or bypass any readiness gate.
- The shared controller deploys directly in private_email or uses the backend's
  revision-checked, atomic mode transition. Owner confirmation precedes replacing
  another mode. Invitation results and mutations update the site revision.
- The current Private tab renders server invitation/delivery state, permits
  resend/revoke only in valid states, and pages a bounded list. Late reads and
  mutations are ignored after app/account/runtime changes. Addresses are masked
  from analytics capture.
- The inline Clerk gate keeps sign-in/sign-up and all return destinations on the
  canonical https://matrix.page/<publication-id> URL. Normal provider trips may
  temporarily leave. No Matrix main-login or Account Portal fallback is added.
- The trusted Matrix.page parent includes Sign out after entry. Account switching
  and sign-out revoke local viewer authority before Clerk sign-out and explicitly
  return to the same canonical app. Clerk is never exposed to the opaque app frame.
- The Clerk identity parser accepts the installed backend UserJSON contract
  (banned/locked, verified primary or secondary emails); an optional supplied
  deprovisioned flag is still honored. Live identity/session behavior is unproven.

## Added authenticated read

GET /api/apps/:appSlug/site/email-invitation-capabilities uses the existing
Gateway owner principal, then the machine/slot/epoch-bound Platform credential.
The internal path is /internal/containers/:handle/sites/:appSlug/email-invitation-capabilities.
It accepts no query input except the trusted internal runtimeSlot, returns only
{ privateEmailInvitations: boolean }, and is no-store. Missing support/readiness
keeps the control disabled. Invitation mutations still enforce readiness
independently, even after a successful capability read.

## Delivery boundary and coordination

The template, mailer interface, outbox, worker, suppression/retry/idempotency
logic and existing tests are preserved. This pass does not select a provider or
sender, implement an adapter, start the worker, send invitations, or claim
delivery qualification.

The delivery owner should branch from the published owner layer (#3334) using
native stack coordination, rather than edit an old worktree whose history was
rewritten. Shared files requiring coordination: registration.ts, main.ts,
management-routes.ts, email-invitations.ts, types.ts, migration.ts, contracts/src/sites.ts,
and the site client contract. Provider-specific work belongs behind
invitation-mailer.ts/invitation-delivery.ts, not in the shared UI or auth gate.
Do not replace the existing privateEmailInvitations readiness gate.

## Deferred qualification

- Installed-version and production-domain Clerk spike: existing-session reuse,
  verified primary/secondary email matching, signup, Google/GitHub return,
  account switching, sign-out from both origins, browser/cookie restrictions.
  Use seeded test invitations and manually opened canonical links; delivery
  must stay off.
- Type checks, focused and broad tests, regression red/green evidence, CI and
  Greptile against the rewritten heads. Existing fixture assertions may need
  updating for the real adapter, capability read, nonce CSP and sign-out chrome.
- Live visual captures for Web Desktop, Web Canvas, Electron and Matrix.page
  desktop/mobile. No captures or production-domain success are claimed here.
- Approved provider/sender, domain verification, suppression, retry and
  idempotency/ambiguous-delivery qualification by the delivery owner.

Do not enable the capability or call the stack release-ready until the deferred
login and delivery gates are qualified and the affected UI surfaces are reviewed.
