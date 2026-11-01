# ENG-205: recover terminated execution under a $20 liability ceiling

## Problem and behavior

The former owner-wide two-record/$0.50 recovery limit can keep a third failed
request occupying execution admission even when Relay has supplied a trusted
terminal receipt. Repeated failures then prevent the owner from starting work.

Replace that product record-count limit with a $20 (20,000,000 microUSD)
owner-wide ceiling on captured maximum unresolved liability. Exactly $20 is
allowed; another unresolved request that exceeds it stays held. This is not a
credit grant, spending budget increase, refund, or declaration of zero usage.
Existing balance, monthly budget, model policy and one-live-execution checks
still apply.

## Authority and atomicity

- PostgreSQL reservation records, immutable terminal/recovery receipts and the
  captured authorization ceiling remain authoritative.
- Automatic recovery requires the existing Relay execution-bound terminal proof
  or the existing expiry/age grace for legacy proof. Unbound client errors are
  insufficient evidence. Machine ownership, activation and runtime checks stay.
- Single/operator batch recovery retains its existing operator authentication,
  input validation, age checks and immutable replay behavior. The batch wire
  shape remains limited to two records per request; it is independent of the
  accumulated owner inventory.
- The existing owner advisory lock and transaction cover validation, liability
  summation, free-slot allocation and recovery writes. A corrupt receipt or
  another live operation prevents recovery. No provider/network call runs
  inside that transaction.
- Recovery preserves financial holds, unknown actual usage, promotional
  allocations and settlement responsibility. Late exact settlement and audited
  charge waiver remain separate paths.

## Schema, resources and rollback

Schema generation 24 widens `execution_recovery_slot` from SMALLINT to INTEGER
and replaces `IN (0, 1)` with a nonnegative check in the locked migration.
Unresolved owner/slot uniqueness and one-live-execution uniqueness remain.
The migration validates existing receipts and the new liability bound before
changing constraints; invalid legacy data rolls the transaction back.

The reviewed predecessor PR #2886 (`2cc608b90a5a08ede5fe61551a60cfcd816421aa`)
allocates generation 23 with fingerprint
`588aa2cb52e99cfd8d48cf0ddd92f5f663aa266f2a5a1b40b099f7b92af5d3f0`.
Its core DDL matches generation 22; its separate deployment wiring is retained
when composing the changes. That PR landed as `27740ebf4416e93b8fe762e5e6c98222d34a091e`;
this branch retains its deployment wiring. This recovery change uses
generation 24 so startup never reuses its generation with a different schema.
Test upgrades from both exact predecessor markers; old-generation startup must
skip DDL after the upgrade without rewriting receipts or balances.

Inventory validation and terminal candidate scans use 100-row keyset pages.
Free-slot allocation stays in SQL, so process memory does not grow with the
owner's record inventory. There is no 100-record product limit. All terminal
candidates are validated before any recovery write.

Old binaries still enforce two/$0.50 and must not be used after new-capacity
records exist. Coordinate Platform and its database-sharing workers at the
same schema revision. Rollback requires reconciling outstanding records to
the older bounds first; never delete receipts or release money to force it.
This source change does not authorize or perform production rollout.

## Verification and delivery

Regression tests exercise the original third-request failure, 105 unresolved
records, a corrupt receipt after the first page, settled-slot reuse, exactly
$20 and one microUSD above, operator replay, schema-22/23 upgrades, and independent
PostgreSQL-pool races. Financial snapshots must remain unchanged by recovery.

Deliver a separate public-documentation PR in `FinnaAI/matrix-os-site` describing
execution recovery and continued unknown-cost holds. Recommend engineering and
funding-owner review of the ceiling and the rollback restriction. No new route,
credential, permission, price, or model allowlist is introduced.
