# Quickstart and Qualification: Email Invitations for Matrix.page Apps

This is the implementation/verification guide for the planned feature. It does
not authorize production deployment, provider purchase, Clerk domain changes,
or account mutations by itself.

## 0. Preconditions

- Work only in a manual worktree derived from the reviewed spec branch.
- Reuse [ENG-29](https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os)
  and link this spec in the issue and PR.
- Do not rebase or modify PR #3200 while its UI is in progress; integrate at
  its documented disabled email-invitation seam later.
- Use a disposable publication, test recipients, and a disposable Matrix VPS
  where runtime testing is required. Never test against private customer data.
- Store screenshots/recordings outside the repo.
- All tests are red-first and must exercise production code. Capture the failing
  assertion before implementation and the passing assertion after it.

## 1. Blocking Clerk exact-URL spike

The feature cannot proceed until this passes. Clerk's documented multi-domain
path normally authenticates a satellite on the primary domain; the required
behavior is stricter.

### Setup

1. With the Clerk/domain owner, configure a temporary production Matrix.page
   satellite or supported Frontend API proxy using the existing Clerk instance.
   Record DNS and Clerk Dashboard changes in the private operator system, not
   this repository.
2. Create a disposable publication with permanent UUID and `private_email`
   hard-disabled outside the spike fixture.
3. Serve a throwaway, first-party gate at the canonical publication URL. Use
   the installed Clerk version and the same publishable key/config expected in
   production; do not use a local fake SDK.
4. Instrument network requests locally so any call to these paths fails the
   spike immediately:
   - `/api/auth/app-session`
   - `/api/auth/provision-runtime`
   - billing/checkout/plan routes
   - onboarding or desktop continuation routes

### Required cases

For each case, the browser's top-level visible URL must remain the publication's
canonical Matrix.page URL throughout Clerk component entry, verification, and
completion:

1. New account with email-code signup.
2. New account with one configured OAuth provider.
3. Existing Clerk account with matching primary verified email.
4. Existing Clerk account with matching secondary verified email.
5. Already signed in on the main Matrix URL in the same browser, then open the
   authorized Matrix.page URL without another sign-in prompt.
6. Signed-in account with no matching email, then safe account switch.
7. Account with unverified matching text only.
8. Banned, locked, and deprovisioned account.
9. Sign-out followed by another account; prove the shared Matrix sign-in ends
   to the agreed scope and the old app viewer cookie cannot authorize.

Run on:

- current Chrome desktop;
- current Safari desktop;
- mobile Safari;
- private browsing;
- restricted third-party-cookie configuration.

### Pass criteria

- Clerk UI renders and completes on the exact app URL.
- `session.getToken()` (or the reviewed equivalent) returns a token the Platform
  verifier accepts without forwarding a Clerk cookie to app content.
- OAuth/email callbacks cannot replace the server-selected publication target.
- No Matrix onboarding, app-session, billing, desktop, or provisioning request
  occurs.
- Viewer-only sign-up creates no machine/user-runtime/billing row.
- Account switch/sign-out expires the exact Matrix.page viewer cookie and
  revokes viewer sessions bound to that browser's Clerk session across sites.
- An existing Matrix sign-in is recognized on Matrix.page without another
  login; signing out from either origin ends the shared sign-in state in that
  browser and denies every associated viewer cookie on its next request.
- A reliable Clerk session ID and synchronous trusted termination hook from
  both origins are demonstrated, including a concurrent exchange versus
  sign-out attempt; hook failure prevents sign-out completion rather than
  leaving a live viewer cookie after a completed sign-out.
- If Clerk needs custom callback context, it is server-issued, site-bound,
  single-use, expires within ten minutes, and cannot change the canonical
  destination. If none is needed, record that fact explicitly.
- Exact Clerk Backend responses for verified/unverified primary/secondary
  emails and inactive flags are captured as sanitized schemas.

### Failure behavior

If any required browser leaves Matrix.page for authentication, or inline Clerk
is unsupported, stop. Record the result on ENG-29 and ask for a product decision
between changing the exact-URL requirement, a separate viewer identity system,
or a broader Clerk-domain migration. Do not implement an implicit redirect to
Matrix main.

Discard the spike code after the result is recorded.

### Attempt status (2026-11-12)

