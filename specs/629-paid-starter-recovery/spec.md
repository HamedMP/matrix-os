# ENG-205: reviewed paid-primary starter recovery

The operator may recover a missing standard $5 lifetime starter entitlement for
an explicitly approved private cohort of at most three converted active paid
customer primaries. This is a bounded support operation. It is not a historical
sweep, a new campaign, or an additional grant for an owner who already received
general Chat credit. Private customer identities and the actual reviewed cohort
must never appear in source, tests, public documentation or PR text.

## Scope and authority

- A protected, owner-only JSON manifest names the exact owner, machine, primary
  slot, current runtime epoch, database image version, subscription ID and billing
  update time. It includes source SHA, approval reference and at most five minutes
  of validity. Reject extra fields, duplicate JSON keys, owners or machines,
  changed binding, missing authority and an expired/future manifest.
- The database image version is a row-change guard, not installed-source
  attestation. Reviewed operator source/dependency provenance is checked
  independently before actual use. No host credential, SSH or provider request
  is needed to initialize the central policy and ledger.
- Dry-run is the default and performs no persistent writes or migrations. Apply
  requires its fresh state fingerprint and an exclusive private journal created
  and synced before any database mutation. An ambiguous database commit or
  pending journal must be reconciled from authoritative reads, never retried
  automatically. No private database URL, tokens or customer content is printed.

## Admission and preservation

- Freshly require a running, authorized, undeleted customer primary with unchanged
  exact owner/epoch, no pending account deletion, and an exact active paid
  subscription with converted trial, recognized price, future paid period and
  valid current effective billing entitlement. Running/authorized state, a grace
  timestamp, an override or raw status alone cannot establish paid eligibility.
- Use the existing effective billing authority and independently inspect the
  locked subscription's trial lifecycle. Failed unconverted payments, trial-only,
  expired/cancelled, override-only and changed billing defer unchanged.
- Require missing runtime policy and no owner-wide prior general Chat grant of
  any source, including spent/expired grants and prior grants on another runtime.
  Reuse canonical lifetime/legacy provenance checks. Never infer eligibility
  merely from an absent lifetime entry ID, and never refill consumed credit.
- Preserve existing speech-only credit, grant allocation, user model selections,
  policies, reservations, shortfalls, restrictions and token epochs. Any existing
  policy, unknown/pending usage, financial freeze/debt/hold/shortfall or changed
  global model policy defers the frozen reviewed operation. Do not convert speech
  credit to general credit or create a waiver/credit reset. Existing aggregate
  money must reconcile exactly to nonnegative, ledger-backed speech allocations
  with zero add-on balance; unexplained aggregate money defers the operation.
  The earliest paid-period or positive speech-allocation expiry bounds every
  initializer call and the final commit decision, so expiry while waiting cannot
  cause the shared initializer to retire speech credit during recovery.
- Reuse the existing lifetime initializer unchanged for the actual missing
  policy/balance/grant writes. All targets' guarded writes share one outer
  transaction, so an invalid target or later initializer failure commits nothing.
  The standard amount and canonical once-owner lifetime identity are not CLI
  options. Models are the ordinary intersection with live global policy; no new
  route/model/default/campaign activation is included.

## Transaction and consistency boundary

Deletion mode is always explicit. `enabled` requires the actual configured
deletion secret and rejects disabled-mode authority. `disabled` requires that
`ACCOUNT_DELETION_SECRET` be strictly absent, not empty or malformed, and actual
`ACCOUNT_DELETION_ENABLED` be absent or literal `false`; true, unknown and empty
values fail closed. It also
requires a reviewed `disabledDeletionAuthority` tuple containing servingRevision
and immutable sha256 imageDigest. Both must exactly match the operator-only
`MATRIX_PAID_STARTER_RECOVERY_PLATFORM_REVISION` and
`MATRIX_PAID_STARTER_RECOVERY_PLATFORM_IMAGE_DIGEST` attestations from a fresh
authenticated serving-configuration read. These values attest the current
absence; they do not turn a production feature on or off.

Disabled mode additionally requires ZERO deletion jobs globally: any record,
including a cancelled/completed or unrelated-owner record, defers unchanged
because the absent hash namespace cannot safely bind jobs to the reviewed owner.
The global absence must be read fresh after funded-owner admission and before
mutation, and a newly present job between dry-run/apply invalidates admission.
The normal product cannot schedule deletion without its absent secret; independent
administrative SQL remains the explicitly coordinated point-in-time boundary.
No new production feature gate, secret, API or automatic fallback is introduced.

Use existing account-deletion and funded-owner admission before machine writes,
acquire multiple owners in deterministic order, and lock existing authoritative
subscription/entitlement/override and financial rows consistently. Compare the
dry-run state fingerprint again under apply locks and check expiry after waits
and before writes. Do not claim a funding advisory lock serializes billing
writers that do not use it. Document row-lock coverage, possible insert phantoms
and transaction isolation/retry behavior in the implementation; fail closed on
lock conflicts rather than retry a credit mutation invisibly.

The operator transaction uses READ COMMITTED. A repeatable/serializable snapshot
could be established before waiting on deletion's advisory lock and miss a job
accepted while waiting. Fresh admission queries run after that lock returns;
deletion and funded-owner locks remain held through every initializer write.
Existing subscription, entitlement, override, machine, restriction and balance
rows are locked on apply. Current product billing writers sharing the configured
deletion namespace serialize there; independent support override inserts or
out-of-band SQL do not acquire that lock and remain a point-in-time consistency
limit. No universal exclusion of arbitrary administrative writes is claimed, and
no global billing table lock is introduced. Coordinate support overrides during
the short reviewed operation; an unexpected conflict requires new inspection.

## Wiring and auth matrix

| Surface | Authority | Behavior |
| --- | --- | --- |
| Operator CLI | Existing private database access, protected manifest, exact reviewed source and explicit apply hash | Bounded dry-run/apply; no migrations |
| Owner/host/Relay API | None added | Existing runtime and funding admission unchanged |
| Background jobs | None added | No general recovery sweep or new controller |

The CLI closes only its owned database resources. Input reads reuse the reviewed
protected operator reader from the legacy host-recovery change once merged.
No additional Platform endpoint or production redeployment is needed solely to
expose this operation. Parent task owns production execution after merged source,
required GitHub CI and current-head Greptile 5/5; this spec alone does not execute
or authorize an expanded cohort.

## Validation and documentation

Tests precede implementation. GitHub CI only runs unit/protected-input tests and
a required disposable PostgreSQL target demonstrating concurrent once-owner
admission, lock order, billing change during admission, expiry after a lock wait,
rollback after policy insertion and unchanged speech credit. No local tests,
builds, typechecks, dependency installs or Docker are permitted for this task.
Regression coverage includes invalid cohort/source, prior/consumed general grant,
deletion, failed-unconverted payment, policy opt-out/expiry, unknown usage,
financial restrictions, stale review and no-secret failure output.

A separate public-safe documentation follow-up in FinnaAI/matrix-os-site explains
eligibility and recovery boundaries without identifying customers or claiming
all existing/future runtimes repaired. This operator-only change adds no visual
surface; actual customer funding readback and request acceptance are separate
operational evidence, not inferred from test results or successful grants.

Links: ENG-205 (verified parent task), related ENG-291 / held PR2613 for context.
PR2613 is not an implementation dependency or authority to activate a sweep.
