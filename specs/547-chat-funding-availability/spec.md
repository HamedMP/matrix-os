# Ordinary Chat funding availability and actionable failures

Issue: ENG-114. This change corrects two related user-visible failures: Settings can show speech-only allowance as Chat credit, and a managed Chat authorization rejection can become a generic worker failure.

## Funding truth and compatibility

Platform Postgres remains authoritative. A negotiated, independently versioned `chatAvailability` projection reports eligible ordinary Chat funds and funds available after durable reservations and shortfall. Exclude expired promotions and speech-only grants. Preserve all financial holds, including unknown historical executions. Do not release reservations to improve the displayed balance.

Calculate the projection in the existing funding-summary transaction, acquiring the owner advisory lock before machine/balance/grant locks. Keep the legacy v1 aggregate summary and managed-credit arithmetic unchanged. Opted-in Settings clients receive the new projection; legacy snapshots and mutation responses omit it. A bounded fallback to a legacy platform must yield unknown Chat availability, never assume that aggregate credit is spendable for Chat. Validate observation consistency and freshness before use.

The shared Settings display uses ordinary Chat availability capped by remaining monthly budget. Display only the Chat available balance, without voice-credit explanatory copy. An absent or stale projection has an explicit unknown state. Total ledger credit is separate from ordinary Chat spending capacity; never estimate speech allowance by subtraction. Web Desktop, Web Canvas and Electron Desktop use the same projection and display derivation.

## Safe run failure propagation

Only authenticated, strictly parsed Platform failures may become `insufficient_credit` or `budget_exceeded`. Relay and gateway carry these allowlisted reasons through a dedicated internal diagnostic path. Managed Pi attaches them only to the matching active owner, Chat, run, runtime and generation. Do not classify SDK error strings or infer a past failure from a later balance.

Preflight distinguishes unavailable funds, reserved funds, monthly budget exhaustion and unknown readiness. Canonical terminal notices display safe actionable copy and preserve the recorded reason on reopen. Unknown provider/network failures retain generic copy. Shared notices cover the supported Web and Electron presentations and Native Mobile Chat. No raw provider, database, path or credential details reach users.

## Auth matrix and boundaries

| Route / boundary | Authority | Public |
| --- | --- | --- |
| Existing runtime funding-summary POST | Runtime credential scoped to owner, machine and slot | No |
| Existing provider Settings GET and mutations | Existing gateway owner authorization | No |
| Existing funded relay authorization | Authenticated relay control-plane credential | No |
| Broker failure diagnostic | Trusted managed route plus exact active execution binding | No |

No new unauthenticated endpoint or user-controlled diagnostic header is accepted. Existing body limits, bounded schemas, external-call deadlines and resource caps remain applicable.

## Validation and delivery

Write failing regressions before implementation: speech-only/expired/held funding, conservative legacy reservations, budget caps, negotiated/legacy snapshots, stale observations, safe relay/broker reasons, runtime binding isolation, generic-error fallback and shared notice parity. Run required type, pattern and unit checks.

Publish an English implementation PR linked to ENG-114 and a separate documentation PR in `FinnaAI/matrix-os-site`. Prepare an exact-head Preview VPS and Electron Desktop for Human Review. Record client commit, installed/running host bundle, Platform/Relay revisions, actual fresh/resumed Chat outcomes and no-credit/budget notices. CI and simulated notice tests do not establish live acceptance. Stop before Greptile review and merge pending explicit human approval.

Operational grants and temporary policy changes are separately authorized support work, not part of this product patch. Never include customer identifiers or secrets in public evidence. Settlement recovery, unknown hold refunds, plan changes and global funding-policy changes remain deferred.
