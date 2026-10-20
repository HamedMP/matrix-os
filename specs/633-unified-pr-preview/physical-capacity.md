# ENG-325 / ENG-240: physical preview capacity

An unreserved legacy preview can leave the active fleet after logical deletion while its provider server remains billed. The controller must include those tombstones before allocating another runtime.

| Route | Authorization | Input | Result |
| --- | --- | --- | --- |
| GET /vps/preview-capacity | Existing platform operator bearer authority | None | Shared preview rows, including tombstones, and explicit provider-absence proof |

Inventory is bounded to 500 rows, with truncation blocking admission. At most four provider-proof readers share the existing ten-second proof deadline; provider errors make the snapshot unavailable. No proof is cached. Ordinary fleet inventory and runtime health probing remain unchanged. Unknown legacy cleanup pauses new allocations, and a deleted row cannot back a new reservation. Existing per-scope proof, provisioning-job barriers, completed outbox ID checks and provider label absence remain mandatory.

Regression coverage exercises real service deletion/outbox state, operator auth and coarse failures, controller admission/recovery, and preservation of runtime health. Public engineer documentation remains a separate deferred site-repository deliverable after activation.
