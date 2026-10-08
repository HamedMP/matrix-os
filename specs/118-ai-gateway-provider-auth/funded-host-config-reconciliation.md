# Funded host configuration reconciliation

## Scope and authority

Repair missing funded Chat configuration through a reviewed immutable host
release and an explicitly scoped update. Platform Postgres remains authoritative
for current machine identity, owner, activation, slot, credential epoch, policy,
account deletion and unsettled obligations. This capability performs no grants,
reservation, probe, settlement or financial recovery.

## Auth and wire contract

`GET /internal/containers/:handle/funded-host-config` requires the existing
machine-scoped Sync HMAC bearer and matching machine ID, primary slot and
canonical positive epoch headers. Validate the current running, authorized,
nondeleted customer-primary machine within a repeatable-read, explicitly
read-only transaction with a bounded statement deadline. Do not accept the
legacy handle-only Sync token or synthesize an owner session.

The deployment gate defaults off. The reviewed cohort is unique, bounded to
100 UUIDs and empty by default; its absolute UTC validity is explicit and no
more than seven days at deployment. Bind source SHA to deployed source. Require
enabled global/runtime policy and a supported ordinary Chat model. Pending or
completed account deletion and any nonterminal or unknown machine/slot obligation defer delivery,
even if old obligation owner metadata differs. A settled label without actual
cost is insufficient evidence of financial closure.

Return no-store strict version-1 configuration containing only enabled="true",
the reviewed untagged production Relay HTTPS origin, a current-epoch runtime
credential and the fixed canonical Platform origin. Bind machine, handle,
slot, epoch and source SHA; response validity is at most 30 seconds and bounded
by policy/cohort expiry. A well-formed cohort that has expired before a new
Platform instance starts disables this capability and leaves the route unmounted;
unrelated Platform routes remain available without repair database access.
Instances already serving the route return unavailable after expiry. Deployment
preflight still rejects expired windows, and malformed settings still fail startup.
Reject extra fields, query parameters and arbitrary
commands, paths, environment values, provider models or budgets. Errors stay
coarse and logs never contain credentials.

### Route authorization matrix

| Route / resource | Authentication and authorization | Public |
| --- | --- | --- |
| `GET /internal/containers/:handle/funded-host-config` | Machine Sync HMAC bearer plus matching UUID, primary slot and current epoch; fresh machine, owner, policy and financial admission | No |
| `POST /vps/deploy` | Existing Platform-secret bearer; reviewed single handle and registered immutable version | No |
| `GET /system-bundles/releases/:version.json` | Existing public release-metadata read; validated immutable version; no owner session or machine token | Yes |
| Exact presigned R2 archive URL returned by release metadata | Validated signed object-read capability, exact version namespace and pinned public TLS transport; never forward Platform credentials | Capability URL only |

The release-metadata read is public; the archive capability grants only the
identified object read. Neither authorizes funded configuration or maintenance.

### Concrete resource and timeout limits

The protected host HTTPS transport uses a 15-second socket timeout for metadata,
configuration and archive requests. Metadata/configuration body reads have a
15-second monotonic deadline starting after response headers; archive body reads
have a 180-second deadline. Each read is still subject to the socket timeout:
these are phase deadlines, not a total request wall-clock cap. Requests reject
redirects and response bodies above their fixed limits. The archive is at most
2 GiB; hashing the held snapshot and decoding its at-most-20-GiB expansion each
have a separate 180-second deadline. Temporary snapshots are removed on exit.

Fixed systemd-control subprocesses have 10-second timeouts. Maintenance queues
recorded active-service stops with `--no-block`, then independently verifies all
are inactive or failed within a 120-second monotonic stop window before any
post-stop configuration inspection or write. This includes Terminal/Scope stop contracts
of 30/45 seconds and the manager default stop deadline with query margin.
An unfinished or failed stop retains the resume journal and performs no repair
write. Restoration first waits for recorded deactivation to finish within its
existing deadline, then queues fixed startup jobs with `--no-block`, verifies the
recorded non-Sync services,
then queues and verifies Sync last. Each restoration attempt has a 1,600-second
monotonic deadline, with at most one final 10-second subprocess overrun; this
covers the existing sequential Terminal and Gateway 720-second startup contracts.
The maintenance unit retains `TimeoutStartSec=180`: interruption releases the
restoration lock and its protected `ExecStopPost` retries from retained evidence
under `TimeoutStopSec=1800`. Failed or unconfirmed restoration retains the exact
resume journal; another maintenance invocation cannot replace it. Before stopping
services, the journal binds the original service list to exact protected receipt
bytes and the guarded original environment digest. Persist the same baseline
before field writes, and authorize a complete post-image only after successful
stopped inspection. Resume holds the environment writer lock in shared mode,
verifies the installed component and bundle, and restarts runtimes only when the
environment matches the original baseline or explicitly verified post-image. An
unknown image permits only originally recorded Sync to resume; repeated partial
recovery preserves the full journal unchanged. Missing, legacy or corrupt safety
proof defers without restarting runtimes. Installed
inactive or failed Gateway dependencies defer repair before any service stop or
configuration change, while absent optional units remain absent. A successful
stop-post restoration can leave the interrupted oneshot marked failed; acceptance
requires independent service, configuration and journal readback rather than the
oneshot status alone. Platform admission sets a local PostgreSQL statement timeout of
5 seconds inside the read-only transaction. That bounds individual statements,
not pool acquisition or the complete transaction. Response validity remains at
most 30 seconds and is rechecked at host admission before any mutation.

