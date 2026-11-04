# Relay shutdown and candidate isolation follow-up

Tracking: [ENG-205](https://linear.app/matrix-os/issue/ENG-205/matrix-ai-is-unavailable).
This follows the merged terminal-recovery source in #2812 and #2807. It is not
another execution-slot recovery or authorization to deploy production.

## Problem and intended behavior

The dedicated Relay entrypoint exits after six seconds, while its active-work
barrier may wait ten seconds, followed by settlement-queue and telemetry drains.
A five-second transport timeout followed by a successful two-second retry can
therefore be interrupted before the terminal acknowledgement arrives. Cloud Run
provides ten seconds after SIGTERM before SIGKILL. The entire shutdown must fit
inside that window; giving each successive phase a fresh timeout cannot do so.

Separately, the release workflow currently moves the shared `candidate` tag when
constructing an unaccepted revision. Old Hosts may persist that URL indefinitely.
Zero default traffic does not isolate those callers, the database, accounts,
financial reservations, or other service writers.

## Bounded shutdown

- Stop new admission and close the listener immediately on the first signal.
- Create one nine-second work deadline. Cancellation acknowledgement, terminal
  and exact-finalization retry, queue closure and telemetry share its remaining
  budget. A separate 9.5-second process guard is only an emergency exit bound.
- A recoverable five-second timeout plus two-second terminal retry can complete
  within that common budget. Preserve the immutable receipt across retries.
- A blocked cancellation, terminal request, backlog or telemetry operation must
  not extend the common deadline. Return an explicit incomplete outcome and exit
  unsuccessfully when confirmation is absent. A bounded wait is not an ACK.
- Deadline expiry must not generate a terminal proof without confirmed original
  cancellation, zero-cost finalization, financial release, refund, waiver, new
  reservation, replacement execution or another upstream dispatch.
- Preserve ordinary running-request limits, prices, policies, existing
  recovery liability ceiling and Platform's accounting authority. The current
  $20 policy is specified in [recovery capacity](./recovery-liability-capacity.md).

## Candidate construction and promotion

- Derive `relay-<first 12 characters of full source SHA>` from a validated
  40-character SHA. The operator cannot supply an arbitrary tag.
- Construction must preserve default traffic, the legacy `candidate` alias and
  every unrelated tag. Refuse an existing derived tag before rebuilding or
  moving it; uncertain outcomes must be inspected rather than blindly retried.
- Require the same derived tag, full source label, exact revision, immutable
  image digest and actual zero default traffic in candidate verification.
  A matching SHA prefix alone is insufficient.
- Retain the existing main-source, genuine ten-check acceptance, current price
  review, numeric production Secret-version, configuration and resource gates.
  Neither a local fixture nor a successful evidence import establishes live GA.
- Promotion reuses the exact accepted candidate through the normal guarded
  workflow. Preserve legacy aliases; existing-Host migration remains a separate
  reviewed action. Default promotion alone does not mean every Host uses the
  repaired Relay.
- Account/database isolation, writer coordination, metering, health and rollback
  evidence remain required. Tag isolation does not establish financial isolation.
- Staging retains first-dispatch promotion. A later dispatch for an already
  occupied same-source tag refuses before build or traffic mutation; two-dispatch
  staging reuse is deferred. Production reuses its accepted candidate.

## Verification

Write failing tests before implementation, then exercise the shared deadline,
queue replacement/idempotency and workflow verifier. Required cases include:

1. Recoverable terminal ACK near seven seconds, with one upstream dispatch.
2. Never-acknowledged cancellation or terminal transport: bounded incomplete
   shutdown without financial mutation or an invented terminal receipt.
3. Serial queue/telemetry work cannot restart the shutdown budget.
4. Late ACKs and old queue callbacks cannot settle unknown usage or release a
   newer execution, and admission never reopens.
5. An old `candidate` alias may have traffic while the new owned candidate has
   none. Existing derived tags, prefix collisions, moved tags and provenance or
   configuration drift fail closed.
6. Production and staging retain their respective credential and acceptance
   requirements. Test metadata remains explicitly synthetic.

After source tests, rebuild and run the actual dedicated entrypoint in an
isolated synthetic process. Retain exact source/build provenance and limits of
native-process evidence. A local run does not replace Linux/Cloud Run, real
database durability or live Chat/Bot/surface-parity qualification.

Public documentation remains the separate
[site PR #284](https://github.com/FinnaAI/matrix-os-site/pull/284), held until its
core qualification prerequisites are met. This backend-only follow-up changes
no user interface; existing live Gateway/surface gates remain open.

## Release boundary

No account, credential, IAM, quota, price, production configuration, fleet,
financial record or serving traffic is changed by preparing this source. Submit
the reviewed source, exact candidate and remaining approvals to the main
conversation before proceeding with production execution. Keep unknown usage
and financial holds intact through acceptance and rollback.
