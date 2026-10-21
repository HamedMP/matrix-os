# Agent human waiting and cancellation

## Scope

Shared CLI work-inactivity, Claude canonical human controls, managed Pi stop causes and Native Mobile attachment preflight. See specs/633-agent-waiting-policy/spec.md and docs/dev/chat-run-limits.md.

## Contracts

- The shared CLI onStart receives an optional-use idle control. pause/resume affects only work inactivity; absolute deadline, input-write timeout and output budgets continue.
- createCanonicalCliHumanWait tracks bounded type-prefixed approval/input identities. Only resolving the last pending request restarts idle. Close drains state.
- Claude questions have independent 30-minute human TTLs and canonical expiresAt. Synchronously reject overdue submissions even before the timer callback runs. After an on-time validated response claims native delivery, clear the human TTL and rely on the existing bounded stdin write; expiry must not send a second response. Unknown delivery cannot be replayed.
- Managed Pi preserves the first abort source. Its existing absolute deadline maps to reviewed execution_timeout/failed with no automatic retry; Stop and shutdown remain aborted. A late worker result cannot turn cancellation into success.
- Recipe Bot must fence late worker outcomes after explicit user cancellation before accepting a successful reply. Preserve the first stop cause and the separate existing active-deadline completion exception; assert both canonical adapter and durable task outcomes.
- Managed Pi integration approval submission rechecks its existing human TTL after awaiting authority, using internal pending expiry without widening the canonical event schema. Expiry consumes/cancels the wait once and clears its timer/listener before rejecting; delayed timer delivery must not authorize a write.
- Cancellation-aware awaits dispose late inputs/admissions/tools. Release is attempted once. The cleanup wait bound does not prove physical termination: unchanged admission release revokes broker registry authority synchronously before awaiting stopRuntime.
- Native preflight consumes the contracts pure policy with current catalog/model/options before upload/optimistic clearing, including failed-message retry. Preserve picker availability and server admission authority.

## Regression checks

Cover multiple pending requests, provider output while paused, absolute expiry during human wait, synchronous clock advancement without timer delivery, uncertain writes, cancellation ordering, noncooperative worker/cancel/cleanup, late resources, and Native retries after changing source/model/options.

Local tests do not replace current live evidence on each applicable OS view. Keep spending limits, credential validity, worker bounds and upload/output budgets unchanged unless separately approved.
