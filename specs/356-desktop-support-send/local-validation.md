# Electron Desktop support validation

Ticket: [ENG-356](https://linear.app/matrix-os/issue/ENG-356/fix-posthog-support-message-sending-in-electron-desktop).
Existing fix: [PR #2818](https://github.com/HamedMP/matrix-os/pull/2818).

## Scope

Revalidate the existing support-client lifecycle repair against current main, preserve the
newer onboarding feature-flag integration, and normalize the platform signing configuration
responsible for the observed provider rejection. The platform change is tested locally but
has not been deployed or qualified by successful authenticated message submission.

## Local evidence, 31 October 2026

- Baseline main: `8de70a4126`; original PR head: `97a66bd179`.
- The original baseline support/flag suites passed 28 checks. Added lifecycle regressions
  failed on account sign-out/sign-in and runtime relay replacement before the repair.
- Added flag regressions failed when gates subscribed to the discarded SDK singleton and
  retained callbacks from the old account. The candidate binds gates to the live client,
  detaches old subscriptions and rejects late callbacks; subscriptions are bounded to eight.
- All 65 focused support, flag, header/CORS, identity and relay checks pass after the repair.
  Desktop renderer/main TypeScript checks and the Electron production build pass.
- React Doctor reports no issues in the changed scope. Pattern scan reports zero violations
  and five existing warnings.

## Live send failure and platform repair

A signed-in local Electron file renderer reproduces a real HTTP 403 with the generic body
`{"error":"Forbidden"}` on the support-message endpoint. The new-ticket request contains
signed identity fields. This is independent of panel rendering.

Approved read-only configuration diagnosis identified a terminal newline in the configured
signing secret. The platform used the raw configuration bytes. A synthetic identity verified
directly against the real provider returned 403 when signed with those exact bytes and 200
when signed with the trimmed key. Invalid-signature controls returned 403. No customer
records, messages or settings were changed. The key itself does not need rotation.

The platform candidate trims surrounding configuration whitespace before signing and treats
a whitespace-only value as unavailable. A focused route module preserves authenticated
subject binding and configuration-error handling. Three named regressions failed before the
repair (two mismatched signatures and a blank-key false success); all seven focused route
checks and 25 related JWT, configuration and Desktop-client checks pass afterward.

The failing local test used a real Electron file renderer and real provider. Successful
synthetic read verification does not qualify authenticated message submission or reply
receipt. Production configuration and deployment remain unchanged. Do not remove identity
verification or weaken authorization to make the request succeed.

A subsequent read-only probe exercised the actual candidate `createAuthRoutes` identity
endpoint, using an ephemeral test JWT key and a random synthetic identity. The route's
returned proof was accepted by the real provider (200); the original raw-key signature and
an intentionally invalid signature were both rejected (403). Missing route authentication
still returned 401. This verifies the production signing code against the real provider;
it does not establish message submission or reply delivery. No customer identity, messages
or tickets were created or read. Tested source: `6f9ee6c962fc4c7cf9f39448eab3765ef93bff3c`.

## Completion checks

- Provider rejection cause confirmed; the local signing repair passes the real-provider read probe.
- Publish the prepared candidate for current-head review and CI, then validate the platform
  repair on a reviewed runtime before promoting a Desktop release.
- Observe a real authenticated send and reply receipt from the final candidate.
- Repeat after sign-out/sign-in and a runtime switch; verify onboarding flags still load.
- Attach exact-build live captures before claiming review readiness. Local unit tests and
  the screenshot of an open panel are not successful-send evidence.
- Complete current-head review/CI and signed release artifact checks before stable promotion.

Recommend review by the Desktop and platform integration owners. No stable release or
production settings change is part of this local validation record.

Additional local canary console findings and repairs: [console-validation.md](console-validation.md).
