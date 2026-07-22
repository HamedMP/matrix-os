# Feature Specification: Golden VPS Snapshots

**Feature Branch**: `codex/125-golden-vps-snapshots`
**Spec Directory**: `specs/109-golden-vps-snapshots/`
**Spec Kit Resolution**: This pre-existing Graphite branch does not use Spec Kit's
numeric branch convention. Run Spec Kit commands with
`SPECIFY_FEATURE=109-golden-vps-snapshots`; without that explicit override, the
repository scripts must reject this branch rather than resolve a different feature.
**Created**: 2026-07-19
**Status**: Approved
**Input**: User description: "Create a sanitized disk image for every new production host bundle and use it to make future customer VPS provisioning much faster. Decide whether to pre-provision VPSes or create them just in time, and cover failure, security, lifecycle, compatibility, and rollout edge cases."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fast Fresh Computer Provisioning (Priority: P1)

A customer who has completed signup and payment requests their Matrix computer. The
platform creates a fresh VPS just in time from a validated golden snapshot, applies
that customer's identity and secrets only after the new VPS exists, and makes the
computer available substantially faster than the current full installation path.

**Why this priority**: Reducing the wait between payment and first use is the primary
customer value. The feature is not successful unless a newly created computer remains
fresh, isolated, and current while becoming ready faster.

**Independent Test**: Provision a computer for a synthetic new customer while a
compatible ready snapshot exists. Verify that the customer receives a newly created
VPS, the computer registers with the requested bundle version, it contains no data or
credentials from the image builder, and its time to readiness meets the target.

**Acceptance Scenarios**:

1. **Given** a validated snapshot containing the exact requested host bundle, **When**
   a customer provisions a new computer, **Then** a new VPS is created from that
   snapshot and becomes routable only after customer-specific activation and health
   verification complete.
2. **Given** a validated compatible snapshot containing an older host bundle, **When**
   a customer provisions against a newer release, **Then** the new VPS updates to the
   exact requested release before it is marked running.
3. **Given** two customers provisioning concurrently, **When** both requests use the
   same snapshot, **Then** they receive separate VPSes with distinct machine identity,
   credentials, storage, database state, and host keys.
4. **Given** a customer repeats the same provisioning request, **When** a machine is
   already provisioning or running for that runtime slot, **Then** the request
   converges on the existing machine and does not create another VPS.

---

### User Story 2 - Snapshot Created for Every Eligible Bundle (Priority: P1)

A release operator publishes an immutable customer host bundle. Snapshot creation is
automatically requested for that exact bundle, producing a sanitized and independently
validated boot image that can accelerate later provisioning.

**Why this priority**: Provisioning speed will decay and new users can receive stale
software unless snapshot production is coupled to the host-bundle lifecycle.

**Independent Test**: Publish an eligible synthetic host bundle, verify exactly one
snapshot candidate is created for its bundle identity and compatibility class, and
verify it cannot become ready until sanitation and clean-clone validation pass.

**Acceptance Scenarios**:

1. **Given** a new immutable customer host bundle from an approved main or release
   build, **When** bundle publication succeeds, **Then** snapshot creation for the
   bundle starts automatically without an additional operator action.
2. **Given** snapshot creation is retried for the same bundle and compatibility class,
   **When** a candidate or ready snapshot already exists, **Then** the process resumes
   or reuses the existing record rather than creating duplicate ready snapshots.
3. **Given** the same bundle is promoted to multiple release channels, **When** each
   channel pointer changes, **Then** the existing snapshot is reused and no duplicate
   snapshot is created merely because of channel promotion.
4. **Given** a pull-request or temporary preview bundle, **When** it is published
   without promotion as a customer release, **Then** it does not create a durable
   golden snapshot by default.
5. **Given** snapshot production fails, **When** the host bundle is otherwise valid,
   **Then** existing-VPS deployment remains available, snapshot failure is visible to
   operators, and new VPSes use a safe fallback until a snapshot succeeds.

---

### User Story 3 - Safe Provisioning Fallback (Priority: P1)

A customer can still provision or recover a computer when no compatible snapshot is
ready, a snapshot has disappeared, the image provider rejects it, or image activation
fails before the customer machine is usable.

**Why this priority**: A speed optimization must never become a provisioning
availability dependency.

**Independent Test**: Make the selected snapshot unavailable during provisioning and
verify the request safely uses the established clean-system-image path without
creating two active machines or exposing provider details to the customer.

**Acceptance Scenarios**:

1. **Given** no compatible snapshot is ready, **When** provisioning starts, **Then**
   the existing clean-system-image installation path is used.
2. **Given** a snapshot is selected but the provider rejects it before server creation,
   **When** the failure is classified as snapshot-specific, **Then** the snapshot is
   quarantined and the same provisioning job may use the safe fallback path.
3. **Given** a snapshot-based server was created but activation fails, **When** retrying
   through another image path, **Then** the failed server is confirmed powered off or
   network-isolated, its instance credentials are revoked (or shared credentials are
   rotated when isolation cannot be proven), and exact deletion is completed or
   durably queued before another server can become authoritative.
4. **Given** the target bundle cannot be verified or installed, **When** activation
   runs from either snapshot or system image, **Then** the machine remains unavailable
   and reports a generic provisioning failure rather than starting mixed or unverified
   runtime files.

