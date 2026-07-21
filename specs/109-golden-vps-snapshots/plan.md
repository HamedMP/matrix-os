# Implementation Plan: Golden VPS Snapshots

**Branch**: `codex/125-golden-vps-snapshots` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification from `specs/109-golden-vps-snapshots/spec.md`

## Summary

Build one sanitized, validated Hetzner snapshot for every eligible immutable customer host bundle and supported compatibility class. Platform Postgres is authoritative for immutable bundle provenance, lifecycle, build leases, validation evidence, selection leases, cleanup, and revocation. New and recovery VPSes are created just in time from an exact ready snapshot, or the newest compatible older snapshot followed by the existing exact-bundle activation path. A newer snapshot is never selected for an older target. Any unsafe or unknown condition falls back to the unchanged Ubuntu/full cloud-init path. Snapshot automation is asynchronous and cannot block host-bundle publication or existing-fleet deployment.

V1 does not keep running or powered-off warm customer VPSes. Builders and validation clones are ephemeral provider resources with synthetic, single-use identities. Customer credentials and owner state are injected only through the newly created customer VPS's cloud-init activation.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict ES modules on Node.js 24+; POSIX shell/cloud-init for host sanitation and activation; GitHub Actions YAML
**Primary Dependencies**: Hono, Kysely, PostgreSQL, Zod 4 via `zod/v4`, native `fetch`, Vitest, existing host-bundle and customer-VPS services, Hetzner Cloud API v1
**Storage**: Platform PostgreSQL via Kysely for authoritative lifecycle, jobs, leases, evidence, and exact-resource cleanup; Hetzner snapshot storage for disk images; R2 remains the immutable host-bundle object store
**Testing**: Vitest unit/contract/integration tests with fake provider and fake clock; shell-script contract tests; existing platform/customer-VPS suites; workflow tests; bounded disposable-provider validation only after separate operator authorization
**Target Platform**: Platform control plane on Linux; Ubuntu 24.04 x86 customer VPSes in V1; design admits additional architecture/base-system compatibility classes
**Project Type**: Monorepo backend/control-plane, host scripts, and CI/release workflow; no customer UI in this stack
**Performance Goals**: At least 60% lower median accepted-to-healthy provisioning time; snapshot path p95 at or below 90 seconds; enqueue within 5 minutes of eligible publication; 95% of builds ready within 30 minutes
**Constraints**: No warm pool; no customer or reusable secrets in snapshots; no provider calls in transactions; every provider call has a 10-second request timeout and operation-specific bounded reconciliation deadline; unknown state fails closed for snapshot use and open only to clean-image provisioning; 30-snapshot default Hetzner quota; each PR below repository size limits
**Scale/Scope**: One build per immutable bundle digest and compatibility key; bounded batches (default 25), bounded retry budgets (default 5 provider attempts per phase), bounded leases, retention below configured/project quota, horizontally safe across platform instances

## Provider Spike Gate

The source/documentation spike is recorded in [research.md](./research.md). It confirmed documented response shapes and exposed behaviors that must not be assumed:

- Snapshot and server creation return provider resource IDs plus asynchronous Action IDs; success requires terminal Action success and resource readiness.
- A server can receive an ID and later disappear after its allocation Action fails.
- Snapshots are architecture-bound but not location-bound; server-type availability remains location-specific.
- Snapshot storage is quota-limited and snapshots are not automatically deleted.
- A timed-out create/delete request is ambiguous. The worker must reconcile exact labels and persisted IDs before retrying or cleaning up.

No production provider resources were created. Live timing, label visibility latency, delete convergence, and cloud-init rerun behavior remain explicit disposable-infrastructure spike gates before rollout. Implementation does not rely on optimistic answers to those questions.

## Constitution Check

*GATE before research: PASS. Re-checked after design: PASS.*