The requester subsequently directed implementation to start while assuming a
positive Clerk result. This is a **product assumption, not a passed spike**:
T001 remains unverified, and the `privateEmailInvitations` capability must
remain disabled until real exact-URL qualification succeeds. The implementation
can be built and tested against production boundaries under this assumption.

T001 is **blocked, not passed or failed**. The implementation worktree has no
Clerk/Worker deployment configuration or test accounts, and `clerk.matrix.page`
has no public DNS answer. In the shared browser, `https://matrix.page/`
redirected to `https://matrix-os.com/`; the subsequent navigation to the main
Matrix app became unavailable, so no authenticated session was observed. No
disposable production-domain publication or exact-URL Clerk flow could be
started. The current [Clerk satellite-domain guide](https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains)
states that sign-in and sign-up complete on the primary domain; this is not
proof of the required inline Matrix.page behavior. Obtain a disposable
Matrix.page app URL configured with the existing Clerk instance and test
accounts from the Clerk/domain owner, then run every case above. Until that
evidence passes, do not start production feature code or substitute another
authentication path.

## 2. Mail adapter qualification

The repository has no general transactional-mail service. Before enabling the
capability, a deployment-approved adapter behind `SiteInvitationMailer` must
prove:

- fixed reviewed API origin and sender domain;
- 10-second deadline and redirect rejection;
- bounded request/response and generic error mapping;
- stable idempotency support, or explicit ambiguous-delivery behavior;
- delivery of a Matrix-controlled template containing app name, inviter name,
  expiry, and only the canonical `https://matrix.page/<uuid>` destination;
- no owner-provided HTML, sender, headers, or arbitrary URL;
- no recipient, URL, token, or provider error in logs/analytics;
- SPF/DKIM/DMARC and suppression handling reviewed by the domain owner.

If the adapter is absent or unhealthy, `privateEmailInvitations` remains false
and the UI row remains disabled.

## 3. Red-first implementation checkpoints

### Checkpoint A — contracts and schema

Write failing tests for:

- three-mode enum and unchanged parsing of existing records;
- create batch size/body/string limits and per-input outcomes: `queued` and
  `existing` require a current invitation summary/state; invalid, duplicate,
  and policy-rejected results expose no invitation;
- strict pagination, cursor, mutation, and exchange schemas;
- generation-3 migration on a database with generation 2 already installed;
- migration run twice;
- old public/private-link rows preserved exactly;
- database checks and unique indexes rejecting invalid combinations.
- durable keyed recipient lifecycle event ordering and, only if the spike
  requires custom callback context, its expiry/single-use constraints.

Then implement shared contracts, Kysely types, and migration.

### Checkpoint B — transactional authority

Using independent PostgreSQL connections, first make tests fail for:

- two normalized variants created concurrently;
- owner mode change racing invitation create;
- two different matching Clerk users accepting concurrently;
- acceptance racing revoke, unpublish, recipient deletion, and expiry;
- duplicate same-user acceptance from two browsers;
- 21st session evicting the oldest of 20;
- audit repository writes/reads before acceptance and owner mutation services
  call it;
- resend generation cancelling stale delivery;
- idempotent duplicate webhook delivery and out-of-order late update.
- stale Clerk lifecycle events after process restart, with no in-memory-only
  replay authority or grant restoration.

Green state must have one logical invitation, at most one active grant per
site/user, no partial audit/delivery row, and no resurrected authority.

### Checkpoint C — edge and every private route

Write failing Worker/Platform tests that prove:

- friendly private alias redirects to permanent UUID;
- only exact `/UUID/access/email` exchange and `/UUID/access/email/sign-out`
  accept a bounded Authorization bearer;
- slug exchange, cross-origin POST, oversized body/bearer, credential query,
  unrelated cookies, malformed viewer cookies, and multiple viewer cookies fail;
- Set-Cookie must match the exact canonical site suffix/path;
- Clerk bearer/cookie never reaches wrapper, frame, form, data, action, or app;
- wrapper, sealed frame, forms/actions, and any private package route deny after
  revoke/mode change/unpublish;
- public and private-link behavior remains unchanged.

### Checkpoint D — management chain and UI

Write failing tests through:

```text
SiteEmailInvitations
 -> shared site client
 -> Gateway owner route
 -> machine-bound Platform route
 -> Postgres invitation/outbox transaction
```

