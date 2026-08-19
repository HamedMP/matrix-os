# Golden VPS Snapshots

Golden VPS snapshots accelerate new customer and recovery machine creation. They are an optional, fail-closed optimization around the existing immutable host-bundle and clean Ubuntu cloud-init path. They are not backups, customer images, or a pool of warm servers.

The approved product invariants and policy are defined by [spec 109](../../specs/109-golden-vps-snapshots/spec.md). The implementation plan, data model, provider research, design contracts, and executable checklist live beside it in `specs/109-golden-vps-snapshots/`. Exact operational request fields come from the bounded live route schemas in `packages/platform/src/golden-snapshot-routes.ts`; this guide does not override those schemas.

## V1 Invariants

- Build a new sanitized candidate only when an eligible immutable host bundle is promoted to `stable`. Do not keep running or powered-off warm customer VPSes.
- Select only a snapshot whose immutable bundle SHA-256 exactly matches the requested bundle. Otherwise use clean Ubuntu.
- Keep snapshot building, publication, existing-fleet deployment, and customer provisioning as separate failure domains.
- Fall back to the existing clean Ubuntu/full cloud-init path whenever lookup, compatibility, cloning, activation, or validation is definitely unsafe.
- Do not issue a second provider create after an ambiguous timeout. Reconcile exact immutable labels first.
- Do not mark an image selectable until an independent clone proves the exact bundle, runtime health, fresh identity, and sanitation invariants.
- Customer data and owner backups never enter a golden snapshot. Recovery restores an owner-scoped backup only after base activation.

The feature ships disabled. `GOLDEN_SNAPSHOT_BUILDS_ENABLED` controls candidate production. `GOLDEN_SNAPSHOTS_ENABLED` and `GOLDEN_SNAPSHOT_ROLLOUT_PERCENT` only bootstrap a missing compatibility-scoped Postgres rollout row; the durable row is authoritative thereafter. Builds and selection are deliberately separate.

## Architecture and Source of Truth

Platform Postgres is authoritative for immutable bundle provenance, snapshot state, build attempts, leases, cleanup work, and release/channel protection. Hetzner holds provider resources but is not the lifecycle source of truth. R2 holds immutable host-bundle bytes and checksums.

Each logical image is keyed by the host bundle SHA-256 plus a compatibility key containing provider, architecture, region policy, base image/generation, boot mode, activation ABI, and minimum disk size. Re-registering a channel does not create a new identity. Preview/PR artifacts are not eligible for the release hook.

The stable channel promotion is the forward-only build trigger. Stable releases default to snapshot-eligible and may explicitly opt out. Dev, canary, beta, preview, and register-only releases default to ineligible. The platform commits the stable pointer, exact eligibility value, and build enqueue in one transaction. A newer stable promotion quarantines unfinished older production builds and queues exact-resource cleanup. Startup workers do not scan or backfill release history, so releases that predate this contract remain historical unless promoted again through an explicitly authorized operation.

The durable lifecycle is:

| State | Selectable | Meaning |
|---|---:|---|
| `candidate` | no | Idempotent build request exists |
| `building` | no | Ephemeral builder is being created or booted |
| `sanitizing` | no | Exact bundle is installed and sensitive state is being removed |
| `validating` | no | Provider image exists; an independent clone is proving it |
| `ready` | yes | Validation evidence passed and provider image is available |
| `failed` | no | Bounded retry may be explicitly requested |
| `quarantined` | no | Safety or provenance is uncertain; automatic retry is forbidden |
| `retiring` | no | Selection is disabled and exact-resource cleanup is queued |
| `deleted` | no | Provider deletion was reconciled and recorded |

Related state changes use Postgres transactions. Provider requests are always outside transaction and row-lock scope. Selection and lease insertion are one transaction; retirement takes a row lock, rechecks active leases, creates idempotent cleanup work, and removes the image from eligibility atomically.

## Build and Validation