| Principle | Design evidence |
|---|---|
| I. Data belongs to its owner | Golden images are OS release artifacts. Owner home, databases, backups, conversations, sessions, logs, and credentials are forbidden and validation fails closed. |
| II. AI is the kernel | No kernel behavior changes; snapshotting is control-plane infrastructure. |
| III. Headless core, multi-shell | Provisioning remains a headless platform service and changes no renderer contract. |
| IV. Self-healing | Durable jobs, leases, reconciliation, exact-resource cleanup, quarantine, revocation, and clean-image fallback recover from partial failures. |
| V. Quality over shortcuts | Independent clean-clone validation and exact-bundle health registration are gates to readiness. |
| VI. App ecosystem | Owner app data is never baked into an image; default OS assets may be included only as generic bundle content. |
| VII. Multi-tenancy | Customer activation occurs after clone with one owner/runtime slot; no server or state is reassigned. |
| VIII. Defense in depth | Release enqueue keeps `PLATFORM_SECRET`; destructive/status operator controls use a separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET`; new internal payloads use bounded Zod schemas and body limits; errors are generic; provider calls time out; credentials are single-use and redacted. |
| IX. TDD | Each implementation layer begins with failing unit/contract/integration tests, including fault injection and concurrency. |
| X. Worktree/PR/Greptile | Work stays in a persistent worktree and ships as the requested Graphite stack without flattening PR #1053. |

Additional gates:

- PostgreSQL/Kysely only; schema writes use migrations in the existing platform DB initialization path.
- Idempotent create uses database unique constraints plus `ON CONFLICT`.
- Related lifecycle/audit/cleanup writes use one transaction.
- Selection eligibility and lease insertion are atomic; provider calls happen after commit.
- External calls use `AbortSignal.timeout()` and bounded retry/reconciliation.
- Public repository docs contain no private customer or operator identifiers/secrets.
- The canonical public docs update remains a separate PR in the private website repository, as approved by the spec.

## Architecture

### Source of truth and component flow

```text
host bundle publish
  -> durable release registration (never blocks existing-fleet deploy)
  -> idempotent enqueue attempt plus periodic missing-candidate reconciliation
  -> platform Postgres snapshot + build job (canonical)
  -> bounded snapshot worker lease
  -> Hetzner builder (clean Ubuntu, exact labels, single-use callback)
  -> exact bundle install -> sanitation -> powered off
  -> Hetzner snapshot + Action reconciliation
  -> validation clone 1 (fresh synthetic identity, persist hashes, cleanup)
  -> validation clone 2 (independent activation, compare with builder + clone 1)
  -> exact bundle/health/identity/secret-absence evidence
  -> atomic ready transition + builder/clone cleanup

authorized provision/recover
  -> resolve immutable target release and requested server compatibility
  -> atomic eligible snapshot selection + lease
  -> Hetzner create from snapshot outside transaction
  -> customer-only cloud-init activation
  -> exact target update when selected image is older
  -> existing registration and health gate
  -> release lease; or exact cleanup + clean-image fallback
```

### Lifecycle state machine

```text
candidate -> building -> sanitizing -> validating -> ready
     |           |            |             |
     +-----------+------------+-------------+--> failed
                                           +--> quarantined

