# Direct entry to billing

## Goal

New signed-in users who need a plan go directly to billing without the
“Choose your plan” interstitial or its “View plans” button.

## Behavior

- When the authenticated journey is ready and reports `plan_required`, replace
  the current browser location with its `nextAction.url`.
- If the URL is omitted, use the existing local billing entrypoint `/?plans=1`.
- Show the shared loading screen during navigation. Do not render the removed
  interstitial or expose the authenticated shell before billing.
- Keep authentication recovery, payment settling, provisioning, and ready
  sessions on their existing paths.

## Surfaces

The shared browser onboarding gate runs before Web Desktop, Web Canvas, and
Web Mobile. Electron Desktop and Native Mobile keep their existing device
authentication flows, which already enter through BillingGate.

## Acceptance and risks

- Regression tests prove automatic navigation, destination preservation,
  missing-URL fallback, and no redirect during payment settling or auth failure.
- Existing onboarding and billing tests verify that `/?plans=1` enters BillingGate
  rather than looping through the startup gate.
- Verify the signup-to-billing journey in a PR preview before review readiness.
- Product/design review of the shortened journey is recommended; the requester
  has authorized removal of the interstitial.
- Follow up with a separate documentation PR in `FinnaAI/matrix-os-site` if its
  signup guide describes the removed button.

No endpoint, authorization policy, persistence, or payment mutation changes.
The authenticated journey remains the source of truth.
