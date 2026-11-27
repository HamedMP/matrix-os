# Feature Specification: Runtime substrates and the hosted free tier

**Feature Branch**: `spec/2691-runtime-substrates-free-tier`
**Created**: 2026-11-10
**Status**: Draft, not approved for implementation
**Tracking**: Linear ticket pending (see Open decisions D0)
**Related**: [639-onprem-airgap](https://github.com/HamedMP/matrix-os/pull/3071) (ENG-423), [070-vps-per-user](../070-vps-per-user/spec.md), [103-self-host-installer](../103-self-host-installer/spec.md), [118-ai-gateway-provider-auth](../118-ai-gateway-provider-auth/), [543-matrix-ai-pi-routing](../543-matrix-ai-pi-routing/)

## Goal

Let a person use Matrix without paying and without a VPS. A free owner gets Chat and
app building on a Matrix-operated container that sleeps when idle, and can later move
everything to their own VPS.

To do that, a Matrix runtime stops being synonymous with a Hetzner machine. The owner
runtime (gateway, home, owner Postgres, object-store prefix, AI credential) runs on a
**substrate**. Two substrates exist after this work:

| Substrate | Who | Compute | Durable data |
| --- | --- | --- | --- |
| `vps` | Paid owners (unchanged) | One always-on Hetzner VPS | Local Postgres and home, backed up to R2 |
| `container` | Free owners | One isolated container per owner, stopped when idle | Managed Postgres database per owner, home mirrored to R2 |

One owner runtime codebase serves both. No second chat implementation, no second data
model, no multi-tenant gateway process.

## Non-goals

- On-prem and air-gapped installation. Spec 639 owns it and keeps its host-native
  delivery. This spec must not block it and shares its capability vocabulary (see FR-016).
- Changing anything a paid VPS owner sees or pays for.
- Always-on public backends, background agents, cron, channels, or bots on the free tier.
- Terminal, code-server, and CLI coding harnesses (Codex, Claude Code, OpenCode, Pi CLI,
  Hermes) on the free tier.
- Migrating a VPS owner down to a container.
- A new scheduler, multi-region placement, or high availability for containers.

## Anti-goals

These make the feature a failure even if it technically works:

- A free owner's code or agent reaches another owner's data, a platform-wide secret, or
  the host.
- Free usage has no hard spend ceiling, or a limit can be bypassed by switching client,
  racing requests, or recreating the container.
- A free owner loses saved work because compute was stopped, crashed, or replaced.
- Upgrading loses data or leaves the owner with two divergent copies.
- A paid owner's routing, billing, or data changes because the free tier exists or fails.

## User Scenarios & Testing

Every journey is checked through the real product with normal sign-in. Surfaces are
named exactly; see the surface matrix under Success Criteria.

### User Story 1 - Start free and chat (Priority: P1)

A new person signs up, chooses the free plan without entering a card, and is chatting
with Matrix AI on Web Desktop within the measured start target.

**Why this priority**: it is the whole acquisition path; nothing else matters without it.

**Independent Test**: a newly registered account with no machine and no payment method
sends a first message and receives a real model answer, with usage recorded to the owner.

**Acceptance Scenarios**:

1. **Given** a signed-in account with no runtime, **When** it selects the free plan,
   **Then** a container runtime is created for it and Chat opens without a billing gate.
2. **Given** free signup is invite-gated, **When** an uninvited account selects free,
   **Then** it sees a waitlist state and no runtime is created.
3. **Given** total free capacity is exhausted, **When** a new or sleeping owner requests
   a start, **Then** they get a truthful busy state with a retry path, and no partial
   runtime remains.

### User Story 2 - Build and preview an app (Priority: P1)

A free owner asks Chat to build an app. The agent writes real source, builds it, and the
owner uses the app in a window. App records persist.

**Why this priority**: app building is the product's differentiator and the reason a free
owner would upgrade.

**Independent Test**: generate a fresh interactive app, save a record in it, ask for a
source change, rebuild, and see the change with the record intact.

**Acceptance Scenarios**:

1. **Given** an active runtime, **When** the agent finishes a build, **Then** the app
   opens through the standard bridged app viewer and its data bridge works.
2. **Given** a build fails, **When** the owner opens the app, **Then** source is kept and
   the failure is shown; a stale build is never presented as the new one.
3. **Given** the runtime slept after a successful build, **When** the owner reopens the
   app, **Then** it loads without the owner asking for a rebuild.

### User Story 3 - Leave and come back (Priority: P1)

The owner closes the tab. The container stops. Days later they return and everything
saved is there.

**Why this priority**: scale-to-zero is what makes free affordable; persistence is what
makes it trustworthy.

**Independent Test**: save chat, files, and app records; force idle stop; destroy and
recreate the container; reopen.

**Acceptance Scenarios**:

1. **Given** a stopped runtime, **When** the owner opens Matrix, **Then** they see a
   truthful waking state, then their saved chats, files, apps, and app data.
2. **Given** a run is in flight, **When** the browser disconnects, **Then** the run
   continues to completion or its deadline, and the runtime stops only after it settles
   and durable state is flushed.
3. **Given** the container crashes, **When** it is recreated, **Then** every write
   acknowledged as saved is present, interrupted work is labelled as interrupted, and
   nothing is silently replaced with an empty home.

### User Story 4 - Hit a limit (Priority: P1)

The owner runs out of AI allowance, storage, or compute time.

**Why this priority**: bounded cost is the launch precondition.

**Independent Test**: exhaust each limit and confirm what is blocked and what still works.

**Acceptance Scenarios**:

1. **Given** the AI allowance is exhausted, **When** the owner sends a message, **Then**
   new funded work is refused with a clear reason and an upgrade or own-account path;
   reading, exporting, and deleting saved data still work.
2. **Given** storage is full, **When** the agent or owner writes, **Then** the write
   fails visibly, and read, export, and delete still work.
3. **Given** a container is deleted and recreated, **When** the owner resumes, **Then**
   usage and limits are unchanged and credentials from the old container are rejected.

### User Story 5 - Upgrade to a VPS (Priority: P1)

A free owner subscribes. Their chats, files, apps, app data, and remaining credit move
to a new VPS. The container is removed after the VPS is verified.

**Why this priority**: it is the revenue path and the promise made to free users.

**Independent Test**: populate a free runtime with sample data across every data class,
upgrade, and compare an inventory before and after.

**Acceptance Scenarios**:

1. **Given** a free owner completes checkout, **When** migration runs, **Then** the
   runtime is read-only during the final sync, the VPS restores from that exact state,
   and the owner lands on the VPS with the same handle and URLs.
2. **Given** migration fails at any step, **When** it is retried or abandoned, **Then**
   the container runtime is writable again with no data loss and the owner is not
   charged for a machine they cannot use.
3. **Given** migration succeeded, **When** verification passes, **Then** the container
   and its database are deleted and funded-AI balances belong to the VPS runtime without
   a second starter grant.

### User Story 6 - Same experience on every client (Priority: P2)

A free owner signs in on Electron Desktop and Native Mobile and gets the same Chat and
apps, the same waking and limit states, and the same explanation of what needs an upgrade.

**Why this priority**: clients currently refuse to proceed without a provisioned machine.
Web proves the system first; the others follow in the same release train.

**Independent Test**: sign in to each named surface with a free account that has a
sleeping runtime.

**Acceptance Scenarios**:

1. **Given** a sleeping runtime, **When** any client connects, **Then** it shows waking,
   then ready, and a draft typed during waking is sent once.
2. **Given** a capability is unavailable on the free tier, **When** the owner reaches
   it, **Then** it is shown as available on a paid computer, never as broken or missing.

### User Story 7 - Paid owners are untouched (Priority: P1)

**Independent Test**: run the same paid sign-in, chat, app, data, reconnect, Terminal, and
billing checks on a paid test VPS before and after, including while free containers are
failing, at capacity, and being migrated.

**Acceptance Scenarios**:

1. **Given** an existing paid owner, **When** the substrate model ships, **Then** their
   runtime is recorded as `vps` with no migration step visible to them and no behaviour
   change.
2. **Given** the free tier is switched off, **When** paid owners use Matrix, **Then**
   nothing changes, and free owners' saved data remains recoverable.

### Edge Cases

- Two tabs or two clients request a start at once: exactly one container is created.
- Idle stop races with a newly accepted message: the message wins or is rejected with a
  retryable state; it is never accepted and lost.
- A stale container keeps running after replacement: it cannot write to the owner's
  database or object prefix (generation fencing).
- Polling, presence pings, and open-but-idle WebSockets do not keep a container alive.
- Flush to object storage fails at stop: the stop is delayed up to a bound, then the
  runtime is marked needing recovery; the next start does not hydrate over newer data.
- The owner upgrades while a run is in flight: migration waits for settle or deadline.
- The owner deletes their account: container, database, object prefix, and funded-AI
  rows are removed under the existing deletion guarantees.
- A free owner is inactive past the retention period: published notice first, then
  deletion. Idle stop is never data expiry.
- A fresh disk boots: template setup must not write over an owner file that the accepted
  manifest holds. S4 reproduced this loss with today's boot order (template copy before
  hydrate; `system/soul.md` is not in the user-owned list). It affects VPS restores too.