ready -> quarantined (integrity/provider/revocation fault)
failed -> candidate (bounded operator retry; resets the snapshot and build attempt budget atomically)
ready|quarantined|terminal non-retryable failed -> retiring -> deleted
```

Unknown provider state is recorded on the build/cleanup job while the snapshot lifecycle remains non-selectable. A snapshot becomes `ready` only in the same transaction that stores successful validation evidence and clears the active build lease. Revocation is an atomic `ready -> quarantined` transition. The authenticated retry endpoint is the only `failed -> candidate` path; it resets the bounded attempt budget and terminal fields in one transaction before the build becomes claimable again.

### Compatibility and ordering

`compatibility_key` is a deterministic hash of bounded normalized fields: provider, architecture, region policy, base-image generation, boot mode, activation ABI, and minimum disk class. V1 config creates only the declared Ubuntu 24.04 x86 class, but the schema does not collapse future ARM/base-generation rebuilds.

Selection uses immutable release provenance, not lexical version or registration order:

1. Resolve the requested immutable `host_bundle_releases` row; its persisted
   `build_time` is the authoritative target ordering value and is not duplicated on
   the snapshot row.
2. Prefer a ready exact-digest snapshot matching the requested compatibility constraints.
3. Otherwise join each snapshot's `bundle_version` to its immutable
   `host_bundle_releases.build_time` and select the newest compatible source whose
   `source.build_time < target.build_time` and whose activation ABI permits update to
   the target. `build_time` is fixed on first registration; a conflicting
   re-registration is rejected rather than rewriting ordering provenance.
4. Reject candidates whose `ready_at` is older than the bounded configured freshness
   window; freshness-expired rows receive no sole-fallback retention protection and
   are reconciled through guarded retirement.
5. Never select a snapshot whose source release is newer than the target, even if its version string sorts earlier.
6. If no candidate is safe, use the configured clean Ubuntu image.

### Sanitation boundary

The builder starts from the configured clean system image and receives only a public immutable bundle URL/digest plus single-use synthetic build credentials. It never receives customer credentials, backups, object-storage scopes, platform-wide secrets, or provider credentials. Before capture, the sanitizer stops Matrix/customer services and removes or resets:

- Matrix/customer environment files, registration/provisioning markers, and runtime identity;
- owner home/data, databases, backups, conversations, sessions, memory, and logs;
- SSH host keys, TLS/private keys, authorized keys, and builder access;
- `/etc/machine-id`, dbus machine ID, and systemd random seed;
- cloud-init instance/cache state and persisted user-data;
- DHCP/network leases, generated netplan/network state, and persistent interface identity;
- shell histories, temporary files, package-manager credentials/caches that may hold auth;
- provider/bootstrap tokens and callback material;
- Docker/container state and volumes if Docker is present;
- builder logs, journals, crash dumps, and swap remnants that may contain secrets.

After deleting persisted bootstrap material, the sanitizer overwrites free filesystem
blocks, syncs, removes the fill file, and scans the raw root device for the callback
token and synthetic canaries without placing secret values in command arguments. A
positive match, unreadable device, incomplete fill, or scan timeout fails closed. V1
does not substitute discard/TRIM for overwrite without a separately authorized provider
spike proving equivalent behavior for the exact storage class.

Services capable of recreating state remain disabled through shutdown and capture. A manifest of expected generic content and forbidden-state checks is persisted as non-secret validation evidence; raw scan matches and provider errors remain server-side only.

### Provisioning durability and fallback

Existing `provisioning_jobs` remains the durable owner-machine workflow. It gains explicit image-source, target-release, activation-step, snapshot-lease, and create-intent fields so restart recovery does not infer progress from the current machine row. Snapshot selection and create-intent persistence are short transactions; clone creation is outside them. Exact provider labels use the existing immutable machine UUID, allowing reconciliation after a lost create response. Rollout disablement and revocation deny every overlapping uncompleted intent under the same advisory-lock order, and provisioning/recovery re-check that denial immediately before create and after every accepted or ambiguous response.

Fallback rules:

- After a definite pre-create rejection with no possible server: globally quarantine
  only a permanent image defect; record temporary/location rejection on the attempt,
  release the lease, and retry the same durable job through the clean image.
- After a snapshot clone may exist: reconcile by machine UUID and adopt exactly one safe
  match. If it cannot be adopted, first prove power-off or network isolation and revoke
  its instance credentials. If isolation cannot be proven, rotate every shared
  platform, storage, and database credential exposed to it. Only then may a clean-image
  successor become authoritative; exact deletion remains durably queued and bounded.
- After customer activation starts: never reuse partially activated infrastructure for
  another owner; apply the same isolation and credential revocation/rotation gate before
  retrying from a clean base within the bounded job budget.
- Existing-fleet `/vps/deploy` does not consult snapshot state.

## Security Architecture

### Authorization matrix

| Interface | Auth source | Exposure |
|---|---|---|
| `POST /system-bundles/snapshot-builds` | Existing constant-time `PLATFORM_SECRET` bearer check | Release automation/operator only |
| `GET /system-bundles/snapshot-builds/:buildId` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; coarse build detail |
| `POST /system-bundles/snapshot-builds/:buildId/retry` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; 1 KiB bounded mutation |
| `GET /system-bundles/snapshots?limit=1..100&cursor=<opaque>` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; bounded, cursor-paginated coarse snapshot inventory |
| `POST /system-bundles/snapshots/:snapshotId/revoke` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; 4 KiB bounded mutation |
| `POST /system-bundles/snapshot-base-generations/:baseGeneration/revoke` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; atomically persists the generation deny marker, then bounded workers quarantine rows; 4 KiB bounded mutation |
| `GET /system-bundles/snapshot-base-generations/:baseGeneration/affected-machines?limit=1..100&cursor=<opaque>` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; bounded cursor-paginated coarse remediation inventory |
| `POST /system-bundles/snapshot-cleanup/:cleanupId/retry` | Constant-time `GOLDEN_SNAPSHOT_OPERATOR_SECRET` bearer check | Operator only; requeues one terminal exact-resource cleanup row; 1 KiB bounded mutation |
| `POST /system-bundles/snapshot-builds/:id/callback` | Per-build random single-use token, stored hashed and compared constant-time | Builder/validation clone only |
| Existing `/vps` provision/recover routes | Existing Clerk/operator route auth | Unchanged |
| Existing `/vps/register` | Existing per-machine registration token and provider-server binding; request also proves installed digest and coarse health against the persisted target | Internal additive contract only; public/customer schemas unchanged |
| Snapshot provider methods | Server-side Hetzner API token | Never exposed to customers/builders |

All mutating routes use `bodyLimit`; params/bodies use strict bounded Zod schemas. Callback tokens are phase-bound, expire at the persisted external-phase `callback_expires_at` deadline independently of the shorter reclaimable worker lease, are cleared after one successful use, and never appear in URLs or logs. Accepted events persist bounded receipts keyed by `(build_id, event_id)` for the replay window so a later phase cannot erase an earlier retry outcome. Provider/raw validation errors map to bounded internal reason codes and generic client responses.

### Transaction and lock scope

- `enqueueSnapshotBuild`: one transaction for idempotent snapshot identity upsert, build job upsert, and audit event/outbox state; `ON CONFLICT` is keyed by bundle digest + compatibility key + persisted test-mode isolation. Release registration is the durable source event, and a bounded periodic reconciler scans eligible releases without production candidates so a timed-out post-publish enqueue cannot permanently omit a snapshot.
- `claimSnapshotBuild`: one short advisory-lock transaction counts durable `running`
  builds plus every unresolved cleanup row for a builder or validator whose exact
  absence has not been confirmed, then conditionally claims at most the remaining
  configured capacity. The cap defaults to 2 and is bounded to 1-10; callback waits
  and cleanup-pending infrastructure consume a slot. Provider calls occur only after
  commit.
- `markReady`: one transaction stores evidence, transitions lifecycle, clears lease/token hashes, and protects referenced snapshots.
- `selectAndLeaseSnapshot`: one transaction resolves an eligible candidate and inserts a time-bounded provisioning lease; no provider calls occur inside.
- `createSnapshotIntent`: one short transaction takes the compatibility/generation and
  snapshot advisory locks, revalidates rollout plus snapshot eligibility, and inserts an
  idempotent intent before provider create. Rollout disablement and snapshot/generation
  revocation use the same lock order and mark overlapping uncompleted intents denied.
- `revoke generation`: one short transaction upserts the durable deny marker and denies
  overlapping uncompleted create intents. Enqueue, readiness, selection, pre-create,
  post-create, and registration check it; bounded deterministic worker transactions later
  quarantine snapshots, terminate builds, and queue eligible exact cleanup.
- `retire/delete`: one transaction marks non-selectability and queues exact cleanup; a
  revoked/quarantined image preserves active lease rows but bypasses channel/rollback
  protection after the final lease release. Provider delete occurs later, followed by
  a conditional completion update.
- No HTTP/provider/object-store operation occurs while a DB transaction or row lock is held.

### Acceptable orphan states

- Labeled builder or validation server exists but DB phase is ambiguous: non-selectable
  and high-priority reconciliation only. Reconcile/adopt one exact match, or revoke its
  build/callback credential and prove the server powered off or network-isolated before
  queuing exact deletion. Until isolation and credential revocation are proven, keep the
  build failed/quarantined and do not treat cleanup or normal progress as safe.
- Provider snapshot exists in `creating` or the create response was lost: non-selectable; reconcile persisted Action ID and exact labels.
- DB tracks an unavailable image: quarantine and fall back; retention/reconciliation resolves deletion state.
- Snapshot image exists after DB is `retiring`: never selectable; deletion queue retries with exact ID/provenance.
- Customer clone exists before DB persistence: reconcile by immutable machine UUID; no second authoritative server until adoption/deletion resolution.
- Host bundle is published while enqueue/build fails: release remains valid, existing-fleet deploy proceeds, new VPSes use older-safe/clean fallback.

## Project Structure

### Documentation (this feature)

```text
specs/109-golden-vps-snapshots/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── control-plane.md
│   └── provider.md
└── tasks.md
```

### Source code (repository root)

```text
packages/platform/src/
├── golden-snapshot-schema.ts          # bounded domain schemas and state transitions
├── golden-snapshot-repository.ts      # Kysely persistence and transactions
├── golden-snapshot-service.ts         # build/reconcile/retention orchestration
├── golden-snapshot-routes.ts          # authenticated admin/callback adapters
├── golden-snapshot-selection.ts       # pure compatibility/order policy
├── golden-snapshot-activation.ts      # provisioning image choice + durable steps
├── customer-vps-hetzner.ts            # provider interface implementation extensions
├── customer-vps-config.ts             # bounded rollout/retention/compatibility config
├── customer-vps.ts                    # narrow integration only; no new large orchestration block
├── db.ts                              # table types + migration registration only
└── platform-startup.ts                # worker construction, interval, shutdown wiring