Cover invalid/duplicate/100-address results, keyset pagination, retryable mail
failure, resend, accepted state, stale-revision refresh, revoke failure before
local state clearing, and safe error allowlisting. Re-run PR #3200's placement,
portal, AppViewer, EmbedHost, and one-time-link suites.

### Checkpoint E — lifecycle/export/telemetry

Write failing tests for owner export and deletion, viewer deletion without a
machine, inactive-user webhook, no secrets/hashes/provider payload in export,
and no PII/IDs/URLs/provider details in telemetry.

## 4. Suggested focused commands

Use the repository's existing scripts and exact test paths discovered during
implementation. The expected focused sequence is:

```bash
bun run test tests/contracts/sites.test.ts
bun run test tests/platform/sites-email-invitations.test.ts
bun run test tests/platform/sites-private-routes.test.ts
bun run test tests/platform/sites-edge.test.ts
bun run test tests/platform/sites-renderer.test.ts
bun run test tests/platform/sites-fullpath.test.ts
bun run test tests/platform/sites-management.test.ts
bun run test tests/platform/account-deletion-export.test.ts
bun run test tests/platform/account-deletion-wiring.test.ts
bun run test tests/gateway/sites-platform-client.test.ts
bun run test tests/gateway/sites-routes.test.ts
bun run test tests/ui/app-sites.test.tsx
bun run test tests/desktop/sites-client.test.ts
```

Then run relevant package typechecks, the canonical production shell build,
and the full required suite:

```bash
bun run test
bun run build:shell:production
```

A required lane must fail when its real PostgreSQL, Clerk, browser, or runtime
prerequisite is unavailable; silent skip does not qualify.

## 5. End-to-end acceptance scenario

Use one exact reviewed build and two test accounts.

1. Publish a disposable app and choose Email invitations in the PR #3200 Share
   panel.
2. Invite a new test email and an existing account's verified secondary email.
3. Confirm one authoritative row per address and a real received email.
4. From a clean desktop browser, open the new recipient's email and complete
   Clerk signup on the app URL.
5. Confirm the app loads, one grant exists, and no runtime/machine/billing row or
   onboarding request exists.
6. From a clean mobile browser, authenticate the accepted account using only
   the canonical app URL and confirm access.
7. Attempt with a nonmatching account; confirm coarse denial and no unmasked
   invitation detail.
8. Exercise one declared visitor form/action; confirm owner-only management,
   source, submissions, private data, AI tools, and credentials remain denied.
9. Revoke the accepted viewer and immediately retry wrapper, frame, form/action,
   and direct asset paths; all must deny.
10. Repeat public and private-link journeys to prove no regression.
11. Switch the email site to public/private-link and back; old email grants must
    not return.
12. Export then delete the owner fixture; account for every invitation, grant,
    session, delivery, and audit row without exposing secrets.

## 6. Live visual evidence gate

Capture the exact commit/build and scenario on each affected surface:

- Web Desktop: create/list/resend/revoke.
- Web Canvas: same owner lifecycle in Canvas composition.
- Electron Desktop: same owner lifecycle through its shared client.
- Matrix.page desktop web: new signup, existing sign-in, mismatch, accepted app.
- Matrix.page mobile web: signup/sign-in and accepted app.

Also capture the real email with all addresses, identifiers, and tokens redacted.
State any fixture or bypass limitation. Attach the captures or accessible links
to the PR, post the same evidence with ENG-29 and PR links in Slack `#tech`, and
link the Slack permalink back into the PR. Never commit evidence files.

Native Mobile owner controls remain out of scope; `N/A` still requires the
architectural rationale and reviewer approval. Mobile Matrix.page recipient
access is affected and is not `N/A`.

## 7. Rollout and rollback

Roll out in this order:

1. additive Platform schema and services with capability false;
2. user lifecycle webhook support and mail adapter;
3. Matrix.page edge/gate/exchange;
4. Gateway/shared clients;
5. enable backend capability;
6. integrate/enable PR #3200 row;
7. exact-head evidence and monitored canary;
8. separate public docs PR in `FinnaAI/matrix-os-site`.

Rollback:

1. disable capability and owner control;
2. stop new delivery and exchange admission;
3. revoke affected sessions if security requires it;
4. restore the prior edge allowlist;
5. retain additive columns/tables and historical rows;
6. never narrow the access-mode constraint while a `private_email` publication
   exists and never resurrect revoked grants.
