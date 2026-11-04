# Data model: collaboration preview pairs

Tracking: ENG-418. Production persistence is Platform Postgres through Kysely.
The owner databases retain project, grant, inventory and Chat authority. Fixtures
below are dedicated test identities, never copied customer data.

## PreviewPair

- `id`: generated UUID; repository fixed to `HamedMP/matrix-os`; positive PR <=999999999.
- `requester_id`: verified requesting maintainer; non-empty bounded actor ID.
- `source_sha`: full lowercase 40-character candidate SHA verified against the open PR.
- `generation`: positive integer, capped at 999; `revision`: monotonically increasing.
- `state`: `queued | preparing | ready | updating | failed | cleanup_pending | stopped`.
- `outdated`: separate current-head observation; never changes the tested source.
- `fixture_id`: nullable only while queued; references the canonical fixture set.
- `created_at`, `expires_at`: immutable lifetime <=72h; replay never extends it.
- `requested_source`: nullable next SHA for explicit reset/update.
- `failure_code`: bounded allowlisted stage/failure code; no raw error strings.
- `claim_id`, `claim_expires_at`, `attempt`, `next_attempt_at`: bounded durable worker lease/backoff.
- `stopped_at`: present only after access retirement and physical cleanup proof.

Unique partial index on repository/PR for non-stopped pairs; idempotent start uses
`ON CONFLICT` and returns the existing active pair. A new requested SHA marks it
outdated; it never silently installs that SHA.

## PreviewPairFixture

- Stable configured `id`, dedicated `owner_actor_id`, `member_actor_id`,
  `outsider_actor_id`, `organization_id`; first two are distinct current members,
  outsider is distinct and not a member.
- `active_pair_id`: nullable exclusive lease and `revision` for guarded changes.
- Config parser rejects duplicate actors/organizations across the pool, personal
  customer fixtures, missing expected Preview identity issuer and >8 fixture sets.
- Existing leased fixture identities cannot be edited/reassigned by config refresh.

A fixture is released only after every member of its leased run is physically
removed. Baseline identities and organization configuration survive pair teardown.
Fixture credentials are never stored in these tables or the manifest.

## PreviewPairGeneration

- Composite identity `(pair_id, generation)`; immutable source SHA and artifact
  provenance, exact platform browser/API origins, identity issuer and approved
  service/signing/data binding evidence.
- Explicit `data_policy=reset`; immutable host bundle version/digest and desktop
  artifact records keyed by supported operating system/architecture.
- `prepared_at`, `ready_at`, `retired_at`; environment, local session and product
  acceptance are distinct observations, never one optimistic status flag.
- Origin and artifact records are strict validated JSONB with bounded entry counts.

An update retires the prior generation before a new one can become ready.
Previous evidence stays attached to its original source and identities.

## PreviewPairMember

- Composite key `(pair_id, generation, role)` with role exactly `owner | member`.
- Canonical actor, machine UUID, server-derived handle/slot, provisioning job UUID.
- Foreign keys to the generation and actual `user_machines` / provisioning job.
- Expected host source/version; observed running source/version, fresh enrollment
  generation/time and bounded readiness checks. These observations never establish
  collaboration grants or organization membership by themselves.
- Provider server ID/label evidence, `retired_at`, `provider_absent_at` and capped
  cleanup failure/attempt fields. Absence must be proved after the latest mutation.

Both member rows, canonical machine rows and encrypted durable jobs are prepared
inside the admission transaction. Provider dispatch occurs only after commit.
Handles use `cp-<pr>-<run8>-<generation>-a|b` and fit the existing 32-character slot
limit. Persisted Preview class and actual membership establish authority; malformed
reserved-prefix rows fail closed for personal-account access.

## Manifest and local context

The canonical manifest is a derived view of one live ready generation, not a second
persistence/authorization system. It contains schema version, pair/PR/SHA, lifetime,
currency, two roles and expected identity/machine/slot, org, fixed origins, component
provenance, supported desktop artifacts and safe report links. Max64KiB; no bearer,
password, session cookie, private key or SSH material. A local copy is compared with
the authenticated canonical generation before use.

Each launcher-owned local profile has a non-secret ownership marker binding
pair/generation/role and a bounded context file. The existing Electron credential
store owns credentials. Temporary downloads/extraction are cleaned on failure;
profile deletion is explicit, scoped and symlink-safe. Live child handles own
termination; persisted numeric PIDs confer no kill authority.

## State transitions and concurrency

```text
queued -> preparing -> ready
preparing -> failed -> cleanup_pending -> stopped
ready -> cleanup_pending -> stopped
ready(outdated) -> updating -> cleanup_pending(old generation)
  -> preparing(next generation, clean reset) -> ready
any live state -> cleanup_pending  [stop / close / request removal / hard expiry]
```

Admission takes a transaction-scoped pair lock and sorted existing owner locks.
Claims use a single conditional update/row lock and an expiring random claim token.
Every completion includes pair ID, expected generation/revision, claim token and
state in its write. Stale callbacks are no-ops/conflicts, never resurrection.
Stop invalidates manifests before external deletion. Capacity and fixture leases
remain occupied while cleanup is pending or provider absence is unknown.

## Retention and ownership

`preview_pair_cloud_intents` is source-owned and precedes any candidate cloud
publication. Its primary key is full pair UUID/generation; immutable fields bind
PR, verified requester, controller run, full SHA and source-profile fingerprint.
States are `prepared`, `adopted`, `cleanup_pending`, and `stopped`. It has no foreign
key to a not-yet-created pair and reserves no fixture. A two-hour publication
window never extends on replay and is capped by the hard expiry during updates.
The shared admission transaction lock serializes adoption against cancellation;
adoption rolls back with failed pair/job writes. Only exact retirement can move a
cancelled request to `stopped`; expiry by itself is not proof of cloud absence.

The publication journal stores its nonce, immutable image digest, finite state
(`unissued`, `issuing`, `accepted`, `rejected`) and optional exact operation receipt.
The conditional transition to issuing commits before the one cloud mutation;
unknown outcomes never authorize another effect. A late acknowledgement can
invalidate obsolete cleanup claims without reopening a cancelled request. Legacy
records with no digest remain retireable and cannot authorize new admission.
Private receipts are omitted from request reports. Bounded claims/backoff permit
recovery; retired identities remain tombstones rather than reusable request IDs.

- Live pairs expire no later than72h; stopping revokes new access immediately and
  queues exact cleanup. Pair lifetimes do not extend the shorter funded allowance.
- Keep small retired metadata/evidence references under existing artifact/audit
  retention; never persist raw user prompts or secrets for lifecycle diagnosis.
- Related writes are transactional. Only root-owned DB wrappers destroy pools;
  transaction/injected wrappers never close shared resources.

### Pinned update target and currency

During `updating`, `requested_source_sha` is the immutable source selected for
the next generation. A later observed head only changes `outdated`; it cannot
replace that target. Completing reset preserves this target-currency flag. Outside
an update, the field records a newer observed head; identical observations are
no-ops and a return to the pinned running source clears it. Explicit update starts
with a newly verified current candidate and clears the prior currency warning.
