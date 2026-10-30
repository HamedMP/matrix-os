# Validation ledger: collaboration preview pair

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418). Native stack base:
[spec PR #3022](https://github.com/HamedMP/matrix-os/pull/3022).
No cloud provisioning, production deployment or live collaboration acceptance
has been performed by this feature implementation yet.

## Planning/tooling phase

- Named fault: the branch-creation hook permits four-digit feature numbers, but
  downstream setup rejects them and ignores the persisted independent feature
  directory. Invalid metadata also silently falls back instead of rejecting it.
- Real boundary: production Bash setup/prerequisite scripts copied into disposable
  real Git repositories with committed fixture branches, actual metadata and paths.
- Red: nine intended assertion failures; legacy three-digit case passed. Initial
  sandbox subprocess denial and unborn fixture branches were corrected before
  accepting regression evidence.
- Green: `pnpm exec vitest run tests/scripts/speckit-feature-paths.test.ts` — one
  file,10passed. The actual feature setup and prerequisite entrypoints now resolve
  this spec from the independent implementation branch.
- Full `bun run typecheck` — exit0, all eight project/config entries passed.
- `bun run check:patterns` — exit0, zero violations/five pre-existing warnings.
- Spec Kit checks: six planning artifacts with no unresolved questions, actual
  relative links validated,42 tasks with sequential IDs/story/path syntax verified,
  requirements checklist16/16 and `git diff --check` clean.

## Remaining required qualification

Implementation tasks are tracked in [tasks.md](tasks.md). Pair transaction/race,
actual Electron process/native artifact, protected two-account cloud/model and
per-surface capture results must be recorded as they execute. Missing isolation,
fixture identities, funding or OS access is a blocker, never a passing or skipped
required assertion. New screenshots/recordings belong outside Git and are attached
or linked to the review record.

### Foundation implementation (T005–T009)

- Contract baseline:16 intended assertions failed;17 pass after implementation.
- Config baseline:8 intended assertions failed;9 pass after implementation.
- Provenance baseline:13 intended assertions failed;13 pass after implementation.
- Actual Platform startup migration:2 intended assertions failed;2 pass.
- Combined foundation:41/41 pass, no skips. Provider records use production-shaped
  fixtures; authenticated live provider adapters are still pending.
- Dedicated local PostgreSQL16: simultaneous independent backend connections and
  actual Platform migrations pass1/1. Test owns a random schema, cleans pools and
  schema, and required CI inventory includes it. No VPS or customer data touched.
- Greptile corrections: legacy SPECIFY_FEATURE override and dangling metadata
  symlink reproduced2 failing assertions, then12/12 real Git/Bash cases pass.
  Spec invitation discovery now explicitly permits acceptance before content access.
- No live pair, native desktop, funding or visual qualification is claimed.

### Atomic admission and lifecycle implementation

- New real PostgreSQL cases: **34/34 passed across7 files, zero skipped**, serial
  run with actual Platform migrations and independent connections. This includes
  both-member rollback, duplicate convergence, one fixture lease, existing owner
  quota, customer collision preservation, stale claims, stop replay/expiry, explicit
  reset and competing stop/update, exact provider/label inventory and creation fences.
- Named faults observed: two unshared-transaction assertions; two prepare dispatch
  assertions; two handle/quota assertions; ordinary dispatcher booted a pair job;
  queued customer machine could be reclassified; stop replay failed; two pagination
  completeness assertions. Each is green after its fix.
- Claim fence mutation: removing generation/revision/claim/expiry checks makes7
  assertions fail; restored code passes. This is mutation evidence for new lifecycle
  behavior, not a claim of an existing production regression.
- Provider cleanup tests use real HTTP response parsing and durable Postgres queue
  operations with synthetic provider responses. No paid provider request occurred.
  Pagination is checked through the provider metadata documented at
  https://docs.hetzner.cloud/reference/cloud; incomplete inventory cannot prove absence.
- Platform TypeScript passes; pattern scan has0 violations and5 existing warnings.
- Broad required Postgres qualification attempted56 files but failed in the first
  batch: Chat queue concurrent admission produced27 successes instead of32; navigation
  tests timed out and a controls worker exited. Host swap was exhausted. Only this
  task's failed runner/children were stopped; broad qualification remains incomplete.
- Broad ordinary provisioning attempt also hit fixture timeouts/worker exits. A
  serial memory-bounded assertion inventory verified all20 ordinary provisioning
  assertions across ten fresh processes; all11 ordinary Preview-slot assertions
  also pass across six fresh processes. This does not qualify the interrupted
  broad Postgres lane. No assertions or deadlines were weakened.
- The ordinary dispatcher deliberately leaves pair jobs queued until independently
  verified isolation wiring is added in the controller layer. No public pair routes
  or native launch entrypoints are activated by this layer.

### Lifecycle review correction

Greptile found a real pinned-update target overwrite. Three actual Postgres
assertions fail before correction: observing a third head overwrites the selected
target, returning to the old head misses its currency warning, and observing the
selected target incorrectly marks it outdated. Two further assertions reproduce
revision churn on identical observations and failure to clear rollback currency.
The fix preserves the staged candidate, changes only its currency during update,
and carries that currency into the completed generation.

All15 admission/update assertions pass after the lifecycle review correction; Platform TypeScript passes.

### Operator API and readiness implementation

- Actual Hono routes enforce constant-time operator credentials, a16KiB streaming
  body limit, strict requests, safe errors and prefix isolation. Actual Platform
  registration remains disabled by default and leaves ordinary routes unchanged.
- Read authorization is requester/current-maintainer or leased fixture owner/member;
  the outsider, an expired principal and the wrong identity domain are rejected.
  The principal verifier is an explicit production adapter contract; no fixture
  principal verifier is mounted in production.
- Readiness uses the actual Postgres ledger and generation/revision/claim fences.
  Host, identity, service and funding observations remain synthetic adapter boundaries
  in these tests. Reports use the actual readiness producer and expire its proof.
- Final service/reconciler/admission/update run: **30/30 passed across4 files**,
  zero skipped. The expiry-progress case first failed because cleanup was repeatedly
  re-stopped; skipping that transition for cleanup-pending pairs makes it pass.
- Queue promotion leases a canonical fixture and prepares both members in one
  transaction. A second-member failure rolls everything back; hard expiry survives
  queue wait. Controller receipts bind the real requester before admission.
- Platform TypeScript passes for this layer. No provider boot, identity mutation,
  grant, deployment, native launch or live visual acceptance is claimed.
- T015 production provider/identity/source/host adapters and maintenance activation
  remain in the dependent controller layer; this API is not an operational preview
  service until those bindings pass independent isolation checks.

Final HTTP/readers/readiness/reports/queue/provenance run: **64/64 passed across7 files**, zero skipped. Combined with the separate30-case run, all94 assertions in these two inventories passed. Required Postgres CI inventory now includes the six new database suites.

### API review corrections

Greptile identified waiting-pair starvation and loss of wrong-running-version
diagnosis. Four real Postgres assertions failed first: a full waiting batch blocked
an active pair, a waiting reservation had no backoff, hard expiry was hidden by a
future schedule, and a wrong running version lost its computer-specific source
stage. The fix prioritizes expired/cleanup/active work, applies a15s backoff to busy
queues and fresh readiness, and checks runningVersion at the source boundary.
Live claims are not repeatedly selected; expiry still invalidates an active claim.

The first verification run then exhausted the task-owned384MiB temporary database
filesystem. That is an environment failure, not a passing result or code regression.
Only the verified ENG-418 fixture was replaced; no other container/database changed.
The unchanged verification run is recorded separately below when complete.

Final API review verification: **30/30 passed across4 files**, zero skipped, on
fresh local Postgres; Platform TypeScript passes. All four new fault assertions
are included in that run. No assertion or timeout was relaxed.

### Bounded provisioning recovery (controller review)

The real-Postgres orchestration regression advanced the actual10s operation timer
and failed because the pair became `failed`. Activation deadline exhaustion now
releases the fenced claim and schedules a15s continuation without claiming
readiness or discarding durable jobs. Non-timeout activation errors retain their
failure path. All **8/8 orchestration cases pass**, zero skipped; provider polling
and cancellation are qualified separately in the dependent dispatcher layer.
### Protected desktop packaging

The unsigned pair path in the existing desktop build workflow validates the
reviewed controller SHA and same-repository open PR head before candidate checkout.
Three portable targets (macOS arm64/x64, Linux x64) build with read-only repository
authority and no signing/operator secrets. Source and target receipt ship beside
the archive. Normal signing and release paths retain their tests.

Real Git checkout/source tests and actual workflow/helper checks: **55/55 passed
across4 files**. The initial sandbox Git EPERM and missing-module collection failures
are not regression red evidence. New build-context tests first rejected candidate
execution; the retained real-Git producer now embeds the actual checkout while
keeping controller execution separate. No native artifact build or workflow dispatch
was performed, and no packaged launch is claimed.

### Packaging review correction

Greptile found that a candidate build could overwrite the sibling controller
checkout before its later verifier ran. The intended runner-boundary assertion
failed first. Admission, candidate build and provenance now run in separate jobs;
the fresh provenance runner checks out only the reviewed controller, never downloads
or executes candidate artifacts, and reads immutable artifact IDs/digests from the
GitHub API before publishing separate small source receipts. Candidate outputs are
data only across that boundary. This is provenance of a selected candidate build,
not a reproducible/hermetic build attestation.

**62/62 assertions pass across4 files**, including wrong/expired/duplicate/missing
artifact rejection and the retained release tests. No native workflow dispatch or
live artifact launch is claimed. Artifact signing and operator secrets remain absent
from candidate execution.

Packaging CI found TS2724: the new JavaScript build-source function was missing
from its existing .d.mts export declaration. The actual Electron node typecheck
reproduced it before the declaration was added. The classic focused Electron node check then exhausted its512MiB heap;
it did not complete. The broad local pipeline built its dependencies but timed
out at the native gateway compiler under host pressure; a resource-bounded rerun is
recorded separately. No broad typecheck pass is claimed from the interrupted run.

The resource-bounded native rerun completed successfully for all8 configured
projects, including Electron renderer and node configs (GOMEMLIMIT=1GiB,
GOMAXPROCS=2). Dependency builds completed in the earlier pipeline stage. This
qualifies the declaration correction; the failed classic512MiB attempt remains
recorded above.

### Controller second review: retry allowance and mounted data

Five intended assertions failed first: progress at the final retry slot, two
mounted-secret revisions, and two definitive rejection outcomes. Normal pending
pair passes now restore their retry allowance under the exact job lease; successful
adoption remains possible at the last failure slot. Typed definitive provider
rejection clears only that leased creation intent inside the failure transaction;
ambiguous outcomes keep their intent and capacity. Unsupported volumes/mounts are
rejected even if a mounted secret's name also appears on the environment allowlist.
Shapes follow the [Cloud Run Volume](https://docs.cloud.google.com/run/docs/reference/rest/v2/Volume)
and [Container](https://docs.cloud.google.com/run/docs/reference/rest/v2/Container) API contracts.
Final focused verification: **24/24 pass across3 files**, zero skipped; real
Postgres for dispatcher/cleanup, provider HTTP and Cloud Run responses are fixtures.
Focused Platform native TypeScript passes.

### Verified controller adapters and guarded dispatch

- Existing Clerk wrapper now retains cryptographically verified issuer/expiry.
  Three real signed-session assertions failed first; existing login tests remain
  green. Existing Matrix user-session provenance is required; runtime tokens do
  not become human principals. Control and Preview key domains must differ.
- Actual GitHub/Clerk/Cloud Run HTTP readers have bounded bodies, deadlines and
  fixed provider origins. Only a reviewed controller run with a verified linked
  GitHub requester can supply admission identity. Current maintainer membership
  remains an independent service gate. Public source receipts are bound to actual
  artifact IDs/digests; archive redirect requests do not receive GitHub credentials.
- Cloud inspection reads immutable revision data and both generation tags. Wrong
  service account, data/secrets, sidecars, API host classification, mutable secret
  references and failed Ready state are rejected. Three signing/readiness faults
  failed first before the checks were added. These responses are provider-shaped
  fixtures, not live cloud configuration or IAM qualification.
- Final reader/controller/auth run: **47/47 passed across5 files**, zero skipped.
- Controller run ownership is persisted with admission/update in independent schema
  revision2; replay cannot transfer it. The strict catalog baseline adds only one
  column and its constraint, retaining every earlier schema entry. The actual
  Postgres generation18 upgrade assertion failed before capture and passes after;
  its focused filter excluded9 other cases, so this is not a full-lane result.
- The narrow dispatcher uses existing durable jobs only after canonical claim,
  ownership, approved test context and projection checks. Its positive assertion
  failed with the ordinary worker's default denial before the permit was added.
  Ordinary workers still skip pair jobs; pair workers refuse ordinary jobs.
  Pair provider creation runs outside DB transactions; existing compensation and
  cleanup proof handle ambiguous creations or lost claims.
- Final real-Postgres controller/service/update/dispatch run: **26/26 passed across5
  files**, zero skipped. Cloud/provider/mirror observations are fixtures in that run;
  no real VPS was created or configuration changed.
- Source readers and dispatch guards are not production bootstrap wiring. Dedicated
  data projection, full access/tag retirement, safe host binding/observation, actual
  protected controller workflow, default-off maintenance, launcher and evidence
  still belong to dependent layers. T015/T016 remain unchecked until those exist.
- Added the existing fflate0.8.3 package explicitly for bounded in-memory receipt
  ZIP parsing. Root pnpm install refreshed only that importer edge in the lockfile;
  no package version was upgraded. Offline metadata was missing, so installation
  used the normal registry with existing package safety settings.

Current controller layer: all8 configured native typecheck projects pass with GOMEMLIMIT=1GiB/GOMAXPROCS=2; pattern scan reports0 violations and5 existing warnings.

Read-only live Google API shape checks (no secret-manager access or mutation)
confirmed omitted false reconciling fields, short revision.service, full resource
names and immutable image digests on the existing Preview service. The corresponding
positive reader fixture failed before adapting those shapes; the fix still requires
Ready success and rejects explicit reconciling=true. Final reader/controller/auth
run:48/48 across5 files. This verifies API response fidelity only; that existing
service is not claimed as an approved isolated pair or live journey evidence.

Focused Platform TypeScript passes after the final Cloud Run response-shape correction.

### Provider progress within the activation budget

Greptile identified a30s provider-poll loop inside the10s pair activation budget.
Three dispatcher assertions failed first (one job per pass, one action observation,
and immediate recovery of an interrupted job lease); the actual HTTP-client signal
assertion also failed because parent cancellation was ignored. After the fix,
**17/17 cases pass across3 files**, zero skipped, including retained provider-client
coverage. Pair dispatch polls once, releases only its exact job lease, preserves a
pre-POST creation intent and adopts a later exact-label result without another POST.
Unknown creation outcomes remain pending and retain capacity. Ordinary dispatch
keeps its existing poll policy; HTTP requests still have their own10s deadline.
The database/dispatcher/client are real; provider responses and projection remain
fixtures. No server creation or pair-readiness claim is made.

Focused ordinary Preview regression checks: **2/2 selected cases pass** (7 other
cases excluded by filter), exercising continuing create-action polling and
expired-lease provider adoption. Focused Platform native TypeScript passes.

### Isolated Preview data projection

**8/8 actual two-database cases pass**, zero skipped, using a separate non-superuser
role/database per case. The real registration service rejects wrong bootstrap
tokens and accepts valid ones under a distinct Preview signing secret. Only the
two leased machine rows and their immutable release metadata are projected; no
customer inventory or encrypted provisioning jobs are copied. Pair writes share
one target transaction; a customer collision rolls back the first member.

Intended fault assertions failed before their fixes: retirement before stop or
with the wrong job, a restricted role with control-ledger SELECT grants, and a
widened machine access list. Same-database targets are rejected, including separate
wrappers. Role membership (including SET ROLE) and control-table privileges are
checked on a shared server. Cleanup tombstones never-projected machines and a
late snapshot cannot resurrect them. Initial fixture shape/constraint failures
were corrected to match production and are not regression-red evidence.

Provider IDs/addresses and bootstrap tokens are synthetic test inputs; the actual
provider, Cloud Run identity/IAM, full directory retirement and runtime workflow
are not qualified by this suite. It is included in required Postgres CI. Temporary
roles/databases have explicit idempotent cleanup, including setup compensation.
Focused Platform native TypeScript passes for the projection implementation.

### Projection second review: connection aliases and cleanup

The address-report regression failed first: a restricted role with a real control
ledger grant passed when the owned target database reported another address. The
fixture adjusts only its own reported-address catalog function; it does not claim
an actual Unix-socket/VPN transport test. Isolation now requires distinct database
and login-role names and checks control-table grants regardless of addresses.
`session_user` prevents a login from hiding its broader privileges behind SET ROLE.
**13/13 actual two-database cases pass**, zero skipped. Test teardown attempts the
control fixture in finally even if the independent target cleanup reports failure.

### Projection review: observations, tombstones and catalog trust

**12/12 actual two-database cases pass**, zero skipped. Four new intended faults
were reproduced: registered-address mismatch overwritten before comparison,
missing projection recreated as already running, retirement timestamp refreshed on
retry, and Preview-owned catalog-shadowing functions hiding a control-ledger grant.
Registered fields are preserved in the locked upsert row, so concurrent registration
cannot be erased between a pre-read and write. Missing rows start provisioning;
retries retain first deletion time and the higher revocation epoch. System catalogs,
identity/privilege functions and the access-list array check are explicitly qualified.

One attempted boot-race fixture was rejected by the existing real registration
provider-ID check; it was not a possible accepted producer result, so it was replaced
with the actual missing-projection recovery fault. That fixture failure and an
initial SQL quoting failure are not counted as regression-red evidence. The
registration guard was not weakened and no retained production protection removed.
After final catalog qualification/helper naming, all3 selected boundary cases pass
(9 excluded by filter); the preceding full12-case run also passed without skips.
Focused Platform native TypeScript passes for the reviewed projection changes.

### Exact host binding and pinned update policy

Three intended assertions failed first: missing candidate update-base pin,
unmounted public metadata route through the actual Platform app, and an update
status that probed intentionally absent channels. Final integrated verification:
**30/30 cases pass across6 files**, zero skipped, with a single test worker. Both
actual cloud-init producers bind the verified browser/API, and retained ordinary/
Private Preview behavior and current pair dispatch remain exercised. Registration,
Platform routes and databases are real; provider responses and signed object-store
URLs are fixtures. No host boot or product acceptance is claimed.

All **8 native typecheck projects pass** on the integrated source. Pattern scan:
**0 violations,5 existing warnings**. Bundle/update mounting was extracted from
`main.ts`; new route logic stays in focused modules. T015/T016/T033 remain open
until actual observation, funding, complete retirement and protected automation
are composed. No production shell/Electron build or live evidence claimed here.

### Host CI inventory and bootstrap funding

Host-layer CI identified an unsorted update-base inventory entry, preventing both
real-Postgres lanes from starting. Two inventory assertions reproduced the failure;
lexical ordering now passes27 assertions across2 files, with all guards preserved.
A retained host-bundle test inspected the monolithic updater after extraction.
It now composes the loaded library while keeping its original version assertions.

Two real-Postgres assertions also reproduced rejection of a disabled funding boot
and acceptance of pre-enabled funding. Pair bootstrap now requires funding off;
scoped allowance configuration follows actual registration. The provisioning,
host-bundle and retained update suites pass **97/97 across4 files**, zero skipped
or errors. These are fixture/provider and actual Bash/SQL checks, not paid-machine
or model qualification. Existing financial origin guards remain intact.

### Host updater review: quiet passive polling

The actual Bash poller regression failed first by reaching a channel that paired
metadata intentionally rejects. Passive polling is extracted from the large sync
agent into the existing verified-metadata library before adding its pair policy.
**22/22 actual Bash cases pass across2 files**, zero skipped, including all17
retained explicit-request/metadata trust assertions. Both shell files pass bash -n.
Five policy cases cover the verified pair, ordinary Preview, wrong slot, wrong
generation and missing marker. The extraction retains the harness boundary marker;
no existing assertion was changed. Initial extraction/harness failures were fixed
and are not counted as the intended regression. No host restart or live boot claimed.

### Scoped access retirement and late writer fencing

The real two-database regressions first reproduced leftover Shared with me entries
and successful retirement despite a corrupted cross-runtime child. Exact runtime
metadata is now removed in the same target transaction as its machine tombstone;
unrelated runtime routes, discovery entries and tickets remain. The non-cascading
cutover journal is retired before directory deletion. Inconsistent ownership aborts
the transaction instead of cascading into another runtime.

A further regression used actual production collaboration bootstrap: all four late
writes originally succeeded after retirement (directory event, endpoint registration,
control ticket and connection ticket). Production composition now injects the existing
machine admission fence into their actual transactions. This is independent of new
pair admission being enabled. A controlled in-flight writer proves that machine
FOR SHARE blocks retirement's non-key UPDATE; changing it to FOR KEY SHARE reproduces
the assertion failure. The correct lock was restored before the full green run.

**17/17 cases pass across2 actual Postgres files, zero skipped** (13 projection plus4
access retirement). The focused first two cases and subsequent3-case run also passed.
Fixture setup initially omitted collaboration migrations; that failure was corrected
and is not counted as regression evidence. The alternate-address test remains an
owned catalog fixture rather than a real socket/VPN validation. Provider IDs/responses
and fixture identities are synthetic. Actual registration, two databases, production
collaboration composition, SQL locks and discovery consumers are real. This does not
claim Clerk login, paid infrastructure cleanup or a completed owner/member journey.
T015/T033 remain unchecked until host/funding/controller maintenance is composed.

All8 native typecheck projects pass on the retirement source. Retained bootstrap/
internal routes:12/12 pass. Retained repository/tickets/endpoints:40 pass,3 existing
skipped cases; this is compatibility coverage, not a non-skipping acceptance lane.
The final expanded production positive-then-retired case passes (1 selected,3
excluded by filter). Pattern scan reports0 violations and5 existing warnings.

### CI startup expectation corrections

Failed unit-shard logs identified two full-startup revision lists that omitted
the independent pair migration. The owning schema layer reproduced3 assertion
failures across2 files before correction;17/17 cases across3 full files pass with
its exact generation1 marker. Controller-layer requalification then reproduced2
stale generation assertions;17/17 cases across the same3 full files pass with
its actual generation2 controller marker. Existing default, constraint, snapshot
isolation, cache and channel restart assertions remain. These changes update test
expectations only, not runtime startup behavior. CI on the restacked published
heads must still be checked rather than inferred from the local runs.

### Retirement review: preserve ordinary customer names

The required cohort additionally reported the new retirement suite missing after
the earlier ordering failure was fixed. Its exact manifest-drift failure was
reproduced, then the suite was registered in this owning layer. No discovery or
non-skipping qualification guard was relaxed; the five actual retirement cases
remain part of the required database lane.

Greptile found that the broad cp-prefix check classified legal customer handles
such as cp-alice as managed pairs. The actual production-composition regression
failed before correction. Recognition now uses the complete reserved pair pattern;
legal cp-prefixed customer handles retain directory, endpoint and both ticket
paths. All5 real two-database retirement cases pass, zero skipped; focused Platform
native TypeScript passes. Existing pair tombstone and in-flight writer fences
remain exercised. This is a source fix, not a live customer mutation.

### Actual host observation checkpoint

The new reader consumes the existing gateway system-info producer, canonical
control metadata, actual isolated registration and the existing target endpoint
registry. Provider responses and HTTP transport are fixtures; no public-IP request
or paid machine was made. It checks provider labels/address, global-IP safety,
installed and running source/digests, slot/owner/epoch, protocol, actual target
confirmation and fresh control activity. Infrastructure readiness grants no access.

The unimplemented positive path failed first. A401 response-body cancellation
assertion failed before its fix. Removing the final canonical check made a real
stop request during the probe return healthy; restoring the check rejects that
completion while the target/control remain healthy. Ten response mismatch variants
assert the responsible HTTP boundary is reached. Stale control recovers only after
an actual heartbeat; unsafe addresses and unrelated providers cannot trigger probes.

Final original-fixture run: **6/6 pass, zero skipped/errors**; focused Platform native
TypeScript passes. One earlier run passed its6 assertions but reported an unhandled
Postgres57P01 during fixture DROP DATABASE; that invocation is not counted green.
Two diagnostic reruns and the final run passed, but no teardown root cause is
claimed resolved. The temporary timing probe was removed; required qualification
must still fail on any recurrence. Raw driver error logs stay private.

Registration confirmation is read from the Preview database; the control ledger
retains desired bundle metadata. An early new-reader contract mistake and a fixture
expectation of a non-manifest tokenEpoch field were corrected; neither counts as
regression proof. No real login, model prompt, live surface evidence or completed
pair readiness is claimed. Funding and production maintenance composition remain open.

### Bounded AI activation checkpoint

Real control and isolated databases, the actual funded proof route and gateway
configuration route now exercise separate collaboration and financial authorities.
The initial candidate financial-origin request returned400 under the existing
guard; that was a design mistake, not evidence of a product regression. The guard
remains intact. The control ledger alone holds the capped Preview allowance.

The source-only reader failed before correction when it looked in the candidate
ledger. The unimplemented activation step failed all3 intended assertions. It now
configures once, verifies loaded configuration on a later pass and recovers a lost
applied response without a second POST, restart or credit grant. Reused control or
allowance keys are rejected before host traffic. Source policy/balance/quota/epoch/
expiry failures cannot qualify readiness; Speech is not a Chat prerequisite.

**10/10 assertions pass across host-observation/funding/origin files**, followed by
**3/3 activation assertions**, zero skipped/errors. Focused Platform native
TypeScript passes for both checkpoints. HTTP, provider and OS apply/restart are
explicit fixture boundaries; no real model call, paid machine, process restart,
Clerk login or completed pair qualification is claimed. Concrete host transport,
bootstrap/workflow and desktop composition still remain open.

The concrete shared host transport now independently matches canonical membership,
provider labels and the registered globally routable literal IP. It permits only
system-info GET and funded-config GET/POST, caps POST bodies at4KB, replaces caller
auth/Host/Origin headers, rejects redirects and composes caller/10-second deadlines.
The unimplemented transport failed its intended positive assertion first. The
combined observation, activation, funding and origin suite passes **14/14 across4
files**, zero skipped/errors. Invalid paths/methods/body sizes cannot trigger a
second probe. Actual provider/HTTP remain fixtures; no remote public-IP traffic.

All8 native TypeScript projects pass on this maintenance source. Changed-file
pattern scan reports0 violations and0 warnings. The complete required cohort
validates all71 files, including retirement and the four new maintenance suites.
Hosted CI is still pending; the external Codex0.166 qualification blocker already
has its own [ENG-420](https://linear.app/matrix-os/issue/ENG-420/fixci-restore-main-contract-and-build-checks).
No duplicate issue or compatibility bypass is added.