The release publisher registers immutable metadata after upload. When that same operation promotes the bundle to `stable`, the platform transaction records eligibility and enqueues the exact bundle build. The release workflow has no separate enqueue job, and platform startup performs no historical lookback. `GOLDEN_SNAPSHOT_BUILDS_ENABLED` gates worker claims, not durable stable-promotion enqueue. The platform deployment workflow defaults workers to `false` and keeps snapshot selection disabled with rollout `0%`.

The worker uses bounded batches and leases and claims production capacity only for the current eligible stable release. Ephemeral builders and validation clones carry exact labels for build ID, snapshot ID, and role. Those labels are also the only allowed basis for adopting a resource after an ambiguous create result. Zero matches means wait; multiple exact matches quarantine the build. Cleanup verifies the recorded resource ID and labels before deletion.

The sanitizer must remove or reset all of the following before shutdown:

- Matrix/customer credentials, environment files, registration tokens, and provisioning markers
- owner home/data, databases or container volumes, conversations, sessions, memory, and logs
- SSH host keys, `authorized_keys`, TLS keys, and provider/bootstrap credentials
- `/etc/machine-id`, systemd random seed, cloud-init instance/cache state
- network leases and persistent interface identity
- shell history, temporary files, package-manager credentials, and secret-bearing builder logs

The validation clone must then prove:

- `/opt/matrix/app/BUNDLE_VERSION` and `/opt/matrix/app/BUNDLE_SHA256` match the requested immutable version and SHA-256
- required Matrix services and local health are ready
- machine ID and SSH host identity are newly generated
- activation/registration state is fresh
- the forbidden owner, credential, log, cloud-init, and builder markers remain absent

The sanitizer writes a bounded evidence manifest only after every required category is removed. The validation clone requires every manifest entry before synthetic activation and then rechecks stable forbidden paths afterward. Missing evidence for any sanitation category fails validation closed.

Validation callbacks use a short-lived per-phase token stored only as a hash. Failed or incomplete evidence never produces `ready`.

## Provisioning and Recovery

Selection order is exact compatible image, then clean Ubuntu. Compatibility includes the exact bundle SHA-256, architecture, region policy, boot mode, activation ABI, minimum disk, and base generation. Older or merely compatible bundle snapshots are never selected for a different target release.

New builders bake the clean-boot host packages and AWS CLI, normalize the app tree for matrix-user update state, then write `/opt/matrix/golden-snapshot-system-ready` only after the exact bundle activates successfully. Before readiness, a credential-free loopback S3-compatible smoke test makes the baked AWS CLI execute the same `s3api head-object` and `s3 cp` command families used by restore, including signing, endpoint handling, HTTP, and byte verification; the independent validation clone repeats that check. Real primary-storage endpoint capability remains independently gated by the platform's bounded canary lifecycle, so builders and validation clones never receive customer storage credentials. During customer first boot, an exact snapshot may reuse the baked AWS CLI and host bundle only when the readiness proof, baked `BUNDLE_VERSION`, baked `BUNDLE_SHA256`, requested snapshot source version, and requested immutable digest all match. Missing, legacy, symlinked, or mismatched evidence fails closed to the full clean bootstrap. The clone also reapplies the app-root group ownership and write mode before services start. Consequently, snapshots built before this contract do not receive the fast path; a new stable snapshot must complete before production latency changes.

Customer cloud-init emits coarse `matrix-host-timing` entries for `system_prerequisites_ready`, `host_bundle_ready`, and `core_services_started`, with elapsed seconds and only the coarse image source. Use those phases plus the platform request, provider-create, and registration timestamps to compare a new snapshot cohort against clean-image provisioning without logging customer credentials.

The snapshot lease remains active while the provider clone is in flight. Owner identity, platform registration material, tunnel credentials, TLS material, and runtime secrets are injected only through first-boot cloud-init after the clone. First boot still regenerates machine ID, SSH host keys, cloud-init instance state, owner directories, TLS, restore state, and runtime registration before routing. The customer path also reapplies the existing per-clone AppArmor configuration; reusable images do not bake that relaxation.