## Host execution and release trust

Canonical HTTPS release metadata and checksum verification establish artifact
provenance; do not call this a cryptographic signature. Inherit the existing
owner-admin updater trust explicitly. Install privileged new payload beneath
root-owned nonwritable ancestors, using fixed system Python, no-follow file
descriptors, bounded same-descriptor archive snapshot/hash, narrowly selected
regular members (plus an optional exact zero-size `funded-host-config/`
directory header), atomic replacement and directory fsync. Do not execute
unverified extracted Python as root or trust mutable application imports.

Release metadata may contain a presigned object-store capability. Fetch the
archive directly only after validating its bounded HTTPS Cloudflare R2 hostname,
exact version namespace and signing-query structure. Resolve globally routable
addresses and pin the selected IP while verifying TLS for the original hostname;
never forward Platform authorization, follow redirects or log query values.
Bound download, same-descriptor hashing, archive expansion, temporary disk use
and retention. A matching protected installed receipt is an idempotent no-op.

Startup installs the protected capability without stopping customer activity.
Configuration application belongs only to an explicit reviewed update within
a coordinated idle/writer window. Passive updates and startup polling cannot
trigger maintenance. A predecessor that cannot run the new hook may require
two immutable releases from the same reviewed source; test that delivery chain
instead of claiming the first install applied configuration.

Bind maintenance to the exact committed release and a bounded protected
invocation receipt. Recheck current remote admission before stopping fixed
services and again after independently verifying stopped runtime services.
Distinguish a validated retained completed rollback transaction from active
update writers. Never delete rollback evidence merely to pass admission.
Restore the prior service state after apply, no-op or deferral.

## Rollback and acceptance

Write only the four reviewed funded fields through guarded atomic file/journal
operations, preserving unrelated configuration and owner data. Each new apply uses
a random protected attempt ID under a nonblocking root lock, retains prior journals,
and defers while an unresolved marker owns rollback authority; unchanged applied state
remains a no-op, and legacy journal IDs remain valid. Reject a changing apply with
existing evidence before stopping services. Failure cleanup may roll back only the
invocation-owned attempt, rechecking its exact ID under the protected lock. A validated explicit request
for the installed version may retry maintenance after an unchanged trigger claim.
Retire only the consumed version/channel identities without deleting concurrent
replacement targets or the prepared release marker, so a later trigger-only
apply can still install its pending newer release. Missing/inconsistent
protected receipts defer, while passive, repair and signal
paths never schedule this retry. Installation and maintenance share the fixed
root-only `resume.lock` with
restoration. Installation acquires it before `install.lock`; all acquisitions
are nonblocking. A pending restoration journal prevents every changing install
before staging or receipt replacement. A verified unchanged installation may
remain a no-op, preserving that journal and its matching receipt. Hold the
maintenance lock across service admission, journal creation and restoration;
restoration must use the existing lock rather than acquire it recursively.
An explicit
request for the saved prior repair release first schedules guarded field rollback
on the currently installed protected component; it retains that component,
receipt and app version until field rollback is independently confirmed. Keep cohort configuration enabled
solely for fresh read-only financial admission during this operation, then disable
it before retrying the exact prior release deployment. That ordinary update
installs the prior protected component together with its matching app release;
never restore an older receipt while the current sync service can reinstall the
new component. This order is safe only
because startup, passive updates and timers cannot reapply configuration; stale
or concurrent maintenance must fail closed. Do not disable the only remote
financial-admission path and infer zero liability locally.

Automatic recovery of a failed, uncommitted newer update is a separate,
read-only exception: restore only the app still identified by the current
committed metadata and protected receipt, leaving funded fields and applied
evidence intact. Before stopping services, verify that recovery is available;
an incomplete journal, changed environment/identity/epoch, busy repair/install
lock or inconsistent receipt/component/unit defers the update while healthy.
The protected program independently verifies the root-sealed uncommitted
transaction and its saved committed metadata, actual current or rollback app,
complete original/post-image journal and unchanged environment digest. A caller
flag alone cannot authorize recovery, and initial manual rollback remains denied.
Prefer the matching current app for a pre-swap failure or interrupted recovery;
ignore an unrelated older rollback app. Recheck after restoring artifacts before
resuming recorded services. A subsequent successful update installs its matching
protected receipt; the complete applied journal remains valid independently of
the version originally used to name that journal. This exception makes no
network admission request, financial change, field write or evidence deletion.