- A home reaches the file-count cap: the write fails visibly, like a full home.

## Requirements

### Functional Requirements

**Substrate model**

- **FR-001**: Every runtime record MUST carry its substrate (`vps` or `container`).
  Existing records become `vps` with no behaviour change.
- **FR-002**: Routing, provisioning, lifecycle, and recovery MUST go through a substrate
  interface. Hetzner behaviour moves behind the `vps` implementation unchanged.
- **FR-003**: Clients MUST keep the existing address shape (`/vm/<handle>`, runtime slot).
  A container runtime has a handle like any other.
- **FR-004**: A runtime MUST declare its capabilities, and clients MUST render
  unavailable capabilities from that declaration and not from the plan name.

**Container runtime**

- **FR-005**: The container runtime MUST be the same gateway, kernel, and shell code as
  the VPS runtime, composed with a container profile. It MUST NOT require host systemd.
- **FR-006**: Agent and build workloads MUST run inside a sandbox at least as strict as
  the existing scope-runtime bot profile (no ambient network, no gateway secrets,
  resource caps), using the existing launcher interface.
- **FR-007**: Durable state MUST live outside the container: one Postgres database and
  role per owner, and the owner's object-store prefix. Local disk is a cache.
- **FR-008**: The runtime MUST reach "ready" only after the boot set matching the
  accepted manifest is hydrated and the database is reachable. It MUST never start on an
  empty home when durable data exists. The boot set is owner-owned configuration, agent
  definitions, owner app manifests and icons, and the kernel database snapshot; template
  files come from the image. The rest of the home fills in the background. File routes
  answer from the manifest or fetch on miss while the fill runs. Agent turns (and a
  terminal, on profiles that have one) MUST wait for the full hydrate, because their
  child processes read the home directly. (Revised after S4: the earlier text gated
  ready on the whole home.)