---

### User Story 4 - Fast and Correct Recovery (Priority: P2)

A customer recovering a machine onto replacement infrastructure can use the same
golden-snapshot acceleration while preserving the established backup and ownership
rules.

**Why this priority**: Recovery creates a new VPS and repeats much of first
provisioning. It should receive the speed benefit without treating the golden image as
a customer backup.

**Independent Test**: Recover a synthetic customer with a known owner backup onto a
snapshot-based VPS. Verify the base is activated first, only that customer's backup is
restored, the requested runtime version is running, and the replaced VPS is retired
according to the current recovery guarantees.

**Acceptance Scenarios**:

1. **Given** a compatible snapshot and a valid owner backup, **When** recovery starts,
   **Then** a fresh VPS is created from the snapshot and only the requesting owner's
   backup is restored.
2. **Given** no compatible snapshot, **When** recovery starts, **Then** recovery uses
   the existing system-image path and retains the same backup checks.
3. **Given** a golden snapshot contains any initialized owner database or home data,
   **When** validation runs, **Then** that snapshot is rejected and cannot be used for
   recovery or new provisioning.

---

### User Story 5 - Operable Snapshot Fleet (Priority: P2)

An operator can see which releases have ready, building, failed, quarantined, or
retired snapshots; understand why fallback is occurring; retry safe failures; and keep
snapshot storage bounded without deleting an image being used by provisioning.

**Why this priority**: Automated image production creates durable infrastructure and
cost. It needs explicit health, reconciliation, retention, and rollback behavior.

**Independent Test**: Create ready, failed, orphaned, leased, and superseded synthetic
snapshot records, run reconciliation and retention, and verify only eligible snapshots
are retried or deleted.

**Acceptance Scenarios**:

1. **Given** an in-flight provisioning job has leased a snapshot, **When** retention
   runs, **Then** that snapshot is not deleted until the lease ends safely.
2. **Given** the provider contains an untracked snapshot created by an interrupted
   build, **When** reconciliation finds it, **Then** it is either adopted by the exact
   matching candidate or durably queued for deletion.
3. **Given** the configured retention limit is reached, **When** a new snapshot becomes
   ready, **Then** only unreferenced, unleased, superseded snapshots are removed.
4. **Given** an operator rolls a channel back, **When** a compatible snapshot for that
   version is retained, **Then** new provisioning may use it; otherwise it uses an
   older compatible snapshot plus exact update or the clean-system-image fallback.

---

### User Story 6 - Existing Computers Continue Normal Updates (Priority: P3)

Existing customer VPSes continue to receive host-bundle deployments and rollbacks
through the established updater. Golden snapshots affect only creation of replacement
or new VPSes.

**Why this priority**: Snapshot adoption must not turn ordinary runtime releases into
disk rebuilds or endanger owner data.

**Independent Test**: Publish a bundle and deploy it to an existing customer VPS while
snapshot production is delayed or failed. Verify the existing VPS update succeeds and
its owner data is unchanged.

**Acceptance Scenarios**:

1. **Given** an existing running customer VPS, **When** a new host bundle is deployed,
   **Then** it updates in place and is not rebuilt from a golden snapshot.
2. **Given** snapshot production for that bundle fails, **When** an urgent fleet
   deployment is triggered, **Then** the snapshot failure does not block the existing
   fleet update path.

### Edge Cases

#### Release and snapshot identity

- A host bundle is published successfully but snapshot creation is delayed, times out,
  or fails after the provider has created an image.
- Snapshot workflow retries overlap, or two release events request a snapshot for the
  same immutable bundle simultaneously.
- One immutable bundle is promoted to several channels, a channel is rolled backward,
  or a channel pointer changes while snapshot validation is still running.
- A release is registered but never promoted, or is a short-lived pull-request build.
- Bundle bytes or checksum do not match the immutable release record used by the image
  builder.
- The target bundle is a security release that must deploy to existing machines before
  snapshot production finishes.
- A snapshot contains the correct version label but the wrong bundle digest.

#### Compatibility

- A snapshot was built for a different CPU architecture, operating-system generation,
  boot mode, or disk-size requirement than the requested VPS.
- A new server type has a smaller root disk than the snapshot requires.
- A snapshot is older than the requested bundle, exactly matches it, or is unexpectedly
  newer than it.
- A rollback tag and a timestamped main build sort differently by version label than
  by their immutable artifact build timestamps; selection still uses chronological
  artifact time and never lexical version order.
- A runtime release changes boot-critical layout in a way that an older snapshot cannot
  safely update during activation.
- A critical base-system vulnerability requires revoking or rebuilding snapshots even
  though the host-bundle version itself has not changed.
- A snapshot exceeds the maximum allowed freshness window while still being referenced
  by a release channel.
- A region temporarily cannot create a server from an otherwise compatible snapshot.
- The provider deprecates or removes the base operating-system image used to build new
  snapshots.

#### Sanitation and clone identity

- The builder accidentally writes registration tokens, object-store credentials,
  signed download URLs, platform secrets, SSH credentials, database passwords, shell
  history, or customer-like fixture data to disk.
- The image retains cloud initialization state, machine identity, network leases, SSH
  host keys, builder-authorized keys, logs, crash dumps, temporary files, or service
  registration markers.
