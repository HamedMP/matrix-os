# ENG-291: Historical starter access recovery

Completed customer-primary activations before the starter rollout can lack funded policy and lifetime credit. The existing bounded customer-VPS reconciliation loop will revisit eligible historical owners without replaying registration or billing.

## Scope and source of truth

- Select running, authorized, undeleted customer-primary machines in bounded keyset pages (maximum 100). Advance past skipped/failed records and reset after the end of the traversal; retain at most one in-flight pass and one cursor.
- Recheck sampled owner identity and historical cohort under the machine lock. An activation authorization timestamp before `2026-10-12T17:00:25Z` identifies the cohort. Legacy records without that timestamp use old provisioning evidence only for candidate discovery. Malformed/newer evidence fails closed.
- Delegate eligibility, ordinary model intersection, missing policy/balance creation and lifetime entitlement issuance to the existing activation initializer. Current platform identity, global/runtime policy, balances and owner-wide lifetime ledger remain authoritative.
- Preserve disabled/expired/incompatible policies, current model selections, token epochs, consumed credit, reservations and shortfalls. Do not transfer replacement-runtime credit or substitute optional promotional campaigns.

## Security and runtime wiring

No new endpoint, public auth surface or credential is introduced; route auth matrix is N/A. The platform-owned background worker calls the existing customer-VPS service, which awaits the historical reconciliation pass. The initializer shares the same transaction and deletion → owner → machine lock order. It revalidates current authorization/status/class/slot and grant provenance while locked. Candidate selection alone never authorizes a grant.

Failures roll back that owner's transaction, emit a coarse failure receipt, advance traversal and retry on a later sweep. Deletion admission blocks grants. Query-level failure is logged without stopping existing provisioning reconciliation. Worker shutdown already drains the awaited service pass before shared database closure. No relay requests or network operations occur in this transaction.

The ledger and policy retain durable issuance provenance. Structured receipts record machine ID, check time and changed/unchanged/deletion-pending/failure outcomes without credentials or owner PII. No new balance authority or audit database is added.

## Acceptance and validation

- The RED completed-owner regression becomes green through automatic recovery; the independent direct-initializer control remains green.
- Repeated and concurrent initialization never issues a second lifetime grant. Native PostgreSQL contention must observe a waiting advisory lock while the winning transaction is held open.
- Disabled, exhausted/partially consumed current and historical entitlements, pending deletion, invalid/newer cohort evidence and non-customer/non-primary/deleted/unauthorized machines remain fenced.
- Bounded traversal progresses past an opt-out or per-owner failure without starving later owners.
- Run focused starter/reconciliation/registration/prebilling suites, type checks, pattern checks and required CI. Recommend product/security/operator review of eligibility and receipts.
- Surface logic is unchanged; all applicable Chat/Settings surfaces consume the same authoritative policy. Future authorized runtime qualification must separately verify a recovered historical owner and a fresh activation with exact release evidence. No live funding/model/deployment operations are authorized here.
- Companion public documentation deliverable: a separate `FinnaAI/matrix-os-site` PR describing automatic historical recovery and unchanged lifetime/opt-out rules.

## Exclusions

ENG-205/ENG-94 general Gateway qualification, #2579 slow readiness probes, #2590 Bedrock work, routing changes beyond existing policy intersection, runtime credit transfers, bulk opt-out enabling, deployment, and merge.