- **FR-009**: The runtime MUST stop only after in-flight runs settle or reach their
  deadline and a final flush succeeds. Meaningful activity is: an accepted message, a
  running job or build, an open app or preview in use. Polling is not. The final flush
  MUST run in this order: files, then the manifest commit, then the owner Postgres dump,
  because the manifest pointer lives in owner Postgres and an earlier dump restores an
  older pointer.
- **FR-010**: Built app output MUST survive a stop, so reopening an app does not require
  a rebuild.
- **FR-019**: Template setup MUST NOT write over any owner file present in the accepted
  manifest, on any substrate. `system/soul.md` is seed-only: written when absent, never
  overwritten.
- **FR-020**: The container profile MUST NOT run boot-time `git init` on the home. How
  project history is persisted, and whether `.git` counts against the home size limit,
  is open (D8).
- **FR-021**: App builds MUST run as a separate build workload in the same sandbox as
  agent work, launched by a gateway-side build tool with fixed argv. The agent worker
  gets no shell. The build workload runs no package scripts, uses a pinned pnpm from the
  runtime, reaches only the platform's registry mirror, and has a wall-clock timeout and
  a free-space check. A timeout, a full disk, or a failed build reports `needs_build`
  with a safe error and keeps the previous output (US2 scenario 2). Basis: S3; the agent
  loop and the bridged viewer were not exercised there.
