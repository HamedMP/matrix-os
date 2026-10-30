# Checkout return and activation recovery

Tracking: [ENG-308](https://linear.app/matrix-os/issue/ENG-308/restore-or-abandon-an-open-checkout-after-returning-from-stripe).

## Problem and behavior

An open checkout currently displays subscription activation for ten minutes,
even when the customer canceled or navigated back before completing checkout.
Only a server-confirmed completed checkout should sustain payment settling.
An unfinished checkout immediately opens the existing billing selection and
Resume checkout / Choose different options controls, preserving its selections
and provider session. Confirmed completion must never invite another payment.

On initial boot and explicit Check again, reconcile the authenticated owner's
stored checkout session before deriving the journey. Automatic journey polling
continues to read local state without repeatedly calling the provider. A failed
or ambiguous verification shows a recoverable unavailable state, not fresh plans.
After 60 seconds following confirmed completion, offer support. Check again is
available throughout activation and retries verification. URL success/cancel
flags never establish checkout completion or subscription access.

An ambiguous create retains its original attempt and idempotency key when the
23-hour replay deadline passes, including when processing crosses the deadline
between claim and recovery. Replay ineligibility is an unresolved result, not
proof that the original provider session is safe to abandon. Preparation
unavailability also retains the attempt; only confirmed resolution permits a
replacement checkout.

Additional-computer handoffs retain their existing draft-aware flow: the saved
draft, not the checkout return URL, identifies the new computer's runtime slot.
An already active primary computer must never short-circuit that handoff.

## Auth and persistence

| Route | Auth | Input | Effect |
| --- | --- | --- | --- |
| POST /billing/checkout/reconcile | Existing billing Clerk/app-session identity and account-deletion admission | Strict bounded JSON runtimeSlot | Retrieve only that owner's persisted session, validate provider owner, resolve open attempt to paid/expired |

No client-provided session IDs or provider URLs. Provider lookup uses the existing
10-second client budget outside transactions. Expiration and trial/prebilling
cleanup commit together; a cleanup failure rolls back. Concurrent signed webhook
updates win through the existing conditional write. Completion reconciliation
does not grant entitlement; signed subscription webhooks remain authoritative.
No new checkout sessions, subscriptions, or infrastructure are created here.

## Acceptance and evidence

- Regression tests: open checkout at any age, delayed completion measured from
  confirmation, forged return parameters, ownership/slot isolation, expiration
  rollback, webhook race, provider failure and body limits.
- Client tests: verification before journey read, one provider lookup per mount
  or explicit refresh, auth expiry, retry without payment navigation.
- Verify the running checkout return and activation recovery on Web Canvas,
  Web Desktop, Web Mobile and Electron Desktop. Inspect Native Mobile's existing
  journey consumer for parity and document any runtime evidence blockers.
- Attach exact-build live screenshots and recordings from a PR preview to the
  PR and Slack #tech; local fixture captures do not satisfy that gate.
- Recommend billing/onboarding owner review; requester authorized implementation.
- Public documentation: separate FinnaAI/matrix-os-site PR explaining resume,
  activation confirmation, and recovery. Keep all customer evidence private.

Broader checkout telemetry is deferred. Existing test/runtime access limitations
must be reported, not described as successful live qualification.
