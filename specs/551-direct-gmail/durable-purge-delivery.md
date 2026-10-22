# Durable pilot purge delivery

ENG-355; Gmail verification stack2820. Public product disclosures are in FinnaAI/matrix-os-site PR287. This source does not activate a pilot, approve a provider or establish deployed audit readiness.

## Authority and delivery

The platform records a metadata-only command in the same PostgreSQL transaction that invalidates, replaces or erases a consent generation. Profile changes, account revocation, expiry cleanup, Pipedream disconnect and native grant removal preserve the handoff before losing authority rows. Each consent UUID has one immutable command; a newly approved generation receives a new UUID. Pending commands never expire. ACKed records are retained seven days and removed only after their old consent is absent; cleanup is bounded.

A privileged operator pins one exact personal runtime per owner before production Google processing. Pin creation grants no provider access; current account, profile and consent checks still apply. Retargeting fails. Commands snapshot this machine ID; another host cannot lease or ACK them. Unknown historical commands with no target stay unqualified. The authenticated platform middleware supplies the actual machine and original personal owner, and rejects collaborator delegation for this seam. There is no public pin endpoint or automatic approval/retrospective mapping.

| Route | Authentication | Public |
| --- | --- | --- |
| POST /gmail/processing/purge-commands | Current machine bearer, signed owner delegation, exact personal owner and command target | No |
| POST /gmail/processing/purge-ack | Same, plus live exact command/revision/machine/lease CAS | No |

These fixed paths run under the existing internal integration prefix. Body limits and strict schemas reject caller owner selectors, unknown fields and malformed receipts. The only pending-account-deletion exception is these two cleanup paths with verified signed delegation; ordinary mutations remain blocked.

## Bounds and settlement

The registry lock serializes queue capacity and authority writes: 100,000 commands globally, 1,000 per owner, 10,000 operator runtime pins. Queue insertion is batched, not one roundtrip per generation. Cleanup queues at most1,000 generations, locks candidate profiles before consent rows, deletes at most1,000 aged consent/profile records and200 ACKs across two bounded passes. Eligible ACKs are reaped before capacity admission and after consent erasure. Full owners retain invalid rows for retry while other owners can advance; capacity exhaustion does not roll back cleanup or prevent schema startup. PostgreSQL statement/lock limits are5s/2s. The host still owns its shared pool.

Polling leases at most20 commands for60s. A persisted last-polled timestamp rotates unresolved batches fairly; one failed command does not abort other commands unless the cycle is cancelled. SQL uses the database clock; stale/foreign ACKs fail. Exact identical ACK retries are idempotent. A complete receipt means registered-copies-only, pending0/unresolved0 and bounded UUID request IDs. It never certifies unknown imports, arbitrary filesystem copies or processor-side erasure. Account-wide pilot purge conservatively closes all known generations of the requested account; owner-authored intent stays intact.

The runtime poller has one cycle, a60s cancellation budget and30s interval. Its client permits at most four actual transports, a10s signal deadline,64KiB/256-chunk replies and fixed paths. Actual fetch/body cancellation remains tracked after a prompt abort refusal; close waits for real transport and local purge settlement before storage/runtime teardown. A transport must honor cancellation; noncooperative work stays capped and cannot be relabelled drained.

Whole-account deletion erases Google metadata only after the existing verified runtime/provider cleanup gates. A destroyed runtime cannot ACK commands; this is owner teardown, not a fabricated registered-copy receipt.

## Validation and remaining gates

Tests reproduce revocation rollback on failed queue persistence; replacement/profile/expiry/owner erasure handoffs; owner/machine/lease isolation; stale ACK and exact replay; unknown target refusal; concurrent snapshot/cleanup lock order; real native/Pipedream grant mutation composition; incomplete-receipt refusal and deferred transport/body cancellation shutdown. Production runtime pin selection, actual OAuth/provider calls, Linux stop proof, full final CI and five-surface captures remain separate qualification gates.