- **FR-022**: The home MUST have a file-count limit as well as a byte limit (default
  50,000 files, the current mirror state cap).

**Free plan, admission, limits**

- **FR-011**: A free plan MUST exist as an entitlement that allows exactly one container
  runtime and no VPS. Signup MAY be gated by invite and by a global capacity ceiling.
  An owner whose paid plan has ended MAY take the free plan; an owner with an active,
  trialing, past-due, or grace-period paid plan MUST NOT.
- **FR-012**: Funded AI MUST reuse the existing owner-serialized admission, holds, and
  settlement. A container runtime gets its own runtime policy with a model allowlist and
  a budget. Starter credit stays once per owner across substrates.
- **FR-013**: CPU, memory, process count, job duration, storage, database size, egress,
  and concurrent runs MUST be enforced outside the container or by the substrate, never
  only by code the owner's agent can modify.
- **FR-014**: Exhausted limits MUST still allow bounded read, export, and delete.

**Upgrade**

- **FR-015**: Upgrade MUST move the owner's database, files including app sources and
  project history, built apps, runtime configuration, and funded-AI balances to a VPS
  using the existing VPS restore path. It MUST be resumable and reversible until
  verification, and MUST keep the handle.

**Coordination**

- **FR-016**: Capability states and profile vocabulary MUST match the deployment
  capability contract proposed in spec 639 so hosted-container and on-prem do not grow
  two capability systems. Whichever lands first owns the contract file.
- **FR-017**: The "VPS-native only" production rule in `AGENTS.md` and
  `docs/dev/vps-deployment.md` MUST be amended in the same stack that enables the
  container substrate, to say: paid runtimes are VPS-native; free runtimes are
  platform-operated containers; Docker Compose remains unsupported as a customer runtime.
- **FR-018**: Public docs in `FinnaAI/matrix-os-site` MUST describe the free plan, its
  limits, what needs a computer, and the upgrade.

### Key Entities

- **Runtime**: an owner's Matrix instance. Has a substrate, handle, slot, generation,
  status, and capability set.
- **Substrate**: where a runtime's compute runs and how it is started, stopped,
  addressed, and replaced.
- **Runtime generation**: a counter that changes when compute is replaced. Stale
  generations cannot write or authenticate.
- **Free entitlement**: permits one container runtime; carries limits.
- **Migration**: a recorded, resumable move of one owner from container to VPS.

## Security architecture

**Trust model**: a free container is untrusted. Its owner may be hostile, and its agent
runs arbitrary code. Anything inside the container can be read by that owner. Therefore
the container holds only credentials scoped to that one owner, and every limit is
enforced by the platform or the substrate.

| Boundary | Auth | Authorization and limits |
| --- | --- | --- |
| Client to platform | Existing Clerk session, sync JWT, or device token | Owner may reach only runtimes they can access today |
| Platform to container | Per-handle platform verification token plus verified-user header (existing) | Routed only to the current generation's private address |
| Container to platform internal routes | Per-runtime HMAC token bound to machine, slot, and token epoch (existing) | Rejected when generation is stale or runtime is not running |
| Container to funded AI relay | Short-lived per-runtime lease (existing) | Owner-serialized holds, model allowlist, budget |
| Container to object store | Platform broker with owner-prefix check and presigned URLs (existing) | Plus a per-owner byte quota enforced by the broker |
| Container to Postgres | Per-owner role and database | Connection limit and temp-file limit enforced by Postgres; size measured and enforced by the platform; statement timeout is a role default the owner can override, so the platform cancels long statements |
| Container to internet | Substrate egress policy | Default deny; allowlist for package registry and platform; rate and byte caps |
| Sandbox to gateway | Broker socket (existing) | Workload never holds a provider key or database URL |
| Lifecycle and migration routes | Platform-internal bearer or owner session | See plan auth matrix |