distro/customer-vps/
├── cloud-init.yaml                    # clone activation and exact-bundle verification
├── golden-snapshot-builder-cloud-init.yaml
└── host-bin/
    ├── matrix-golden-snapshot-sanitize
    └── matrix-golden-snapshot-validate

scripts/
└── enqueue-golden-snapshot.mjs

.github/workflows/
└── host-bundle-release.yml

tests/platform/
├── golden-snapshot-repository.test.ts
├── golden-snapshot-selection.test.ts
├── golden-snapshot-service.test.ts
├── golden-snapshot-routes.test.ts
├── golden-snapshot-host-scripts.test.ts
├── golden-snapshot-provisioning.test.ts
└── host-bundle-snapshot-workflow.test.ts

docs/dev/
└── golden-vps-snapshots.md
```

**Structure Decision**: Keep the domain in focused platform modules because platform Postgres and customer-VPS lifecycle are the source-of-truth boundary. `db.ts` and `customer-vps.ts` already exceed 1,000 LOC, so they receive only registration/integration changes; new behavior lives in extracted modules with dedicated tests. Host sanitation remains explicit shipped shell code under `distro/customer-vps/`.

## Delivery and Rollout

### Graphite stack

1. `docs(plan): plan golden VPS snapshot implementation`
2. `feat(platform): persist golden snapshot lifecycle`
3. `feat(vps): build and validate golden snapshots`
4. `feat(platform): provision VPSes from golden snapshots`
5. `ci(release): create snapshots for eligible host bundles`
6. `docs(vps): document snapshot operations and rollout`

Each layer is independently testable, keeps the approved spec PR unchanged except review corrections, and includes the mandatory PR invariants. The stack is submitted draft until current-head tests and review are complete.

### Rollout gates

1. Feature and enqueue disabled by default; migrations/reconciliation are inert.
2. Fake-provider and fault-injection suites pass.
3. Separately authorized disposable Hetzner project validates image/action timing, label discovery, deletion convergence, cloud-init rerun, and architecture/location/disk constraints.
4. Synthetic snapshot build and validation clone only.
5. Preview/test VM cohort.
6. Compatibility-scoped customer percentage with automatic fallback and latency/leakage telemetry.
7. Default for eligible new provision/recovery only after success criteria hold.

Rollback disables selection immediately and preserves clean-image provisioning. Revocation quarantines affected compatibility/base generations. Existing VPS updates never depend on this switch.

## Test Strategy

- Repository tests: idempotent `ON CONFLICT`, transaction rollback, conditional claims, lease/retention races, revocation, exact cleanup.
- Provider contract tests: request timeouts, bounded validation, Action polling, response loss, exact label reconciliation, architecture/disk/location rejection, protected/missing deletion.
- Builder tests: exact digest install, all sanitation categories, quiescence, callback token erasure, forbidden-path/secret scan fail-closed.
- Validation tests: fresh cloud-init, unique machine/SSH identity, exact bundle, no builder/customer state, health success required before ready.
- Provisioning tests: exact selection, older-safe update, newer rejection, lease protection, lost response adoption, duplicate cleanup, clean fallback, recovery parity, existing-fleet independence.
- Workflow tests: eligible main/tag/manual-dispatch enqueue, preview exclusion, channel-promotion dedupe, enqueue failure does not block publish/deploy.
- Baseline-aware gates: `bun run check:patterns`, focused Vitest suites, `bun run typecheck`, and `bun run test`; record the known unrelated baseline failures without mixing fixes into the stack.

## Post-Design Constitution Re-check

PASS. The design uses owner-safe Postgres/Kysely persistence, explicit authorization, strict validation, bounded resources/timeouts, transactions for related writes, no provider I/O under locks, TDD, public-safe docs, and the mandated manual-worktree Graphite flow. No constitutional exception is required.

## Complexity Tracking

No constitution violations require justification. The additional tables and worker are domain state required for safe cross-process/provider reconciliation; they do not introduce an alternate database, ORM, warm pool, or parallel customer-runtime path.
