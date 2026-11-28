# Allowlist mode — 2026-11-26 (ENG-590)

Requester chose to enable private sharing without email: owners add addresses,
copy the Matrix.page link themselves, and a verified Clerk email must match.
Delivery stays deferred. Live checks the same day: production Clerk refuses
`https://matrix.page` (`origin_invalid`), so the gate must become a Clerk
satellite like `ai-insights.app`; the deployed Worker already forwards the
email exchange. Plan and readiness rules: spec amendment; tasks T067–T073.
The capability stays off in production until the requester sets the platform
env and passes the manual Clerk checklist.

Implemented on `feat/email-invite-allowlist` (T067–T071): derived readiness
wired in `main.ts`, no-delivery create/renew with a 30-day window and a
500-entry owner cap, site contract v4 readiness, allowlist copy in the shared
Share UI, and the satellite gate plus `https://matrix.page/<uuid>` return
allowlist on the Matrix sign-in/up pages. Automated: 85 Sites/Share/auth test
files (838 passed, PostgreSQL 14 lane included), typecheck, pattern scan and
react-doctor on the changed component. Not claimed: real Clerk satellite
behavior, live per-surface visual evidence.

# Implementation and automated qualification — 2026-11-17

Tracking: [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os).
Native stack: [#3341](https://github.com/HamedMP/matrix-os/pull/3233), ten draft layers #3233 and #3332–#3340.
Public documentation remains the separate [site PR #358](https://github.com/FinnaAI/matrix-os-site/pull/358).

## Requester direction

On 2026-11-16 the requester authorized implementation before qualification.
On 2026-11-17 they authorized automated tests and regression fixes. The Clerk
production-domain spike and email-delivery implementation/qualification remain
deferred. Keep every PR draft and the production capability disabled. No
production Clerk, DNS, provider/sender, deployment or invitation-send changes.

## Automated qualification — 2026-11-17

Tested combined source head: b9e2cd2e4823e6563ec7156ba6c8cdb5d778587e,
on main b37f50a0811d82a41fa65256e7b70fe24946fe9a. The later checkpoint
commit changes documentation only. These results qualify the combined stack;
individual prefixes and the full repository suite are separate lanes.

| Check | Observed result |
| --- | --- |
| Focused Sites, Share, account lifecycle and affected caller tests | 533 passed across 61 files; zero failures/skips |
| Six independent PostgreSQL suites, disposable PostgreSQL 16 | 40 passed; zero failures/skips |
| Repository type check | Passed |
| Diff pattern check | Zero violations; five warnings |
| Production shell build | Passed, including shell TypeScript and prerendering; synthetic build-only Clerk key |
| Separate public-docs PR #358 tests at 9ce87c86c355b9744dc5bf9acdd602b5d5fa1417 | 540 passed; zero failures/skips |

Runtime: Node 26.10.0, pnpm 10.33.4 and Bun 1.4.3 on the isolated development
worktree. Dependency install used the frozen lockfile. Vitest ran the unit
files with two workers and no file parallelism; PostgreSQL used one worker.
Test databases were disposable and removed afterward. Logs and JSON reports
remain outside Git under /tmp/email-regressions-20261117/.

Corrections and retained protection:

- Restrict the login gate's frame source to the CAPTCHA origin; allow the
  same-origin app iframe only in the authenticated parent. The existing CSP
  assertion failed before this correction; all 16 renderer assertions pass.
- Update the legacy preview fixture to persist publication responses for later
  refreshes, and target the current accessible Revoke invitation label.
- Seven real-controller/live-adapter/client-parser cases cover first publication,
  confirmation, revision synchronization, resend/revoke, paging, client changes
  and partial errors. The HTTP service is a fixture, not a live provider.
- Four owner/Gateway/Platform readiness cases protect disabled defaults, no-store,
  owner/machine authority, strict responses and rejected query input.
- Replay the old required deprovisioned-field fault: the new SDK-contract
  assertion fails with that fault and passes with the restored implementation.
  All four identity assertions pass, including terminal/unverified denial.
- Executable parent-page tests check synchronous revocation before Clerk sign-out,
  canonical return, nonce coverage, opaque app isolation and retry on failure.

An intermediate owner-layer timeout assertion lacked the later rollout-layer
rollback fix. The final combined-stack case passes without a timeout workaround.

These automated tests use synthetic identities and controlled Clerk responses.
They do not prove real Matrix.page session sharing, Google/GitHub OAuth return,
production sign-in/signup or real email delivery. No visual qualification,
hosted current-head CI or current-head Greptile result is claimed.

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
- Hosted CI and Greptile against the rewritten heads, plus any broader repository
  and runtime qualification required before merge.
- Live visual captures for Web Desktop, Web Canvas, Electron and Matrix.page
  desktop/mobile. No captures or production-domain success are claimed here.
- Approved provider/sender, domain verification, suppression, retry and
  idempotency/ambiguous-delivery qualification by the delivery owner.

Do not enable the capability or call the stack release-ready until the deferred
login and delivery gates are qualified and the affected UI surfaces are reviewed.