Additional routes covered by the plan's auth matrix: container registration (per-runtime
HMAC token, current generation only), invite administration (platform operator auth),
and the checkout-to-upgrade trigger (verified Stripe webhook, never a client claim).

**Generation fencing.** Replacing compute bumps the runtime's generation and token
epoch and rotates the owner database role password in one transaction before the new
container starts. The object broker and every internal route reject a token from an
older epoch. A stale container therefore loses database, object, and platform access
even if it is still running.

**Who may wake a runtime.** Only an authenticated request from the runtime's owner
starts a stopped container. Collaborators, share-link viewers, webhooks, and
unauthenticated traffic get a "not available" response and never start compute.

**Egress.** Default deny, including private, link-local, and loopback ranges, the
provider metadata endpoint, and platform-internal addresses other than the named
internal routes. Package installs go through a platform-operated pull-through registry
mirror with rate and byte caps. It allows only GET and HEAD of package metadata and
tarballs, fetches upstream over TLS with redirects refused, and caps metadata size. The
build workload reaches it only through a dedicated Unix socket in its sandbox (S3). The
recommended design has the gateway forward that socket and add the runtime token, so the
workload never holds it; this is open (D9). Agent web tools are brokered through the platform under the same
per-owner caps; the container has no direct general internet route.

**Secrets.** Runtime credentials are injected through the provider's secret mechanism
at start. They are never baked into the image, written to logs, or placed in URLs. All
token comparisons are constant-time.

Input validation: every new route validates path, query, and body with Zod at the
boundary and uses `bodyLimit`. Substrate addresses come from the platform's own records,
never from client input. Errors to clients are generic; provider names, addresses, and
quota internals stay in server logs.

Residual risks to record: the owner can read their own runtime credentials (bounded by
the quotas above); the in-container gateway still trusts the app name sent to the data
bridge (threat-model finding F3), which crosses app boundaries only within one owner.

## Integration wiring

Flow: authenticate, resolve owner, resolve runtime and substrate, check entitlement and
capacity, start or attach, hydrate, verify ready, serve, account, idle stop with flush.

- Platform: substrate registry is built at startup from config; each substrate is
  constructed only when its configuration is complete. A missing container configuration
  is a 503-class state, not "no runtime found".
- Gateway: profile is validated once at startup into an immutable capability set. The
  sandbox launcher is chosen at startup by dependency injection, never probed at call time.
- No `globalThis`, no client-side inference of substrate.

Platform components, each constructed in platform startup, started after the database
is ready, and stopped (timers cleared, in-flight work drained) on shutdown:

| Component | Depends on | Owns |
| --- | --- | --- |
| `SubstrateRegistry` | config, `vps` and `container` substrates | Substrate lookup by runtime record |
| `ContainerLifecycleService` | registry, database, provider adapter | Create, wake, quiesce, stop, replace |
| `ActivityTracker` | routing middleware | Last owner activity per runtime, observed at the proxy |
| `IdleReaper` | activity tracker, lifecycle service | Recurring idle sweep |
| `OrphanReconciler` | provider adapter, database | Recurring deletion of compute with no current record |
| `MigrationRunner` | lifecycle service, VPS provisioning, funding repository | Resumable upgrade state machine |

**Idle authority.** The platform decides idleness from owner traffic it observes while
proxying, plus the count of unsettled runs the platform already tracks through funded
reservations. Activity reported by the container is advisory and can only shorten, never
extend, a session. A hard maximum session length applies regardless.