A same-version artifact reinstall has separate recovery authority. Before any
service stop, its root-sealed transaction pins the exact protected receipt and
pre-swap app directory identity. The protected program independently hashes a
held staged archive against the receipt checksum and verifies the enclosed
component and unit bytes against their pinned digests. Version equality alone
neither admits this path nor proves that the transaction committed. Staging
cleaners and every apply failure cleanup retain only the exact archive referenced
by a pending sealed same-version transaction until recovery resolves it; unrelated
staging keeps its normal cleanup policy. A subsequent apply must defer before
download or phase replacement while this recovery pin remains. Retention is a
transaction dependency, not a special case confined to TTL cleanup: changing
recovery proof requirements must update every producer, remover and retry path.
After verified health, committed release metadata and required post-install
migrations, retire only the completed same-version recovery pin, independently
verifying the current receipt, installed component/unit hashes and new/rollback
app identities. Retain manual rollback transaction artifacts and financial
evidence. A successful reinstall must admit a subsequent normal update. Unknown
proof or cleanup failure retains the pending phase and recovery evidence. Death
after pin retirement but before phase clearance is an ambiguous orphan: an
active phase with funded applied evidence still blocks another apply before
download; pin absence alone never proves a same-version commit.
An absent, corrupt or symlinked pin permits only conservative retention of the
exact root-sealed candidate archive with complete applied evidence and an active
health phase; it grants no commit, recovery or subsequent apply authority.
Executable regressions must fail restoration and service resumption independently,
then exercise a later protected retry against the same retained archive and verify
unchanged configuration, applied evidence and journals. The pinned app identity
distinguishes pre-swap current state from the saved rollback app
when both carry the same version. Missing, altered or inconsistent proof defers
before service stop; recovery retains funded configuration and applied/journal
evidence and cannot authorize manual field rollback. Verify both pre-swap and
post-swap interruption paths in the actual generated updater lifecycle.

For a two-hop repair, the saved prior artifact is the configuration-free first
repair release. Restoring it is distinct from restoring the original customer
release; the latter requires a subsequent explicit deployment of its independently
recorded immutable version. A downgrade must not leave automatic repair execution
or a pending maintenance invocation active. An unknown write/restart outcome
requires independent readback before retry.

Old releases have no complete machine-wide idle endpoint or atomic drain.
Health, task listings and caller assertions cannot prove absence of active
work. Obtain an owner-coordinated first-install window or defer that machine;
financial admission alone does not cover nonfunded or terminal activity.

Keep installed release, loaded configuration, credit projection, model
readiness and once-only usage settlement as distinct evidence. Preview-slot
tests can establish installation and denial, but cannot stand in for positive
customer-primary authorization. Require exact-source disposable VPS and
Electron Desktop evidence before customer rollout.

## Required verification

Route/wiring tests must cover default-off and empty cohorts, current HMAC and
epoch binding, legacy/owner auth rejection, canonical origins, bounded expiry,
policy and account-deletion deferral, stale-owner obligations, corrupt closure
and unchanged financial state. Workflow tests validate before cloud auth.
Host tests must exercise the actual protected install/apply/no-op/rollback
chain, archive and ancestor mutations, stale maintenance scheduling, explicit
versus passive updates, stopped-runtime admission and downgrade behavior.
Mocks or importer receipts alone are not live production acceptance.

## Executable contract reference

### 1. Scope / Trigger

A reviewed running customer-primary machine lacks managed funded Chat settings.
The operator uses an explicit immutable version update within a coordinated
owner idle window. Preview denial, installer fixtures and credit display alone
are not positive customer repair acceptance.

### 2. Signatures

- API: `GET /internal/containers/:handle/funded-host-config`, no query/body.
- Auth: `Authorization: Bearer <machine Sync HMAC>`;
  `x-matrix-machine-id: <UUID>`; `x-matrix-runtime-slot: primary`;
  `x-matrix-runtime-token-epoch: <canonical positive integer>`.
- Source: `createFundedHostConfigRoutes({db, platformSecret, config, ...})` and
  `registerFundedHostConfigRoutes(app, options)` before owner-session routing.
- Fixed host entry: protected component `--maintenance`, guarded local
  `--rollback`, idempotent `--resume`, and read-only `--recovery-preflight` /
  `--recovery-check` for the fixed updater transaction; no remote command payload.
- Existing delivery: `POST /vps/deploy` with one reviewed handle and exact
  registered version. A missing handle is never a repair cohort selector.