- A database or owner-data volume was initialized before the snapshot was captured.
- Services restart during sanitation and recreate files that were just removed.
- The builder is snapshotted while writes are still in flight, producing an
  inconsistent disk.
- A clone does not execute fresh activation, or it reuses the builder's machine ID,
  host key, registration, or network identity.

#### Provisioning and recovery races

- Repeated or concurrent provisioning requests race while selecting a snapshot.
- Retention tries to delete a snapshot between selection and server creation.
- The provider accepts server creation but the platform loses the response.
- A clone is created and billed but database persistence of the provider server ID
  fails.
- Snapshot activation partially writes customer configuration and then crashes.
- The customer cancels or loses entitlement while provisioning or recovery is active.
- Recovery has no valid owner backup, the backup restore fails, or the previous server
  cannot be deleted after replacement succeeds.
- Optional developer tools differ between the snapshot contents and the customer's
  selected tools.

#### Operations and retention

- Snapshot quota or project storage limits are reached.
- Snapshot deletion fails, the provider reports an image that the platform no longer
  tracks, or the platform tracks an image that no longer exists.
- A provider operation times out after succeeding remotely, so the platform cannot
  initially tell whether a builder, snapshot, clone, or deletion exists.
- The image builder crashes, is canceled, or is manually deleted at every lifecycle
  phase.
- The snapshot becomes ready just as its release becomes superseded.
- All ready snapshots are quarantined at once.
- Monitoring or release metadata is temporarily unavailable; unknown state must not be
  treated as safe.
- Rollout is disabled after snapshot-based servers already exist.

## Scope and Decisions

### In Scope

- A sanitized golden snapshot for every eligible immutable customer host-bundle
  release and supported compatibility class.
- Just-in-time creation of a fresh VPS from the best safe snapshot when a customer
  provisions or recovers a runtime.
- Exact-version activation, independent clone validation, fallback, reconciliation,
  retention, observability, and rollback controls.
- A staged rollout that can be disabled without disabling customer provisioning.
- Operator documentation in this repository and a separate public documentation PR in
  the private Matrix OS website repository.

### Explicit Decision: No Running Warm Pool in V1

V1 does **not** pre-provision or retain running, unassigned VPSes. A provider server is
created only after an authorized customer provisioning or recovery request. The golden
snapshot removes generic installation work while preserving fresh infrastructure,
straightforward billing, and one-owner-per-VPS isolation.

### Non-Goals

- Reusing or sanitizing a VPS that previously belonged to another customer.
- Maintaining a pool of running or powered-off unassigned VPSes.
- Replacing owner backups with golden snapshots.
- Rebuilding existing customer VPSes to deliver ordinary host-bundle updates.
- Producing durable golden snapshots for pull-request preview bundles by default.
- Baking customer-selected credentials, identity, private files, database contents, or
  mutable owner state into a shared image.
- Removing the existing clean-system-image provisioning path.

## Requirements *(mandatory)*

### Functional Requirements

#### Snapshot production and provenance

- **FR-001**: Every successfully published eligible immutable customer host bundle
  MUST automatically request golden-snapshot creation for each supported compatibility
  class.
- **FR-002**: Eligibility MUST include trusted mainline and release builds intended for
  customer channels, including trusted manual release dispatches, and MUST exclude
  temporary preview artifacts unless an operator explicitly uses a bounded test mode.
- **FR-003**: Snapshot identity MUST be derived from immutable bundle identity and
  compatibility class, not from a mutable channel name.
- **FR-004**: Repeated and concurrent requests for the same snapshot identity MUST be
  idempotent and converge on one durable candidate/build before any provider work. The
  database MUST enforce a unique immutable bundle-digest, compatibility-class, and
  test-mode identity; creation MUST use `INSERT ... ON CONFLICT ... DO NOTHING` and
  select/reuse the winning row in the same transaction. Check-then-insert and later
  deduplication of already-billable builds are forbidden.
- **FR-005**: Each snapshot MUST record the exact bundle version and digest, source
  revision, base-system identity, architecture, minimum disk requirement, creation
  time, lifecycle state, and validation outcome.
- **FR-006**: A snapshot MUST NOT become selectable until its source bundle is verified,
  sanitation completes, the provider snapshot exists, and a newly created clone passes
  validation.
- **FR-007**: A snapshot whose recorded bundle digest differs from the immutable release
  record MUST be rejected and quarantined.
- **FR-008**: Promoting one bundle to multiple channels MUST reuse the same compatible
  snapshot rather than create channel-specific duplicates.
- **FR-009**: Snapshot production failure MUST be visible and retryable, but MUST NOT
  invalidate an otherwise valid host bundle or block urgent deployment to existing
  VPSes.