**Configuration.** Container substrate settings (provider credentials, region, image
reference, private network), the shared database admin URL, per-owner limits, global
ceilings, and the invite gate are read from environment at startup and validated once.
The container itself receives: handle, owner id, machine id, runtime slot, generation,
its own database URL, its runtime token, the platform internal URL, the funded relay
URL, and the runtime profile name.

## Failure modes

| Failure | Outcome |
| --- | --- |
| Start exceeds its deadline | Runtime marked failed-start, compute cleaned up, client shows retry |
| Boot set not hydrated | Not ready; never serves a home without its owner configuration |
| Background fill incomplete | Ready, but agent turns wait; file routes answer from the manifest or fetch on miss |
| Database unreachable | 503-class state; chat history is not replaced by file fallback |
| Flush fails at stop | Bounded retries, then needs-recovery; no blind re-hydrate over it |
| Container crash | Recreated on next request with a new generation; unflushed window is bounded and reported |
| Duplicate start | One winner by unique constraint on (runtime, generation) |
| Substrate API outage | Running containers keep serving; starts return busy |
| Migration step fails | Step is idempotent and resumable; container returns to writable on abandon |
| Uncertain external effect | Surfaced for the owner; never blindly replayed |

All substrate and broker calls have timeouts. Lifecycle operations are idempotent and
keyed by runtime and generation.

Provisional timeouts, all configuration-driven and revised after Phase 0:

