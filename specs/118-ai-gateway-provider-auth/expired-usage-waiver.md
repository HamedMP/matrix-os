# Audited waiver of expired unknown usage

## Contract and authorization

An expired started usage request retains unknown provider cost. Elapsed time,
cancellation and a closed local Chat do not establish zero usage. Ordinary
cleanup and admission recovery do not release its funding. A separately reviewed
operator decision can waive the owner's charge and accept the original captured
provider ceiling as uncertain Matrix expense.

`createExpiredUsageWaiver` is an operator-process dependency with a typed Kysely
connection, not an HTTP, runtime, owner-session or UI capability. The CLI
`scripts/waive-expired-funded-usage.ts` reads one owner-only, single-link regular
0600 review file through a nonblocking no-follow FD, bounded at 64 KiB. FIFOs,
devices and symlinks are rejected before reading. It defaults to a real
read-only repeatable-read transaction and does not run startup migrations. Apply
additionally requires the exact dry-run request fingerprint. Remote database
connections require verified TLS; connection, statement and lock timeouts are
bounded. The database operator credential is the authorization source of truth.
The fingerprinted review explicitly selects `accountDeletionMode`. `configured`
requires the actual deployed `ACCOUNT_DELETION_SECRET` for its admission namespace.
`disabled` requires that secret and enabling flag to be absent/disabled in independently
verified deployment configuration; no namespace is invented. Without a hash secret,
any non-cancelled deletion job globally defers the waiver. Apply first takes a SHARE
lock on the deletion-job table and rechecks this invariant, preventing concurrent
job insert/state change through commit; dry-run uses only its read-only snapshot.
Mismatched or missing mode/configuration fails closed.
No provider token or customer-session impersonation is involved.

## Preconditions and transaction

Pin the owner, machine, primary slot and fresh runtime-token epoch, and enumerate
every reviewed reservation/request/token, start/expiry, original held amount and
source split, captured provider ceiling, raw authorization hash, promotional
allocation hash and prior execution-recovery audit hash. The current machine
must be running, authorized and non-deleted. Account deletion must allow work.
Require usage mode, in-flight status, unknown actual, no settlement/release,
expiry plus ten minutes and at least sixteen minutes since start. No other
nonterminal owner request may remain outside the reviewed batch.

The input accepts at most ten unique records and 50,000,000 microusd total
provider liability. Reviewed released and liability totals must equal the
individual captures. These are independent operator-risk bounds, not changes
to normal model, spending or two-slot admission-recovery limits. The owner's
previously waived, still-unknown Matrix liabilities count toward the same
ten-record and 50,000,000 microusd inventory, validated in bounded reads. A partial
owner index matches `status = 'waived' OR (charge_waiver IS NOT NULL AND
actual_microusd IS NULL)`, keeping the lookup independent of ordinary settled
history while retaining malformed waived-status rows for fail-closed validation.

Waiver lock order is the disabled-mode deletion-job table or configured deletion owner,
then funded owner, machine, runtime policy, sorted reservation rows and balance.
The machine precedes the policy to serialize with existing machine-first policy
updates, which retain their existing authority and optimistic revision guard.
This does not change unrelated authorization or policy-update locks. Exact settlement takes the funded-owner lock
before its reservation lock, preventing a machine-FK lock inversion. Validate
the whole batch before any write. Conflicting snapshots, incomplete/mixed
replays, identity changes and unknown outcomes fail closed. Apply subtracts only
the original aggregate/month-period holds, with guarded amounts. It does not
reset a month, debit funds, grant credit or change policies/epochs/subscriptions.
Ordinary promotional expiry runs after attribution becomes inactive; expired
backing is not resurrected. Released hold is distinct from spendable credit.

## Durable disposition and late settlement

Reservations enter distinct `waived` status with immutable `charge_waiver`
request/response audit bytes, actor, support evidence, reason, fingerprint,
timestamp and accepted maximum liability. Actual cost, settlement and settled
timestamp remain null. The original authorization, source allocations and
admission-recovery audit remain intact. Identical replay returns the original
receipt without another balance release; changed review details conflict.
Authorization/start replay for the old request is fenced permanently.

Host configuration recognizes only a valid, current-owner matching waiver audit
as a closed owner obligation. It remains a pure financial read. Waived unknown
cost is a separate Matrix risk inventory; it no longer occupies either of the
ordinary owner recovery slots. The partial index and recovery queries exclude
the audited waiver rather than interpreting arbitrary null actual as resolved.
Owner admission, funding/checkout projections and execution recovery first validate
the bounded owner-scoped unknown-waiver inventory, including missing/malformed
audits and a false settled label with null actual. A status label alone never
removes these barriers. Known historical expenses need no unbounded admission scan.

Authentic exact late usage must retain original token/request/model/pricing
provenance and fit the captured ceiling. It records actual and an immutable
settlement response with zero owner charge, full Matrix expense and zero further
hold release. It does not touch owner balances, source allocations, monthly
budget, credit ledger or newer execution. Matching late replay is once-only;
conflicting, conservative or above-ceiling receipts are rejected and require
separate investigation, never silent truncation or invented zero. Existing Jev
provenance and evidence-bound manual-review rules remain applicable.

Account deletion defers while waived provider expense is unknown. After valid
late settlement, normal deletion retains anonymous platform-expense count/amount
in the accounting tombstone while erasing account and request locators.

## Migration, delivery and validation

Schema generation 18 adds nullable bounded audit text and the distinct status
constraint, transactionally updates the existing recovery index, and adds the
partial owner unknown-waiver inventory index. Existing
rows stay unchanged. Startup audit validation paginates 100 rows; unrelated
predecessor columns/indexes survive. Older instances skip the newer migration.
Their settlement refuses the distinct status, but their dispatch replay fences
are insufficient: deploy waiver-aware admission, host projection and settlement
on the actual affected control-plane route before applying, and keep that route
on compatible binaries until all waived usage is reconciled. An additive schema
alone is not operational acceptance. Never roll back to a legacy dispatcher or
restore the original recovery-index predicate while null actual waivers remain.

Tests cover real read-only dry runs, identical/conflicting replay, full-batch
atomicity, three old requests/prior audit retention, strong snapshots/source
expiry/month isolation, other-live deferral, dispatch fences, host admission,
late expense/no owner debit, account-deletion deferral/anonymization, additive
generation17 upgrades (including exact predecessor Preview grant columns, indexes
and retained rows) and older revision skips. Disposable PostgreSQL independent
pools must exercise concurrent waiver/replay, exact-settlement and actual
runtime-policy update races in both machine-lock directions. Verify the inventory
index catalog predicate and actual lookup plan against substantial settled history; PGlite
is not concurrency evidence. Run the existing funded usage/recovery, route,
priority, source, deletion, migration and schema-fingerprint suites plus canonical
types/pattern checks. A separate public docs-site PR explains conditional support
behavior without suggesting automatic clearing or existing deployment.

Production apply remains an independently reviewed exact-record dry-run/apply
and before/after accounting/readback operation. Unit/source checks do not prove
deployed capability, actual expense evidence or customer rollout acceptance.