### 3. Contracts

Deployment keys are `MATRIX_FUNDED_HOST_CONFIG_ENABLED` (default `false`),
`MATRIX_FUNDED_HOST_CONFIG_MACHINE_IDS` (unique bounded CSV, default empty),
`MATRIX_FUNDED_HOST_CONFIG_VALID_THROUGH` (absolute millisecond UTC, <=7 days),
and deployment-bound `MATRIX_FUNDED_HOST_CONFIG_SOURCE_SHA` (40 lowercase hex).
Control must also be enabled and the configured Relay must be the reviewed
untagged production service. These settings do not reset existing probe limits.

Response has exactly `contractVersion:1`, `kind:"matrix-funded-host-config"`,
`source:"platform"`, `sourceSha`, `issuedAt`, `expiresAt`, `identity` and
`configuration`. Identity has exactly handle, machineId, runtimeSlot and
runtimeTokenEpoch. Configuration has exactly these four string-valued fields:

| Field | Wire type and allowed value |
| --- | --- |
| `MATRIX_FUNDED_AI_ENABLED` | Literal string `"true"`, never a JSON boolean |
| `MATRIX_FUNDED_AI_RELAY_URL` | Reviewed untagged production HTTPS origin matching `^https://matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app$`; maximum 256 characters; no path/query/fragment |
| `MATRIX_FUNDED_AI_RUNTIME_TOKEN` | String matching `^[a-f0-9]{64}$`, derived for the admitted current machine/slot/epoch |
| `MATRIX_FUNDED_AI_PLATFORM_URL` | Literal string `"https://app.matrix-os.com"` |

No unknown configuration fields are accepted. Expiry is strictly later than
issuance, no more than 30 seconds later.

```ts
const response = FundedHostConfigResponseSchema.parse(untrustedResponse);
// Host acceptance additionally binds receipt source, current installed version,
// identity, epoch and current time; schema parsing alone is insufficient.
```

### 4. Validation & Error Matrix

| Condition | API / host outcome |
| --- | --- |
| Invalid handle, headers or extra query | Safe 400; no transaction or host mutation |
| Invalid HMAC | Safe 401 before DB readiness/acquisition |
| Valid old HMAC with stale epoch | Fresh DB rejects with 401 |
| Off/empty/expired cohort | No configuration; unmounted or safe unavailable route; no stop |
| Non-running/deleted/unauthorized/incorrect class or slot | Reject; no credential delivery |
| Disabled policy, pending deletion, unsettled or corrupt obligations | Safe 503 deferral; no financial transition |
| Invalid response source/expiry/origin or unknown local activity | Host defers; no blind retry |
| Stale/concurrent maintenance, missing source or version proof | Host defers before stop/write |
| Failed write/restart with unknown outcome | Preserve journal; independent readback required |
| Applied journal plus passive or unverified downgrade | Fail closed; do not replace app |
| Failed uncommitted newer update with complete unchanged repair state | Recover only current committed config owner; retain fields/journals |
| Inconsistent repair recovery proof before normal upgrade | Defer before stopping services or replacing host artifacts |

### 5. Good/Base/Bad Cases

Good: exact source, current machine/epoch, no unsettled obligations, verified
protected installer, explicit idle update, four-field readback and separately
verified product status. Base: default-off deployment delivers no configuration
and never schedules automatic maintenance. Bad: treating an old task list or
health reply as idle proof, substituting Preview eligibility, resetting probe
budgets, clearing holds, or restoring a prior receipt ahead of its app version.

### 6. Tests Required

Run the funded-host API/workflow suites plus existing policy, sync, deletion,
deployment and release regressions. Exercise the generated inline bootstrap
and installed protected program in disposable root Linux with real archives,
filesystem descriptors and journals; identify mocked transport/service state.
Cover two-hop install, explicit apply/no-op, saved-prior request, field rollback,
failed later update before/after app swap, interrupted recovery, later committed
receipt followed by another failed candidate, manual denial, corrupt recovery
proof deferral before service stop and post-restore verification before resume,
matching prior install, passive deferral, post-stop financial deferral, partial
write rollback, decompressed-byte limits, bounded PAX/GNU extension headers and sparse rejection and stale/concurrent invocations.
Actual old VPS delivery, loaded configuration, Electron Desktop and real Relay
metering/readiness remain independent live gates.

### 7. Wrong vs Correct

Wrong: execute extracted staging Python as root or follow a presigned redirect
with Platform authorization. Correct: validate canonical metadata and the exact
object capability, pin public TLS transport, hash one held archive snapshot and
install only verified bounded members under protected root ancestors.

Wrong: restore component A while app B and resumed sync B remain active.
Correct: restore fields under B, verify, disable cohort, then explicitly install
matching app/component A and independently verify the actual result.
