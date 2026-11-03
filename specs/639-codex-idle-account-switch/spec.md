# Continue an idle Codex Chat after changing accounts

## Goal

An owner can change the selected Codex account while a Chat has no active turn, then send the next message in that same Chat. The Chat retains its transcript and resumes its native Codex thread under the freshly consented account. An in-flight turn is never moved between accounts.

## Journey and acceptance

- Settings completes account change only after the old registered executions stop and fresh consent is saved. An uncertain stop keeps the existing fence.
- On the next message in an idle Codex Chat, gateway verifies fresh owner, current account, consent, old session identity, exact background reference, and confirmed stop. It then starts a new native execution for the same provider thread with the new binding. The user sees the reply in the same Chat.
- If the old execution is active or its stop cannot be proved, no prompt reaches a provider under the new account. The turn reports a safe failure and can be retried after recovery.
- Retrying a failed account transition never starts two executions for one accepted turn. Reload preserves both the transcript and current provider binding.

## Security and wiring

No new route or IPC is needed. Existing Chat send/Settings routes keep their owner authorization, input schemas, body limits, and error mapping. The provider thread store owns accepted-turn and resume state; the Codex admission service owns fresh account proof and the durable execution index. The workspace session manager owns exact background process status. Renew authority only when these three agree under the session start reservation. Recheck at launch and control delivery. Keep private account proof and provider errors out of client responses and logs.

## Failure and resource policy

Bound external observations and process stops. Keep the old binding when proof or binding persistence fails. Once the new binding is durably saved, a failed startup leaves that binding in the same Chat so a later retry can recover without guessing the account. Preserve the durable revocation fence on uncertain cleanup. Existing event and session caps apply. No new temp storage.

## Verification

Regression tests cover idle account switch, same-account consent refresh, active or uncertain old execution, stale/cross-owner references, repeat retry, and settings changes during startup. Run the affected gateway suites and typecheck. Capture the changed Chat journey on each affected Matrix surface from a reviewed preview or staging build before PR review readiness. Recommend product and security review of the account-switch behavior.

Public documentation update: prepare a separate matrix-os-site PR describing Codex account switching and Chat continuity.