- **FR-010**: The system MUST distinguish candidate, building, sanitizing, validating,
  ready, failed, quarantined, retiring, and deleted snapshot states, and MUST reject
  unknown or incomplete states for provisioning. `retiring` MUST be entered atomically
  only after the snapshot satisfies the deletion protections in FR-041 and FR-042
  (including FR-042's freshness-expiry override). Explicit revocation immediately
  enters `quarantined`, which blocks new selection while preserving already-issued
  leases; it MUST NOT enter `retiring` until those leases drain. After lease drain,
  revocation MAY bypass channel, rollback, compatibility, and freshness protection. A snapshot entering `retiring` MUST be
  immediately
  ineligible for new selection, and MUST remain non-selectable while exact-resource
  deletion is attempted or reconciled. The system MUST enter `deleted` only after the
  exact provider image is confirmed absent; ambiguous deletion outcomes MUST remain
  `retiring` and be reconciled without substituting a different provider resource.

#### Golden-image contents and sanitation

- **FR-011**: Golden snapshots MAY contain only generic operating-system, runtime,
  application-bundle, service-definition, and pre-fetched public dependency content.
- **FR-012**: Golden snapshots MUST NOT contain customer identity, owner home data,
  initialized owner databases, owner backups, customer-selected credentials, or
  customer-specific object-storage paths.
- **FR-013**: Golden snapshots MUST NOT contain platform secrets, provider credentials,
  registration or verification tokens, database passwords, private SSH material,
  reusable signed URLs, or image-builder access credentials, including recoverable
  remnants in unallocated filesystem blocks. V1 sanitation MUST overwrite every free
  block on the builder filesystem after deleting secret-bearing files, sync the disk,
  and fail closed unless a raw-device scan proves the phase callback token and other
  synthetic canaries are absent. TRIM/discard MUST NOT replace this overwrite unless a
  separately authorized provider spike proves discarded blocks are absent from clones.
- **FR-014**: Sanitation MUST remove or reset builder machine identity, fresh-boot state,
  network leases, SSH host identity, builder-authorized access, service registration
  markers, logs, histories, temporary files, crash data, and any secret-bearing caches.
- **FR-015**: Snapshot capture MUST occur from a quiesced, consistent builder disk, and
  services capable of recreating sanitized state MUST remain stopped through capture.
- **FR-016**: Snapshot builders MUST be dedicated ephemeral infrastructure, MUST
  never be converted from a customer-owned VPS, and MUST be deleted after success,
  failure, or cancellation or durably queued for exact-resource cleanup when the
  provider outcome is ambiguous. Before each provider create, the control plane MUST
  persist the build identity and an immutable, provider-queryable label tuple that is
  unique to that exact builder or validation clone; ambiguous create reconciliation
  MUST use that tuple to adopt, isolate, or delete only the exact resource. Before an
  ambiguous builder cleanup is accepted as a safe orphan state, the control plane MUST
  revoke its build and callback
  credentials and MUST confirm the builder is powered off or network-isolated; if
  neither isolation can be confirmed, the build remains failed/quarantined and the
  resource receives bounded high-priority reconciliation rather than normal progress.
  Phase credentials delivered through provider user-data MUST be written only to
  root-owned tmpfs at runtime, consumed before capture, deleted with all persisted
  cloud-init/user-data state, and included as raw-block sanitation canaries under
  FR-013; they MUST NOT appear in callback URLs, command arguments, or logs.
- **FR-017**: Sanitation validation MUST fail closed when a forbidden path, secret
  pattern, initialized owner-data store, or unresolved fresh-boot marker is detected.
- **FR-018**: Clean-clone validation MUST prove that activation runs anew and that the
  clone's machine identity and SSH host identity differ from the builder and from other
  clones. Each validation clone MUST be deleted after validation or durably queued for
  exact-resource cleanup after failure, cancellation, or an ambiguous provider outcome.
  Before ambiguous validation-clone cleanup is accepted as a safe orphan state, its
  callback credentials MUST be revoked and the clone MUST be confirmed powered off or
  network-isolated under the same fail-closed rule as FR-016.
- **FR-018a**: Every callback MUST carry a bounded phase/event identity unique within
  its build. Callback consumption MUST persist that identity and the committed outcome
  atomically with the lifecycle transition. A retry of the same event after a lost
  response MUST return the previously committed coarse outcome without reapplying
  phase side effects; reuse with a different payload MUST fail closed.
- **FR-019**: Clean-clone validation MUST use synthetic, non-customer identity and MUST
  verify that no builder fixture, secret, owner file, or database row is visible.

#### Just-in-time provisioning and recovery

- **FR-020**: The platform MUST create each customer-serving or recovery provider VPS
  only after an authorized customer provisioning or recovery request; V1 MUST NOT
  maintain unassigned customer capacity. This restriction does not prohibit the
  bounded synthetic builder and validation-clone infrastructure required by FR-016 and
  FR-018 for an eligible release, provided those resources cannot serve customers and
  follow their mandatory cleanup lifecycle.
- **FR-021**: Before creating the VPS, the system MUST resolve the exact target host
  bundle and choose only a ready, non-quarantined, compatible snapshot that is not newer
  than the target. Older/newer ordering MUST compare the chronological instants in the
  immutable host-bundle release `build_time` provenance, normalized before comparison;
  version labels, release registration time, and snapshot creation time MUST NOT define
  ordering.
- **FR-022**: Snapshot compatibility MUST account for architecture, base-system and boot
  compatibility, minimum disk requirement, and any release-declared activation
  constraint.
- **FR-023**: The platform SHOULD prefer an exact-version compatible snapshot; otherwise
  it MAY select the newest compatible older snapshot that can safely activate to the
  exact target version.
- **FR-024**: A new VPS MUST receive customer identity and secrets only during its own
  activation, never from the shared snapshot.
- **FR-025**: Customer-specific configuration MUST become visible atomically to services,
  and partial activation MUST NOT start customer-facing services.
- **FR-026**: The machine MUST NOT be marked running or become routable until it reports
  the exact target bundle version and passes the established runtime health checks.
- **FR-027**: A snapshot clone that contains an older version MUST complete a verified
  update before health registration; failure MUST leave the machine unavailable.
- **FR-028**: A snapshot newer than the requested release MUST NOT be selected or
  downgraded in place.
- **FR-029**: Recovery MUST preserve existing backup-availability, ownership, restore,
  replacement, and cleanup guarantees regardless of which base image is selected.
- **FR-030**: Customer developer-tool selections MUST be honored during activation;
  generic tools present in the snapshot MUST NOT be treated as customer configuration
  or proof that a selected tool is authenticated.
- **FR-031**: Snapshot selection and machine creation MUST preserve the existing
  one-active-machine-per-owner-slot and idempotent provisioning guarantees.
- **FR-032**: Existing customer VPSes MUST continue receiving releases and rollbacks
  through the established in-place host-bundle update path.

#### Fallback, retries, and reconciliation

- **FR-033**: If no safe compatible snapshot exists, provisioning and recovery MUST use
  the established clean-system-image path automatically.
- **FR-034**: If a selected snapshot is missing or permanently rejected because the
  image itself is invalid or unavailable, the system MUST quarantine or refresh its
  global state and MAY fall back within the same durable provisioning job. A temporary
  or region-scoped provider rejection MUST fail only that selection attempt, record a
  bounded region-scoped reason, and fall back without globally quarantining an
  otherwise valid snapshot.
- **FR-035**: If server creation may have succeeded but the response is lost, the system
  MUST reconcile by immutable machine identity before creating another provider server.
  Before every customer or recovery create call, the durable job MUST persist that
  identity and the exact provider-queryable label tuple used by reconciliation; losing
  a create response or crashing MUST NOT lose the lookup identity needed to adopt,
  isolate, or delete the credential-bearing server.
- **FR-036**: If a snapshot-based server exists but cannot be adopted, it MUST be
  confirmed powered off or network-isolated and its instance credentials MUST be
  revoked before another server becomes authoritative. If isolation cannot be proven,
  shared platform, storage, and database credentials exposed to that server MUST be
  rotated before fallback. Exact deletion MAY remain durably queued after isolation;
  a queued deletion alone is not sufficient to authorize a successor.
- **FR-037**: Retries MUST be bounded, lease-based, and safe across worker crashes and
  concurrent platform instances. A durable provisioning or recovery job MUST re-check
  its existing authorization and current entitlement immediately before every
  billable provider create, including snapshot fallback and recovery replacement
  creates, and again before routing a replacement to the owner. If
  either check fails, the job MUST stop, release its snapshot lease, revoke its
  instance credentials, and confirm any created server isolated and exactly deleted or
  durably queued for cleanup before reaching a customer-serving state.
  A snapshot lease MUST have a configurable maximum TTL of 10 minutes by default,
  bounded to at most one hour and aligned with the server-create/boot deadline. Expiry
  makes the lease eligible for reconciliation, not immediately safe to discard. The
  bounded reconciler MUST join it to the durable provisioning/recovery state, release
  it when that job is terminal or exact provider reconciliation proves no create can
  remain, and otherwise first adopt or isolate and queue cleanup for the exact labeled
  server. Releasing the final lease on a quarantined snapshot MUST trigger its guarded
  retirement and exact-image cleanup path, preventing crash-orphaned leases from
  keeping revoked images indefinitely.
- **FR-038**: Every API response, including authenticated release, callback, status,
  retry, inventory, cleanup, and revocation controls, MUST remain generic and MUST NOT
  expose provider, snapshot-resource, storage, database, filesystem, credential, raw
  scan, or internal validation details. Bounded detailed errors MAY appear only in
  access-controlled server logs or telemetry; authentication does not authorize raw
  internal error disclosure.
- **FR-039**: Operators MUST be able to distinguish fallback due to absence,
  incompatibility, quarantine, quota, provider rejection, activation failure, and
  operator disablement without exposing those details to customers.
- **FR-040**: Unknown snapshot or provider state MUST fail closed for selection and fail
  open only to the established clean-system-image provisioning path.

#### Retention, cost, rollout, and documentation

- **FR-041**: Snapshot storage MUST have a bounded retention policy that preserves the
  newest selectable snapshot referenced by each promoted customer channel and active
  compatibility class, bounded selectable rollback protection, and every image with an
  in-flight provisioning or recovery lease. A channel reference protects the selectable
  replacement for that bundle and compatibility class; it does not protect every
  historical image that was built for the same bundle.
- **FR-042**: Superseded snapshots MAY be deleted only when they are unreferenced,
  unleased, outside rollback retention, and not the only selectable compatible ready
  fallback, except that freshness expiry makes a row non-selectable and explicitly
  removes its channel, rollback, and sole-fallback protection even while a channel
  still references its bundle. Once such a stale row has no active lease,
  reconciliation MUST move it through the ordinary guarded retirement lifecycle
  rather than leave a permanently protected but unselectable `ready` row; the channel
  continues to reference the bundle, not that stale provider image.
- **FR-043**: Reconciliation MUST first prove from the complete immutable ownership and
  build label tuple that an unrepresented provider snapshot is managed by this Matrix
  snapshot subsystem. A Matrix-managed image MUST be adopted only on exact provenance
  match; otherwise it MUST be durably queued for exact-resource deletion. Unlabelled,
  partially labelled, manually created, or third-party images MUST NOT be adopted or
  deleted by this subsystem and MUST be ignored with bounded operator-visible telemetry.
- **FR-044**: Snapshot creation, validation, selection, fallback, quarantine, retention,
  and deletion MUST emit bounded operational telemetry and actionable alerts.
- **FR-045**: Snapshot-based provisioning MUST have an operator-controlled rollout
  switch and compatibility-scoped rollout percentage. Selection and provider create
  MUST be separated by a durable create intent recorded under the same snapshot
  serialization lock used by rollout changes. Disabling rollout MUST atomically deny
  every uncompleted intent that has not become customer-serving, immediately restore
  the clean-system-image path, and leave already running VPSes unchanged. A job MUST
  re-read both the switch and its intent immediately before create and re-check the
  durable intent after every accepted or ambiguous create; a denied overlapping create
  MUST be isolated and exactly cleaned up and MUST NOT be activated or routed.
- **FR-046**: Rollout MUST begin with synthetic validation, then preview/test machines,
  then a bounded customer cohort, before becoming the default for new customer
  provisioning and recovery.
- **FR-047**: The release process MUST report snapshot status alongside bundle status so
  operators can tell whether a release is deployable to existing VPSes and whether it
  has a ready fast-provisioning image.
- **FR-048**: Operator documentation MUST cover image production, sanitation evidence,
  validation, retention, failure recovery, rollback, quota handling, and safe manual
  disablement.
- **FR-049**: A separate documentation PR MUST update the canonical public Matrix OS
  documentation in the private website repository without exposing customer or
  operator secrets.
- **FR-050**: Related lifecycle transitions that make a snapshot selectable, lease it
  for provisioning or recovery, or retire it MUST be committed atomically so observers
  cannot act on partial authoritative state.
- **FR-051**: Every external snapshot, storage, and server operation MUST have a bounded
  timeout and bounded retry policy; an ambiguous timeout MUST enter reconciliation
  rather than being treated as a definite failure. Defaults are 10 seconds per provider
  or control-plane API request and 30 seconds per bundle/file download request; image
  capture/readiness has a 20-minute reconciliation deadline, server create/boot has a
  10-minute deadline, exact deletion confirmation has a 5-minute synchronous deadline,
  and an external phase callback has a 30-minute deadline. Bounded configuration MAY
  shorten or extend operation deadlines up to one hour, but MUST NOT remove the per-
  request timeout or durable reconciliation after the synchronous deadline.
- **FR-052**: Destructive cleanup MUST resolve the exact provider resource from
  immutable provenance immediately before deletion and MUST refuse broad, unresolved,
  or pattern-only targets.
- **FR-053**: If snapshot quota is exhausted and no snapshot is safely eligible for
  deletion, snapshot production MUST fail visibly without deleting protected images or
  blocking clean-system-image provisioning.
- **FR-054**: Operators MUST be able to revoke a snapshot or an entire base-system
  generation immediately; revoked snapshots MUST stop being selected for new requests
  without disrupting already running customer VPSes. Revocation MUST atomically move
  the snapshot to non-selectable `quarantined` state and, for generation revocation,
  persist a durable generation-level deny record before quarantining visible rows.
  Enqueue, readiness transition, and selection MUST take the same generation advisory
  lock and fail closed when that deny record exists, so concurrent or future builds
  for the compromised generation cannot become selectable. Quarantine applies even
  when leases exist; revocation MUST NOT wait in `ready`. A job holding a lease MUST
  record an atomic create intent while holding the same snapshot/revocation
  serialization lock and re-check snapshot state immediately before every provider
  create. Revocation MUST mark every overlapping uncompleted intent denied in the same
  transaction that quarantines the snapshot. After any accepted or ambiguous create,
  the job MUST re-check that durable intent before activation or routing; a denied
  intent requires immediate credential revocation, isolation, and exact cleanup and
  MUST NOT become customer-serving. If no create was accepted or became ambiguous, it MUST stop
  snapshot provisioning, release the lease, and use the clean-image fallback. A lease
  for an accepted or ambiguous create remains valid only as deletion protection while
  that exact server is adopted or isolated; it does not authorize another create from
  the revoked image. Provider-image deletion is deferred until every such lease is
  released. After the last release, a bounded worker MUST queue exact-image cleanup as
  high priority even when the revoked snapshot remains referenced by a channel or
  rollback window; only then may it enter `retiring`. Every customer and recovery machine
  created from a snapshot MUST persist the source snapshot identity,
  base-system generation, and exact target bundle provenance so revocation can produce
  a bounded inventory of affected running machines for prioritized in-place update,
  recovery, or other operator-directed remediation.
- **FR-055**: The system MUST support rebuilding the same host bundle against a newer
  approved base-system generation and MUST enforce a bounded snapshot-freshness policy
  during selection.

### Key Entities

- **Golden Snapshot**: A sanitized reusable disk image tied to one immutable host-bundle
  identity and one compatibility class. It carries provenance, lifecycle state,
  validation evidence, provider identity, retention protection, and failure metadata.
- **Compatibility Class**: The set of constraints that determine whether a snapshot can
  boot and safely activate on a requested VPS, including provider, architecture,
  provider region/reachability policy, base-system generation, boot expectations,
  minimum disk capacity, and activation constraints. Region reachability is evaluated
  for the requested target; a temporary regional outage is an attempt failure, not a
  global image defect.
- **Snapshot Build**: One durable attempt to prepare, sanitize, capture, and validate a
  golden snapshot. It records leases, retries, phase timestamps, bounded error codes,
  and any provider resources requiring cleanup.
- **Snapshot Validation**: Evidence from sanitation inspection and a fresh clone proving
  bundle integrity, absence of forbidden state, unique clone identity, fresh activation,
  and healthy exact-version startup.
- **Snapshot Lease**: A short-lived protection connecting an in-flight provisioning or
  recovery job to a selected snapshot so retention cannot delete it during server
  creation.
- **Provisioning Target**: The immutable bundle version and compatibility requirements
  resolved for one customer machine request before image selection.

## Security and Ownership Guarantees

- Golden snapshots are OS release artifacts, never customer backups or owner data.
- Every cloned VPS is single-owner infrastructure created for one authorized request;
  no server is reassigned between owners.
- Customer identity, database credentials, registration credentials, storage scope,
  and host identity are generated or delivered uniquely after clone creation.
- Snapshot builders and validation clones use synthetic identities that cannot access
  customer scopes.
- Any sanitation uncertainty prevents snapshot readiness. Availability is preserved by
  falling back to the clean-system-image path, not by weakening validation.
- Snapshot creation is a release capability. Status, retry, cleanup recovery, and
  destructive revocation are operator capabilities authenticated by a separate scoped
  credential that is never provided to host-bundle release automation; this feature
  introduces no unauthenticated customer snapshot-management surface.
- All mutations remain bounded, authenticated, auditable, and protected by the same
  release and provisioning authorization boundaries as the resources they affect.

### Authorization Matrix

| Operation or route | Caller | Authentication | Public? |
|---|---|---|---|
| `POST /system-bundles/snapshot-builds` | trusted host-bundle release workflow | existing `PLATFORM_SECRET` release bearer, compared in constant time | No |
| `GET /system-bundles/snapshot-builds/:buildId` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET`, compared in constant time | No |
| `POST /system-bundles/snapshot-builds/:buildId/retry` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | No |
| `POST /system-bundles/snapshot-cleanup/:cleanupId/retry` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | No |
| `POST /system-bundles/snapshot-builds/:buildId/callback` | the synthetic builder or validation clone for that build phase | short-lived, single-build phase callback token stored only as a hash; raw token delivered in provider user-data only to a root-owned tmpfs runtime file, presented only in the `Authorization` header, compared by digest in constant time, redacted from logs, consumed before capture, and removed with cloud-init state before the free-block overwrite and raw-device canary scan in FR-013 | No |
| `GET /system-bundles/snapshots?limit=1..100&cursor=<opaque>` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | No |
| `POST /system-bundles/snapshots/:snapshotId/revoke` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | No |
| `POST /system-bundles/snapshot-base-generations/:baseGeneration/revoke` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | No |
| `GET /system-bundles/snapshot-base-generations/:baseGeneration/affected-machines?limit=1..100&cursor=<opaque>` | authorized operator automation | separate `GOLDEN_SNAPSHOT_OPERATOR_SECRET` | No |
| existing customer provision/recovery routes | verified customer principal or existing trusted internal workflow, unchanged | existing Clerk, sync-JWT, and platform-internal authorization boundaries | No new public surface |

All path, query, and body inputs MUST be validated at the route boundary with bounded
schemas. Every mutating Hono route MUST apply `bodyLimit` before parsing: 8 KiB for
snapshot-build creation, 1 KiB for retry, 64 KiB for phase callbacks, and 4 KiB for
revocation. The existing provision/recovery routes retain their existing bounded-body
middleware. Cleanup retry uses a 1 KiB body limit. Snapshot identifiers or provider metadata never grant authority by
themselves.

Snapshot listing MUST enforce a server-side page size of at most 100 rows, accept only
a bounded opaque cursor issued by the server, order pages deterministically, and return
an optional next cursor. It MUST NOT materialize the complete lifecycle history in one
request.
Affected-machine inventory MUST apply the same maximum page size and bounded
server-issued opaque cursor, order deterministically by retained machine identity, and
return an optional next cursor. It MUST NOT materialize a generation's complete fleet
inventory in one request.

### Integration Wiring

- **Startup sequence**: Platform startup loads the bounded golden-snapshot runtime
  configuration, creates the existing Kysely/Postgres repositories and the injected
  provider adapter, mounts snapshot routes before generic system-bundle routes, and
  starts one bounded reconciliation loop. Shutdown stops and awaits that loop before
  platform-owned database and provider dependencies are destroyed.
- **Release-to-build path**: Host-bundle publication records the immutable release
  first. Eligible main, tag, and trusted manual release-dispatch workflows then call
  the authenticated build-enqueue route as an independent, non-blocking step. A
  durable reconciliation query also discovers eligible releases with no build so a
  missed workflow request is repaired without changing existing-fleet deployment.
- **Builder callback path**: The build worker creates only synthetic builders and
  validators through the injected provider interface. Each phase receives a bounded,
  single-build callback credential whose hash and expiry are persisted before the
  external create call. The callback body MUST be a bounded Zod discriminated union
  keyed by `phase`, with separate strict payload schemas and required evidence for
  `builder_booted`, `sanitized`, and each validation-clone result; parsing a generic
  record and casting it after route validation is forbidden. Routes validate that
  phase-specific envelope before invoking transactional lifecycle transitions.
- **Provisioning path**: Existing customer provision and recovery services resolve the
  immutable release, call the snapshot selection/lease repository, and pass an exact
  provider image ID into the existing provider client outside transaction scope. The
  existing clean-system-image path remains the automatic fallback when snapshot
  dependencies or compatibility checks are unsafe.
- **Cross-package communication**: Release scripts communicate with platform through
  authenticated HTTP contracts. Platform services receive repositories, provider
  clients, and worker callbacks through typed dependency injection; no `globalThis`
  or shell-to-kernel shortcut is introduced.
- **Config injection**: Snapshot enablement, build enablement, rollout percentage,
  compatibility defaults, retry/lease limits, a durable maximum of two concurrently
  snapshot infrastructure resources by default (bounded 1-10), provider timeouts, and callback origin
  flow from bounded environment-backed platform configuration into route, worker, and
  provisioning dependencies. The worker computes capacity from durable running build
  rows plus every cleanup-pending builder or validator whose exact absence is not yet
  confirmed, and claims only the remaining slots inside one advisory-lock transaction (or an
  equivalent targeted atomic statement), so concurrent workers and restarts cannot
  exceed the configured builder and validation-clone budget. A read-then-claim sequence
  outside that serialization boundary is forbidden. Provider credentials remain server-side and are never
  returned by operational APIs or embedded in reusable images.
- **End-to-end wiring test**: A fake-provider integration test MUST exercise eligible
  release registration -> idempotent build enqueue -> builder/sanitation callback ->
  provider image readiness -> validation callback -> atomic ready state -> exact/older
  selection and lease -> registration or clean-image fallback, including startup and
  shutdown of the bounded worker.

## Assumptions and Dependencies

- A provider snapshot can be used as the source image for a newly created VPS while
  still allowing fresh per-instance activation data.
- Snapshot storage is billed and quota-limited, so retention defaults to a project-wide
  bounded maximum while preserving promoted releases and rollback safety. Planning will
  set the initial numeric cap from measured snapshot size and provider quota.
- The established clean-system-image path remains tested and production-ready as the
  permanent fallback.
- Host bundles remain immutable and independently verifiable; snapshots optimize boot
  time but do not replace release metadata or bundle integrity checks.
- The image builder starts from the smallest supported disk/architecture combination
  for its compatibility class so the resulting image remains broadly usable.
- Snapshot production may complete after bundle publication. A new VPS created during
  that interval uses an older compatible ready snapshot plus exact activation, or the
  clean-system-image fallback.
- Existing provisioning, recovery, provider-deletion, and reconciliation behavior is
  the source of truth for machine ownership and orphan cleanup.
- Implementation planning will include tests first, production-shaped integration
  validation, release workflow changes, operator documentation, and a separate public
  site documentation PR.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For snapshot-eligible new computers, median time from accepted
  provisioning request to healthy registration decreases by at least 60% from the
  measured clean-system-image baseline.
- **SC-002**: Snapshot-eligible new computers reach healthy registration within 90
  seconds at the 95th percentile during the bounded production rollout.
- **SC-003**: 100% of eligible immutable host-bundle publications create or resume
  exactly one snapshot build per supported compatibility class within five minutes of
  successful bundle publication.
- **SC-004**: At least 95% of eligible snapshot builds become ready within 30 minutes;
  all failures are visible with a bounded reason and safe retry or cleanup state.
- **SC-005**: 100% of snapshot-based new and recovered computers report the exact
  requested host-bundle version before becoming routable.
- **SC-006**: Clean-clone validation finds zero customer data, reusable secrets,
  builder credentials, duplicated machine identities, or duplicated SSH host identities
  across all release-candidate snapshots.
- **SC-007**: During fault-injection tests for missing, rejected, quarantined, and
  incompatible snapshots, 100% of eligible requests either complete through the safe
  fallback or fail without producing two authoritative provider servers.
- **SC-008**: Existing-VPS host-bundle deployment success and rollback behavior remain
  unchanged when snapshot production is delayed, failed, or disabled.
- **SC-009**: Snapshot retention never deletes a freshness-eligible promoted,
  rollback-protected, or leased image in concurrency tests. A promoted image that has
  exceeded the configured freshness limit follows FR-042 instead. Unprotected retained
  snapshots never exceed the configured bound after reconciliation completes; when
  the protected floor alone
  exceeds that bound, the system alerts, blocks further snapshot production, and keeps
  clean-system-image provisioning available rather than deleting protected images.
- **SC-010**: The feature records zero cross-owner data, credential, database, machine
  identity, or host-key leakage incidents through synthetic, preview, and bounded
  production rollout.
