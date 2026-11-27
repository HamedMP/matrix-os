# Confirm recovered Chat submissions immediately

Ticket: [ENG-522](https://linear.app/matrix-os/issue/ENG-522/perfchat-faster-send-to-first-progress-on-web-and-electron-desktop)

PR: [#3603](https://github.com/HamedMP/matrix-os/pull/3603)

## Problem and behavior

After an ambiguous send response, both canonical clients authenticate the exact
original request through the admission lookup. Recovery then awaited an optional
transcript GET, leaving submission acknowledgement pending despite a proven
durable receipt. A visible optimistic message did not establish acceptance.

Recovery now returns the validated receipt immediately. It performs no optional
transcript read, starts no background request, and adds no timer. Normal UI detail
refresh hydrates the transcript independently. The UI layer below this PR must
refresh after every admitted turn, including already-completed recovered turns,
without delaying composer acknowledgement.

## Boundaries and invariants

- Keep the authenticated lookup, original request hash, exact Chat/request ID,
  message parts, user role, first run, and admission schema validation.
- Never replay a potentially admitted POST as part of recovery.
- Invalid receipts and unavailable lookup endpoints remain uncertain.
- Keep the optional client-only `recoveredDetail` type for existing consumers;
  this recovery helper no longer produces that enrichment.
- Add no endpoint, database write, transaction, auth policy, or public API.
  Existing canonical endpoint authentication remains authoritative.

## Tests and retained protection

The regression exercises the production Web and Electron clients with a lost
POST response, a valid authenticated receipt, and a transcript read that would
remain unresolved. It requires acknowledgement without reading that transcript
and exactly one POST. The one-second fake-clock advance is a test guard, not a
new product wait budget.

Red on `58bd4eb03`: the recovery suite had 42 passing cases and two intended
failures, both observing an undefined acknowledgement while optional detail
waited. The focused rerun reproduced both failures. Raw logs stay outside the
repository at `/tmp/chat-receipt-red.log`.

The former optional-detail-failure and stale-detail tests protected enrichment
that has been removed. Their acceptance/no-stale-overwrite protection is retained
more strictly by the regression's zero transcript reads and absence of
`recoveredDetail`; keeping those fixtures would no longer exercise production
behavior. Exact receipt, original-hash, legitimate execution overrides, missing
lookup, definitive rejection and no-replay cases remain unchanged.

Validation includes the production-client recovery suite, shared admission
tracker tests, client suites, typechecks and pattern checks. The UI dependency
must additionally prove eventual completed assistant hydration without blocking
the composer. Web and Electron live-flow captures qualify the combined change;
test results alone do not satisfy that evidence gate.

## Documentation and review

Review the public documentation deliverable in the separate site repository.
No public docs PR is needed for this internal recovery scheduling correction:
there is no new command, configuration, protocol, or user-facing workflow to
document. This spec records the implementation boundary and regression evidence.

Recommend Chat engineering/product owner review of the acknowledgement boundary.
Keep the PR draft until its UI dependency, current-head Greptile 5/5, live
evidence, and CI gates are satisfied. Do not merge as part of this task.
