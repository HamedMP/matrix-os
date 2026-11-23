# Renew private preview managed access

Part of ENG-518. Live Chat qualification is blocked because an expired private
preview allocation returns 401 for funding/readiness, while the operator renewal
endpoint rejects its valid `pv-<PR>-<nonce>` runtime slot with 400. The existing
activation service already supports private-preview machines; its route schema
accepts only legacy `pr-<PR>` slots.

Accept the shared private-preview handle pattern at this activation boundary,
while retaining legacy preview slots. Do not widen provisioning or customer slot
schemas. The existing activation service remains responsible for running preview
classification, owner/machine/slot identity, current token epoch, policy, expiry,
allocation limits, and host configuration. Suggest platform-owner review.

| Route | Authority | Validation and failure |
| --- | --- | --- |
| POST /vps/preview/access/activate | Existing platform operator bearer | 4 KiB body limit; strict owner/UUID/preview-slot/epoch schema; existing 401/400/409/503 mappings |

No new endpoint, credential mechanism, deployment, budget grant policy, database
write path, or owner-data mutation. Existing allocation transactions/owner lock,
bounded expiry, inference caps, host timeouts and resource cleanup are unchanged.
No renderer UI changes; current steering surface qualification remains separate.

Regression: exercise the actual Hono route with a synthetic operator and activation
dependency. Private slot must reach the existing activator and return ready, legacy
slot must still pass, and unauthorized/malformed/oversized requests must never
dispatch. Red: valid private slot returns 400; green: both preview forms accepted.
Run the real allocation/lifecycle suites too. Restore live access only through a
reviewed platform runtime, then observe readiness and actual inference; local route
tests do not qualify deployment or paid inference. Public documentation follow-up
belongs to matrix-os-site PR #368. This PR does not deploy production.