| Operation | Timeout |
| --- | --- |
| Provider API call | 10 s |
| Start to ready (cold start, any home size) | 90 s failure timeout |
| Wake to ready after the boot set | Target under 5 s at the median (SC-003); not a failure timeout |
| Quiesce (wait for runs to settle) | run deadline, at most 15 min |
| Final flush | 120 s, 3 attempts; read from configuration (today's mirror `stop()` has a hard-coded 10 s) |

S4 measured these with the proposed layout (packs, one manifest per flush) at 20 ms per
request: large home (2.44 GB, 49,494 files) hydrate 18-19 s and full flush 21-25 s;
owner Postgres dump 0.5 s at 53 MB and 2.6 s at 525 MB. Today's mirror does not fit:
medium hydrate took 145-233 s and `stop()` landed 32-56 of 100 changes. The 5 s wake
target is not proven. A loaded Linux host took 11 s to boot the gateway alone on one
CPU, 4.25 s of it a terminal-runtime retry before listen. No idle 1 vCPU measurement
exists yet.
| Readiness probe | 5 s |
| Migration step | 10 min per step, resumable |

**File and database consistency.** Database writes are durable immediately; files are
flushed on a timer (provisionally every 30 s) and at stop, so a crash can lose at most
one flush interval of file changes. Each flush is one batch with one manifest
generation, not one manifest per file, and ends at a barrier: every change seen before
the flush started is in the accepted manifest. The timer flush, the final flush, and the
upgrade drain all use that barrier. On start after a crash the runtime compares the
flushed manifest with database references and marks affected chats and apps as
interrupted. It never deletes database rows to match files.

**Needs recovery.** A runtime whose final flush failed is not hydrated over. The next
start reuses the surviving container disk if the provider still has it; otherwise it
hydrates the last good manifest and reports the lost interval to the owner.

**Billing on a failed upgrade.** The subscription begins at checkout as it does today.
If migration has not completed within its deadline, the platform alerts support, keeps
the container writable, and applies the existing refund path. No new billing mechanism
is introduced.

**Carried-forward debt.** Kernel state in `system/matrix.db` is existing SQLite, not
new persistence. This spec only requires a consistent snapshot of it at flush: a
`VACUUM INTO` copy taken from a separate read-only connection, stored in the boot set,
and restored before the gateway opens the database. `system/matrix.db*` is excluded from
file sync. In S4, `VACUUM INTO` restored cleanly after 30 of 30 kills; copying the files,
as the mirror does today, restored cleanly 0 to 2 times in 30.

## Concurrency and state

- **Single-flight start.** A start is a compare-and-set on the runtime row under a row
  lock: `stopped` to `starting` with the generation the caller read. Losers attach to
  the winner's start and do not create compute.
- **Stop versus new work.** Stopping is a handshake. The platform sets `quiescing`; the
  gateway atomically stops accepting new runs and replies with its unsettled count; the
  platform holds new owner requests during the window and either cancels the stop or
  replays them after restart. A request is never accepted by a runtime that then stops.
- **Limits.** Every limit is enforced by one atomic statement or a held lock, never by
  read-then-write.
- **Balance transfer.** Upgrade takes the existing per-owner funding advisory lock,
  waits for unsettled reservations, then moves balances to the staged VPS row and
  switches the owner to it in one transaction (D10).
- **Migration state.** Transitions are compare-and-set on the migration row; each step
  is idempotent so a crashed runner can be resumed by another.

## Resource management

- Per-owner caps: CPU, memory, processes, job duration, concurrent runs, home size,
  database size and connections, egress bytes, AI budget. Values are set in Open
  decision D3 after measurement.
- Global caps: running containers, total containers, daily funded spend, egress.
- Cleanup: compute is deleted on stop or after a bounded sleep period; durable data is
  deleted only by account deletion, retention expiry after notice, or completed upgrade.
- Orphan sweep: compute with no current-generation record is deleted by a recurring
  reconciler; databases and prefixes are never deleted by the sweep.
- Platform registries for wake requests and in-flight starts are bounded with TTL.
- Inside the container: build caches and hydrate temp files are capped and cleared at
  stop; temp sweeps skip symlinks.
- Build store: a per-owner pnpm store and metadata cache outside the flushed home, under
  a disk quota. The sandbox's 256 MiB `/workspace` tmpfs cannot hold a medium resolve
  (S3). Where it lives is open (D9); about 0.5 GB covered the heaviest S3 app.
- Build memory: S3 measured 0.3 to 0.9 GB per build and 1.24 GB for a heavy resolve. The
  providers do not delegate cgroups, so only rlimits apply per workload. The 4 GiB
  address-space limit holds only with `PNPM_MAX_WORKERS=2` and `MALLOC_ARENA_MAX=2`.
- Packs: superseded bytes are reclaimed by a recurring repack. Manifests are sharded or
  written as deltas, because S4 measured a 16 MB manifest upload on every flush of a
  large home.

Provisional per-owner defaults, configuration-driven, so limit tests can be written now:

| Limit | Default |
| --- | --- |
| CPU and memory | 1 vCPU, 2 GiB |
| Processes | 256 |
| Concurrent runs | 1 |
| Run duration | 15 min |
| Idle before stop | 10 min |
| Maximum session | 4 h |
| Compute per month | 80 billed hours (UTC month, idle tail included); at the cap, no wakes until the 1st except 2 export-only wakes of 15 min; running sessions stop through the normal flush (tasks T057a to T057g) |
| Home size | 2 GiB; bytes held for a signed upload URL stay counted until it expires (about 16 min), even after a delete or smaller overwrite |
| Home files | 50,000 |
| Database size and connections | 500 MB, 5 connections; size is held by a platform sweep that moves table ownership to a holder role and leaves the owner read, delete, and truncate only, because the owner role owns its tables and can switch off its own read-only setting (T055a) |

**Connection budget.** Running containers times 5 connections must stay under the
shared cluster's limit with headroom; the global running-container ceiling is derived
from it, and no pooler is used (S5): the gateway connects directly within a connection budget of 5.

**Data flow.** Owner data is processed in memory by the container provider in the
owner's chosen region and stored in Matrix-controlled Postgres and object storage. No
owner data is sent to any new third party beyond the container provider.

## Success Criteria

- **SC-001**: Journeys 1 to 5 and 7 pass on Web Desktop with normal sign-in, real model
  calls, real builds, and real storage. Journey 6 passes on each remaining surface.
- **SC-002**: Saved samples survive 10 stop and start cycles, 3 container deletions, and
  1 forced crash, with the unflushed window measured and inside its bound.
- **SC-003**: 20 cold starts and 20 wake-from-sleep trials are reported with raw
  timings, median, and maximum, separating image pull from cached start. The wake target
  is a median under 5 seconds from an authenticated request to an interactive runtime,
  where interactive means ready after the boot set (FR-008), not after the full home.
  The provider choice (D1) is ranked on it. Cold start is held to the 90 s ceiling
  instead. The maximum is agreed after the Phase 0 measurement. Whether 5 s holds on
  1 vCPU with the real image is open: S4 needed prebuilt JS, no boot-time `git init`,
  and no terminal-runtime wait before listen to get near it, and did not measure 1 vCPU.
- **SC-004**: Two-owner denial tests pass: cross-owner database, object prefix, network,
  and credential access all fail. Limit races hold. Stale-generation credentials fail.
- **SC-005**: An upgrade inventory (row counts per table, file manifest, app list,
  balances) matches before and after for three sample owners, including one failed and
  resumed migration.
- **SC-006**: Paid controls pass before and after, and during free-tier failure injection.
- **SC-007**: Idle free owners cost no compute. Measured monthly cost per active free
  owner is reported against the budget in D3.

### Surface matrix

| Surface | In scope | Notes |
| --- | --- | --- |
| Web Desktop | Yes, first | Proves the system |
| Web Canvas | Yes | Same shell build; presentation switch must work |
| Electron Desktop | Yes | Device sign-in must accept a container runtime |
| Web Mobile | Yes | Follows Native Mobile behaviour |
| Native Mobile | Yes | Journey gate must accept a sleeping container runtime |

Each included surface needs its own live screenshots and recording. No surface becomes
N/A without architectural rationale and reviewer approval.

## Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| D0 | Linear ticket | Decided: [ENG-446](https://linear.app/matrix-os/issue/ENG-446/runtime-substrates-container-based-free-tier-alongside-vps); stacks share it |
| D1 | Container provider | Decided 2026-11-10: AWS Lambda MicroVMs, with Cloud Run gen2 as fallback (research.md R4) |
| D2 | Free AI allowance | Decided 2026-11-27 (replaces 2026-11-13's $5 per month): once-per-owner starter credit plus $5 per UTC day (expires at day end), at most $20 of allowance usage per owner per UTC month, limited to the managed default model, under the global daily spend fuse; own-account sources stay available |
| D3 | Limits and retention | Compute decided 2026-11-14: 80 billed hours per month, then read-only with export until the 1st. Retention: propose 90 days inactivity, 30 days notice |
| D4 | Signup gate | Invite-only until SC-004 and SC-007 hold in production for two weeks |
| D5 | Free capability set | Chat (Matrix AI), Files, app build and use, Settings. Terminal, coding CLIs, channels, cron, bots, integrations with platform secrets: paid |
| D6 | App preview sharing | Owner-only at launch; sharing via existing Sites private links later |
| D7 | Relationship to spec 639 | Agree with ENG-423 owner who lands the capability contract first |
| D8 | `.git` and project history | Open. `.git` is not mirrored today, and S4 measured 1.4 GB of it for a large home and 65-92 s of boot-time `git init`. Options: pack history into the home (plan T045) and count it against the home size, or keep a size cap on history |
| D9 | Build store and egress token | Open (S3). Store as a second writable bind under quota or a quota'd cache inside the home excluded from flush; egress through a gateway-forwarded socket (recommended) or a direct platform endpoint. Also open: whether default apps are ever rebuilt in the container |
| D10 | Upgrade machine row | Decided 2026-11-15: the VPS is built on its own staged `user_machines` row, kept outside the `(clerk_user_id, runtime_slot)` and `(handle, runtime_slot)` active-row unique indexes until the switch; the container stays usable until the target is verified; rollback drops the target. Staging mechanism chosen in T061; see data-model.md, "Upgrade and the machine row" |

## Stakeholder review

Recommended before implementation: platform and billing owner (substrate model, free
entitlement), security (trust model, egress), client owners for Electron Desktop and
Native Mobile (sign-in without a machine), and the ENG-423 owner (shared contract).
