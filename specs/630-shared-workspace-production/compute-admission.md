# U4: Compute admission and lifecycle accounting

Parent decision: [production rollout](./spec.md). Ticket: [ENG-319](https://linear.app/matrix-os/issue/ENG-319/ship-shared-workspace-alongside-personal-vps-runtimes).

## Behavior and authority

Saved OS APIs remain usable with no compute policy or exhausted allowance. Existing personal VPS routing, billing and ownership checks stay authoritative. Shared execution requires an explicitly provisioned active compute account and current Postgres policy. No default grant, browser plan label or inference credit enables compute. Server-only account suspension/deletion cancels unclaimed admissions and requests reconciliation of active work; this layer adds no account-management HTTP endpoint and does not implement full owner-data erasure.

Admission locks the owner row, checks placement and account, reserves the maximum task duration, persists canonical Chat input and inserts a durable Queue outbox in one transaction. Retries compare the original request fingerprint, including the requested Chat. Queue sends happen after commit. Unacknowledged sends remain retryable; duplicate delivery never executes twice. Queue and runtime both verify the stored admission; a Queue payload alone is not execution authority. Pending entries have an expiry and per-owner cap.

Runtime claim and successful completion share the lifecycle transaction with their accounting hook. Charged time runs from claim through startup, inference/tools, task checkpoint and output publication. It is capped at the original hold. Idle grace, post-task idle checkpoint overhead and provider billing granularity are platform overhead in this layer, so this ledger is an allowance meter rather than a provider invoice. Queue waiting is uncharged. Interrupted work retains its full hold until native destruction is confirmed, then consumes that hold conservatively. An expired lease or failed RPC never refunds uncertain work. Settlement is immutable. A new generation cannot settle or cancel unrelated replacement work.

Durable alarms renew work through model/tool waits and client disconnects. Server account revocation prevents heartbeat renewal. Scheduled reconciliation re-arms owner alarms and retries pending delivery; the owner/generation fence is acquired before destruction. Unknown native termination stays quarantined and held. Cancellation does not imply that a user action or external tool side effect was rolled back.

Confirmed destruction persists a terminal `interrupted` outbox outcome separately from its settled reservation. Exact replay returns HTTP 409; only successful completion returns `completed`/200. A new attempt needs a new idempotency key. Initialization atomically upgrades both outbox checks on existing databases with bounded DDL lock/statement timeouts; repeated initialization preserves rows and avoids taking a DDL lock once upgraded. Apply the schema upgrade before running the new runtime code. Previously recorded `completed` rows are not reclassified without authoritative outcome evidence.

## Auth matrix

| Boundary | Authority | Public | Validation/limits |
| --- | --- | --- | --- |
| Existing workspace action | Verified owner token; server compute account/policy | no | Existing body limit and discriminated action schema; atomic admission |
| Queue consumer / runtime claim | Exact committed owner/job payload and held reservation | no | Canonical bounded IDs; one active owner job; hard execution deadline |
| Policy/account provisioning | Trusted operator/server Kysely call | no | Explicit current period; no user-controlled plan mapping |
| Reconciliation RPC | Cloudflare service binding; persisted owner placement/generation | no | Bounded scan; only pooled compute; no saved-data mutation |
| Existing personal VPS | Existing platform ownership/session authority | no | Unchanged production routing |

## Execution units

- Storage (test first): `data/compute-admission*.ts`, transactional budget helper, admission tests. Atomic rollback, independent-pool races, denied/expired/missing policy, spoofing, replay, outbox retry, revocation and conservative settlement. Separate named worktree.
- Wiring (test first): Worker composition, routes, runtime-store hooks and lifecycle confirmation. No Chat write before budget admission; settlement failure rolls completion back; failed destruction retains quarantine; personal placement has no side effects.
- Qualification: isolated Cloudflare Worker, Queue, Durable Object, R2, Hyperdrive/Postgres and actual Matrix gateway/Haiku. Save/destroy/restore session continuity, task-time hold/settlement, duplicate admission, exhausted reads and disconnected work. Destroy all owned test resources afterwards. Separate operator workspace, secrets outside Git.
- Documentation: update the separate private `FinnaAI/matrix-os-site/content/docs` documentation PR with measured behavior and explicit preview limits.

File ownership separates the units. Dependencies: storage and wiring integrate before remote qualification. No production rollout or customer migration is part of this PR. Production owner credentials, full file/app synchronization, owner-data export/deletion, billing entitlement hooks and all-surface placement UX remain subsequent rollout gates.