A definite provider rejection that proves the snapshot cannot be cloned may fall back to clean Ubuntu. Timeouts, connection loss, and other ambiguous results must reconcile the labeled provider resource; they must not create a second server. The existing clean-image path remains authoritative when the feature is disabled or no safe snapshot is available.

Recovery uses the same image decision and lease rules, but a golden snapshot is never treated as owner backup data. Existing backup ownership checks remain unchanged. After replacement creation succeeds, platform atomically replaces the machine/provider identity, marks the replacement `recovering`, and begins exact old-server cleanup. The replacement remains unroutable until registration proves the requested bundle version, SHA-256, and health and moves the machine to `running`; persisted provenance keeps those checks mandatory even if the bounded snapshot lease has expired. The previous server is not retained as a rollback after replacement adoption. A later registration timeout marks and reaps the unroutable replacement; an operator or customer must retry recovery. Disable snapshot selection or revoke the candidate before that retry when the next attempt must use clean Ubuntu.

## Configuration

All values are bounded during configuration parsing. Defaults keep building and selection off.

| Variable | Default | Purpose |
|---|---:|---|
| `GOLDEN_SNAPSHOT_BUILDS_ENABLED` | `false` | Allow candidate build workers |
| `GOLDEN_SNAPSHOTS_ENABLED` | `false` | Allow provisioning/recovery selection |
| `GOLDEN_SNAPSHOT_ROLLOUT_PERCENT` | `0` | Deterministic customer rollout percentage |
| `GOLDEN_SNAPSHOT_ARCHITECTURE` | `x86` | Provider architecture compatibility |
| `GOLDEN_SNAPSHOT_REGION` | `eu-central` | Region compatibility policy |
| `GOLDEN_SNAPSHOT_BASE_IMAGE` | `HETZNER_IMAGE` | Clean builder base image |
| `GOLDEN_SNAPSHOT_BASE_GENERATION` | `ubuntu-24.04-v1` | Revocable base-image generation |
| `GOLDEN_SNAPSHOT_BOOT_MODE` | `bios` | Boot compatibility |
| `GOLDEN_SNAPSHOT_ACTIVATION_ABI` | `host-v1` | First-boot activation contract |
| `GOLDEN_SNAPSHOT_MINIMUM_DISK_GB` | `40` | Image/server disk compatibility |
| `GOLDEN_SNAPSHOT_MAX_BUILD_ATTEMPTS` | `5` | Build and cleanup retry budget |
| `GOLDEN_SNAPSHOT_MAX_CONCURRENT_BUILDS` | `2` | Durable running builder/validator cap; bounded to 1-10 |
| `GOLDEN_SNAPSHOT_BUILD_LEASE_MS` | `300000` | Build/cleanup claim lease |
| `GOLDEN_SNAPSHOT_PROVISIONING_LEASE_MS` | `600000` | Clone lease |
| `GOLDEN_SNAPSHOT_RETENTION_LIMIT` | `20` | Ready-image target below provider quota |
| `GOLDEN_SNAPSHOT_FRESHNESS_MAX_AGE_MS` | `604800000` | Maximum selectable snapshot age; stale images are retired |
| `GOLDEN_SNAPSHOT_RECONCILIATION_BATCH_SIZE` | `25` | Per-cycle work cap |
| `GOLDEN_SNAPSHOT_RECONCILIATION_INTERVAL_MS` | `15000` | Worker cadence; values outside 1,000-3,600,000 ms disable it |
| `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | none | Separate bearer credential for snapshot status, retry, revoke, inventory, and cleanup controls; never give it to release automation |

Release automation uses `PLATFORM_SECRET` only for idempotent build enqueue. All
snapshot status and destructive controls require `GOLDEN_SNAPSHOT_OPERATOR_SECRET`, so
a compromised publication credential cannot revoke images or requeue cleanup. Terminal
failed/quarantined cleanup can be retried on its existing exact-resource row through
`POST /system-bundles/snapshot-cleanup/:cleanupId/retry`; the route never accepts a
provider ID or provenance override.

Candidate builds may be enabled only after gates 1-4 pass. Keep snapshot selection disabled through gate 5; a build row or even a `ready` image is not by itself approval to serve customer or recovery clones.

## Authenticated Operations

Snapshot control routes are mounted below `/system-bundles`. Release automation uses
the platform/release bearer only to enqueue an eligible published bundle. Status,
retry, revocation, inventory, and cleanup controls require the separate
`GOLDEN_SNAPSHOT_OPERATOR_SECRET`; release automation must not receive it. The callback
instead uses a short-lived, single-build, phase-bound bearer token whose hash is
persisted and compared in constant time. Mutating routes have Hono body limits and
strict Zod schemas. Responses contain lifecycle IDs/states and allowlisted failure
codes only; raw provider responses are logged server-side and never returned.

| Route | Authorization | Body limit | Purpose |
|---|---|---:|---|
| `POST /system-bundles/snapshot-builds` with production `testMode: false` | platform/release bearer | 8 KiB | Idempotently enqueue an eligible immutable published bundle |
| `POST /system-bundles/snapshot-builds` with operator-only `testMode: true` | snapshot-operator bearer | 8 KiB | Enqueue a bounded disposable spike candidate without granting test-mode authority to release automation |
| `GET /system-bundles/snapshot-builds/:buildId` | snapshot-operator bearer | none | Read coarse build phase/status |
| `GET /system-bundles/snapshots?limit=N&cursor=opaque` | snapshot-operator bearer | none | List deterministic bounded lifecycle pages without provider IDs |
| `POST /system-bundles/snapshot-builds/:buildId/retry` | snapshot-operator bearer | 1 KiB | Retry only a persisted safe `failed` build |
| `POST /system-bundles/snapshots/:snapshotId/revoke` | snapshot-operator bearer | 4 KiB | Immediately quarantine one snapshot |
| `GET /system-bundles/snapshots/:snapshotId/affected-machines?limit=N&cursor=opaque` | snapshot-operator bearer | none | Enumerate a deterministic bounded page for one exact source snapshot |
| `POST /system-bundles/snapshot-base-generations/:baseGeneration/revoke` | snapshot-operator bearer | 4 KiB | Immediately persist the generation deny marker; bounded worker pages asynchronously quarantine snapshots and terminate builds |
| `GET /system-bundles/snapshot-base-generations/:baseGeneration/affected-machines?limit=N&cursor=opaque` | snapshot-operator bearer | none | Enumerate a deterministic bounded page of retained machines; follow `nextCursor` until absent |
| `POST /system-bundles/snapshot-cleanup/:cleanupId/retry` | snapshot-operator bearer | 1 KiB | Requeue one terminal exact-resource cleanup row within its bounded retry policy |
| `POST /system-bundles/snapshot-builds/:buildId/callback` | short-lived phase callback bearer | 64 KiB | Accept bounded synthetic sanitation or validation evidence |

The public release metadata includes only `snapshotStatus` (`not_requested`, `requested`, `building`, `ready`, `failed`, or `unavailable`). It never exposes image IDs or provider errors.

## Retention, Revocation, and Cleanup

Normal reconciliation retains the configured number of ready images. Retirement refuses to delete:

- current channel versions
- bounded recent rollback versions for each channel
- images with an active provisioning/recovery lease
- the newest and therefore sole guaranteed image for a compatibility key

Freshness-expired images are no longer selectable and receive none of the channel, rollback, or sole-compatible protections above. Once their active leases end, bounded reconciliation moves them through ordinary guarded retirement.

Quota-pressure selection aims one image below the configured limit and reports `blocked` when no safe deletion exists. It does not weaken protections. A revoked snapshot leaves selection immediately through an atomic state update. Generation revocation is deliberately two-stage: the route transaction first persists the durable deny marker, which immediately blocks enqueue, readiness, and selection for that generation; a bounded worker then quarantines matching rows, terminates builds, and reconciles exact provider resources asynchronously. A successful route response does not claim that this later containment work is complete. Existing leases remain recorded; release of the final lease atomically moves the image to retiring and queues high-priority exact-resource cleanup even when the bundle is still a current or rollback channel.

Delete timeouts remain `running` or return to the bounded queue. A missing exact resource is accepted as completed. A resource whose labels or recorded provenance do not match is quarantined for operator review and is never deleted by guessing.

Acceptable temporary orphan states are a labeled builder or validator after an ambiguous create, an available labeled image awaiting adoption, and a recorded cleanup item whose provider deletion is not yet observable. Unlabeled or mismatched resources are not adopted or deleted automatically.

## Rollout Gates

Production selection must remain disabled until all gates pass:

1. Focused unit/integration suites, pattern checks, platform typecheck, and the known repository baseline are reviewed.
2. A separately authorized disposable Hetzner project runs the spike in the spec quickstart.
3. The spike records creation Action behavior, image readiness timing, clone compatibility across intended architecture/location/server types, cloud-init rerun behavior, and deletion convergence.
4. A validation clone proves the full sanitation and exact activation contract.
5. Builds run safely with selection still off; retention and cleanup remain bounded below quota.
6. Selection starts at a small deterministic percentage for both new-customer provisioning and recovery; clean-image fallback metrics remain healthy for both flows.
7. Expand the shared rollout percentage only after provisioning and recovery are both proven at the smaller cohort. V1 has no independent recovery selection switch.

No live provider spike was run by this repository change because production provider resources require separate operator authorization. The implementation relies on official Hetzner API contracts for request shapes and fails closed where readiness or timeout recovery is ambiguous. Relevant references are the [Cloud API](https://docs.hetzner.cloud/reference/cloud), [snapshot overview](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/), [snapshot FAQ](https://docs.hetzner.com/cloud/servers/backups-snapshots/faq/), and [server FAQ](https://docs.hetzner.com/cloud/servers/faq/).

## Disablement, Rollback, and Incidents

For immediate rollback, use the operator-authenticated `PUT /system-bundles/snapshot-rollout` control with the active compatibility key, `enabled: false`, and `percentage: 0`. The transaction increments the rollout fence and denies overlapping uncompleted snapshot-create intents. New provisioning and recovery then use clean Ubuntu; existing VPSes and host-bundle deployment remain unchanged. Set `GOLDEN_SNAPSHOT_BUILDS_ENABLED=false` separately to stop new candidates while allowing already-ready images to remain recorded. Changing only the bootstrap environment values after the rollout row exists does not override durable operator state.

Incident classification:

- **Build or sanitation failure:** quarantine the candidate, clean exact labeled resources, keep publication and fleet deploy green.
- **Validation failure:** never select the image; revoke/retire it after evidence capture.
- **Clone definite rejection:** record coarse fallback and use clean Ubuntu.
- **Clone ambiguous result:** reconcile labels; do not create again.
- **Registration timeout:** keep the replacement unroutable, mark it failed, queue exact cleanup, and retry recovery explicitly; revoke or disable snapshot selection first when clean Ubuntu is required.
- **Identity or secret evidence:** disable selection immediately, revoke the snapshot and base generation, preserve public-safe evidence, and follow the private security incident process.
- **Quota pressure:** run protected retention; if blocked, stop builds and escalate instead of deleting protected images.
- **Provider disappearance/delete timeout:** preserve the DB record and reconcile until absence or exact deletion is proven.

Repository documentation must remain public-safe. Customer identifiers, IP addresses, provider tokens, resource IDs tied to incidents, and private dashboards belong in the private operator system. A separate PR is required for the private operator/site runbook, and the canonical public docs require a separate PR in `FinnaAI/matrix-os-site`; neither is part of this repository stack.
