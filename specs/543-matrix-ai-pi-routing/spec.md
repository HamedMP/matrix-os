# Matrix AI Chat and bot model routing

Status: implementation; ENG-107. Dependencies: pinned Pi runtime from PR #2048.

## Product behavior

Users select an eligible Matrix AI Gateway model in Chat and execute text and artifact
tasks through the Matrix-owned Pi worker. A recipe bot can optionally persist a concrete
Matrix AI choice at creation or through a revisioned edit. Automatic remains compatible
with existing recipes and operator Codex routing. Explicit Matrix selection never silently
falls back to Codex, the Claude kernel, an owner credential, or another model.

Web Desktop, Web Canvas, Electron Desktop and applicable mobile controls share model
selection derivation. Saved unavailable choices stay visible and require a deliberate
change or retry. Model editing must preserve omitted metadata, bot identity, and memory.

## Runtime and authority

The public `matrix_pi` driver and `matrix_pi_default` instance represent managed Chat;
the native `pi` coding CLI and private `matrix_bot` recipe runtime remain distinct.
Gateway admission validates current model/source policy and resolves the route. The
same pinned Pi worker receives either `managed_chat` or `recipe_bot` authority.
Ordinary Chat creates no bot/task records and inherits no recipe integration grants.

Managed sessions and checkpoints persist in owner-controlled Postgres, independently
of recipe bot sessions. Keys include owner and canonical Chat identity. Canonical history
feeds new turns; provider-private state never cross-resumes a different driver.
Private chat workspaces bind an owner hash and Chat ID plus inode identity; associated
project roots use existing owner-authorized resolution. Managed Pi supports standard
projects and worktrees beneath the fixed `projects/` and `worktrees/` home directories;
arbitrary folder projects outside those roots remain unavailable for this route.
Artifacts remain root-scoped.
Reading is supported; full-access writes create files exclusively. Overwriting existing
files and managed Chat image attachments are explicitly unavailable in this increment.

## Managed Pi sandbox contract

1. **Scope / trigger:** ordinary Chat workspaces cannot use the recipe Bot profile,
   whose mount authority is restricted to `bots/`.
2. **Signatures:** `managedPiSandboxRootsForHome(homePath)` returns fixed
   `agent-workspaces/`, `projects/`, and `worktrees/` roots. Gateway admission and
   supervisor discovery pin `scope-runtime-managed-pi-v1`, version 1, digest
   `5e2e3b9f0785deb28f7b6334f7df8f96f84d9365978d4d459778b78acf31fc37`.
3. **Contracts:** managed Chat reuses the pinned Pi worker and `bot_agent` transport,
   with independently selected mount authority. Recipe Bots retain their original
   profile/digest and `bots/` allowlist. The supervisor keeps `ProtectHome=tmpfs`
   and exposes only the four fixed roots read-only for validation; a child receives
   its one owner-authorized workspace. Provisioning prepares missing roots with
   mode 0750 without replacing existing owner contents or permissions. The newly
   installed host-prerequisites executable prepares them before its certified-host
   early exit, so an already-loaded predecessor updater also creates bind sources
   before the new supervisor namespace starts. Pre-activation golden certification
   leaves owner-home creation to activation.
4. **Validation / errors:** missing managed root configuration or worker sources disables only
   managed capability; unknown profiles fail closed. A missing mounted workspace
   fails admission before inference; catalog discovery alone is not launch evidence. Out-of-root, symlinked roots,
   wrong ownership/inode, hard links and world-writable mounts remain rejected.
5. **Good / base / bad cases:** private Chat and standard project roots launch;
   existing recipe Bots remain isolated; an arbitrary external folder project or
   a root symlink into protected data cannot launch.
6. **Required tests:** assert capability discovery and distinct profile selection,
   real mount-source admission/rejection, child systemd arguments, fresh-root
   preparation and existing-data preservation. Preview acceptance must verify the
   installed service and execute paid text/tool/resume through Electron Desktop.
7. **Wrong / correct:** do not broaden `botSandboxRoots` to the whole home or remove
   `ProtectHome`. Select the managed profile and its fixed root allowlist instead.

## Auth matrix

| Boundary | Authority | Public |
| --- | --- | --- |
| Provider/catalog reads | Existing authenticated runtime principal; owner snapshot | No |
| Chat creation/turn/steer/cancel | Existing Chat ACL, current owner model policy and run identity | No |
| Bot instantiate | Authenticated owner, recipe validation, idempotent request | No |
| Bot definition edit | Owner plus base revision enforced by update | No |
| Pi broker inference/tools | Registered handle/generation, owner/Chat, pinned route and granted capabilities | No |
| Relay readiness | Existing control credential; coarse readiness only | No |
| Relay inference | Signed runtime claim, model allowlist, atomic reservation and settlement | No |

Keep broker credentials outside workers; preserve network isolation. Reauthorize after
queue waits. Validate bounded inputs and body limits. Cap registries/event queues, bind
cancellation and execution deadlines, and drain owned resources at shutdown. Sessions
and dependent writes use transactions; shared pool ownership stays with its creator.

Managed funded inference allows up to 120 seconds per complete broker response,
including buffered generation after response headers arrive. Retain the separate
30-second owner Anthropic credential deadline, lifetime cancellation, bounded queue
waits and the worker's independent whole-turn limit. A timeout is final for that
provider attempt; only an explicitly marked relay capacity refusal may retry.

Web Desktop, Web Canvas and Web Mobile expose Stop only for the current Chat's
active run and invoke the existing canonical cancel transport. Submission/loading
and queued-only states do not imply a cancellable run. Preserve Queue next and
allow cancellation when the selected model becomes unavailable during execution.
Each pinned runtime binding owns a bounded inference cancellation signal. Stop
aborts that exact run before worker cancellation; release, replacement, expiry and
shutdown also abort its pending queue/fetch/body reads. Stale generations and other
owners cannot cancel another binding, and a new run remains independently usable.
Cancellation does not claim to reverse completed tools or already incurred usage.

## Pricing and readiness

Readiness requires fresh policy, positive funding and a valid per-model receipt.
Jev evaluator success does not establish GLM or Sonnet generation readiness.
GLM/Sonnet numeric rates remain immutable versioned snapshots. Operator review binds
an exact snapshot version to strict UTC `reviewedAt` and `validThrough`, with a positive
window of at most 31 days. Missing reviews retain the historical expired snapshot;
partial, malformed, future, mismatched and expired reviews fail closed. No rolling
process-start renewal or numeric environment override is accepted.

Readiness and generation admission consume the same review. Recheck after probes and
authorization, releasing an untouched reservation if it expires before start. Existing
reservations settle using captured historical rates. Failed peers' short observation TTLs
must not invalidate a healthy model receipt; policy, funding and caller cancellation still
apply. Deployment must carry reviewed configuration without generating new timestamps.

## Delivery evidence

Record failing regressions before fixes, focused tests/typechecks/builds, and a separately
reviewed public documentation PR in `FinnaAI/matrix-os-site`. Validate an exact-head
Preview VPS with Electron Desktop: model A text/tool/resume, model B text, bot create/edit/
reopen, cancellation, safe unavailable behavior and independent route/accounting evidence.
Record client path/version/commit, immutable bundle runtimeVersion and Relay/Platform
revision. Human Review is approved for this task; after fresh integration/MCP acceptance,
obtain exact-head Greptile 5/5 and green CI before merging PR #2117. Automated
faux-provider tests prove wiring; they do not prove deployed paid inference.

Deferred: broader Hermes migration, arbitrary provider routes, full filesystem editing,
managed attachments, fleet promotion, credit grants, and automatic pricing renewal.

## Runtime and presentation boundary regressions

Managed admission projects the supervisor response into an explicit runtime handle
and execution generation before creating its strict owner/run broker binding. The
transport-only running state must not leak into the binding. Regression fixtures
use the actual typed client response and preserve rejection of unknown binding
fields.

Recipe Bot model choices identify the exact managed `matrix_pi` driver and
`matrix_pi_default` instance. Optional negotiated connection labels are presentation,
not authority; a label-free authenticated catalog must expose the same eligible
models. Available-instance/model filtering and server admission remain enforced.
Native Pi, kernel and other instance identities remain excluded from this selector.

## Settings fallback and rejected inference accounting

1. **Scope / trigger:** selecting a native harness with no saved access source must
   not let an unavailable policy anchor hide another ready Matrix serving route.
   A funded inference rejected before an accepted stream needs evidence-bound
   settlement; an unknown usage hold is distinct from consumed credit.
2. **Signatures:** shared `AgentsProvidersView` derives its displayed source from
   `ProviderSettingsSnapshot`. Relay calls
   `classifyFundedUpstreamRejection({ upstream, canonicalModelId, requestPath,
   signal }): Promise<FundedFinalization>` after its authenticated reservation
   starts and the fixed generation target returns a non-OK response.
3. **Contracts:** preserve an explicitly saved Matrix source first. Otherwise
   choose fully ready allowed Cloudflare, another fully ready Matrix source,
   a fresh policy-authorized source with discovered models, then the policy
   anchor/first source. Full readiness requires an enabled eligible
   model allowed by current policy. This display fallback neither changes saved
   credentials nor grants model access. Rejection classification is exact zero
   only for the validated `anthropic/claude-sonnet-5` `/v1/messages` route,
   HTTP429, JSON media type, and a complete strict envelope
   `{type:"error",error:{type:"rate_limit_error",message:string},request_id?:string}`.
   The body is bounded to16KiB/1second, with fatalUTF8 and caller cancellation;
   request IDs are at most256characters. Private error text is discarded.
4. **Validation / errors:** explicit unavailable sources remain visible; empty,
   disabled or policy-denied models cannot establish readiness. Additional error
   fields, malformed/incomplete/stalled bodies, nonJSON429, other models/routes,
   500, transport failure, or errors after HTTP200/SSE remain conservative.
   Finalization retries reuse the same exact-zero reservation locator and never
   retry inference. Usage-mode conservative finalization retains its hold and
   owner admission barrier until exact evidence arrives, except the explicitly
   audited operator execution recovery below. Financial holds never unlock
   through that support transition.
5. **Good / base / bad cases:** an unbound Pi Settings panel can show ready
   Sonnet while its Cloudflare anchor is unavailable. A saved unavailable source
   retains explicit intent. A complete known pre-stream rate rejection settles
   zero and permits the next run; a429 containing usage/content remains unknown.
6. **Required tests:** real shared-view transitions and allowed-model intersection;
   actual Relay-handler known/ambiguous fixtures, body deadline/byte bounds and
   abort; deferred exact finalization without repeated generation; repository
   accounting for zero debit, released hold, replay idempotency and next admission.
   Fixture SQL checks do not replace live managed-Postgres accounting. Delivery
   requires exact Relay plus Preview VPS/Electron revisions and fresh acceptance.
7. **Wrong / correct:** do not declare any HTTP429 free or infer a historical
   response body from its status. Classify only complete validated evidence, then
   settle through existing authenticated accounting. Never grant new credit or
   patch the database to conceal an unresolved hold.
## Funding-blocked model discovery

1. **Scope / trigger:** a fresh authenticated owner policy can permit models while
   reservations exhaust spendable credit or budget. Discovery, connection
   verification and execution authority are separate facts.
2. **Signatures:** `FundedAiReadinessReader.read()` returns readiness,
   executable `allowedModelIds`, and internal `discoverableModelIds`.
   `fundedAiFundingBarrier(validatedCurrentSummary)` returns a bounded reason and
   action. Provider V3 GET, Settings GET/POST/DELETE, and Chat provider GET negotiate
   new enums through `includeFundingState=true`; Chat retains its independent
   `includeConnectionState` and `includeConnectionLabels` flags.
3. **Contracts:** discovery comes only from schema-valid, fresh, enabled owner
   policy and current ledger, intersected with each actual supported source/model
   mapping. Failed, absent, stalled, mismatched or empty receipts cannot produce
   executable IDs or Ready. Valid funding-blocked discovery can return promptly
   and abort its sibling route observation. Both source schemas support
   `credit_reserved`; negotiated canonical connection state supports it too.
   Legacy wire projections downgrade it to `credit_required` without mutating
   internal snapshots. Display-only unavailable picker rows are limited to the
   exact managed Matrix Pi identity. The retired Matrix SDK identity stays out of
   new choices; other harnesses retain existing executable-only rows. Unavailable models have no executable default or choice.
   Electron accepts the catalog-matching `matrix_ai_settings` navigation action
   only for `matrix_pi_default`/`matrix_pi` and
   `kernel_matrix_included`/`kernel`; retired system-harness setup actions stay
   rejected. Navigation changes no account, source configuration or permissions.
4. **Validation / error matrix:** positive holds must explain every exhausted
   dimension before `credit_reserved` applies. Genuine credit exhaustion remains
   `credit_required`, independently of purchase capability; settled budget
   exhaustion remains policy/contact-owner. Invalid/stale/disabled policy or
   invalid ledger produces no discovery. Receipt failure leaves discovered models
   unavailable. Invalid negotiation flags fail before reads or mutations.
   Revoked saved models never inherit another model's funding reason.
5. **Good / base / bad cases:** a permitted Sonnet model remains visible and
   disabled during a credit hold; Ready routes retain existing receipt-backed
   admission. A ready instance with an unavailable sibling model labels that
   model unavailable. Invalid authority cannot be replaced by static models,
   another owner, or a renderer-generated executable choice.
6. **Required tests:** funding arithmetic, mixed exhaustion, policy/ledger
   freshness, source mapping and receipt isolation; negotiated and legacy schemas
   and premutation validation; unavailable descriptors/no default and unchanged
   admission; disabled picker/Bot rows, search, bound identity and revoked models;
   precise selected-model status and Settings reservation amounts. Native Picker
   discovery is noninteractive where item disablement is unsupported.
   Exact-head Preview plus Electron must show retained disabled models, reserved
   credit and blocked Send. Paid Stop/new Bot acceptance is a separate gate.
7. **Wrong / correct:** do not turn a funding hold into a connection failure,
   erase authorized discovery, or call a discovered model Ready. Preserve
   unavailable descriptors with a coarse funding explanation and keep admission
   closed. Aggregate reservations do not prove failed or unknown usage, settlement,
   refund or release timing; presentation changes never reconcile the ledger.


## Pi-only Matrix AI and provider loading

1. **Scope / trigger:** Matrix AI uses the owned Pi execution path exclusively.
   Model choices present the model and Matrix AI connection without exposing the
   execution harness. Owner-connected Claude and Pi coding agents remain distinct.
   Owned Bot headers use `Model: <routing label>` and recipe-backed management
   cards use `Own Chat`, without a Pi runtime prefix. Shared and Native Mobile
   preserve the model, loading/funding reason, history and authority controls.
   Recipe Bot editors omit the redundant Runtime Pi paragraph while retaining
   the existing model selector and save semantics; ordinary coding choices stay.
2. **Signatures:** the canonical catalog publishes `matrix_pi_default` with
   `matrix_pi`, omitting `kernel_matrix_included`. Shared contract presentation
   helpers identify the exact retired Matrix SDK descriptor and derive Matrix
   model labels (`isLegacyMatrixSdkProvider({ id, driverKind })`). Gateway uses
   `isRetiredMatrixSdkInstance(instanceId)` and `matrixSdkRetirementError()`
   for canonical recovery. Kernel credential launch and the kernel adapter deny
   explicit or implicit Matrix-funded SDK execution before acquiring credentials.
   Provider catalog loading is propagated to shared picker and trigger UI through
   the accessible `ChatProviderLoadingIndicator` status and Native picker
   `catalogLoading` state, including query refreshes. Electron
   `useChatProviderCatalog` returns `catalog`, `status`, `refresh` and
   `hasTrustedCatalog`, bound to API, principal/runtime identity and generation.
   Before API creation, only an active route with connection `status=loading`
   reports discovery loading; settled no-API and inactive states remain idle.
3. **Contracts:** old SDK-bound Chat records, history, checkpoints and owner grants
   remain readable and retain historical identity. New, retried and persisted
   queued SDK Matrix turns fail closed with safe new-Chat recovery; they never
   resume opaque SDK sessions as Pi or fall back to another account/model.
   Owner-key/profile launches preserve owner routing and clear conflicting ambient
   `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
   `ANTHROPIC_CUSTOM_HEADERS` before installing the selected owner credentials.
   Read-only funded-source
   discovery and the Pi broker keep their existing authority. Opening the picker
   focuses its accessible container rather than search; explicit search interaction
   and focus return remain supported. Initial and refresh loading show an accessible
   spinner directly in the closed Chat panel provider/model trigger; opening the
   picker is not required to see loading. Opening or reopening a picker reuses the
   current scope/generation catalog without another request or spinner. Only the
   initial read, explicit refresh and existing lifecycle/Settings/account/runtime
   invalidation paths may reload it; UI reuse never replaces server admission.
   Concurrent focus/visibility events join a pending read rather than issuing or
   queuing another read. Explicit Settings/refresh still validates newer state.
   Rebuilding a local display fallback within the same API/principal/runtime/
   generation does not restart discovery; authority scope changes still do.
   Global, project and agent-conversation
   composers propagate that state and block Send while discovery is pending.
   The trigger preserves any bound model and safe funding reason. Cached
   discovery may remain visible only within its original scope/generation;
   pending refresh does not admit a Send or establish current execution readiness.
4. **Validation / error matrix:** stale catalogs cannot offer or send through the
   retired Matrix SDK descriptor even when it says available. Missing, revoked,
   unknown and wrong-driver identities cannot synthesize a managed Pi choice.
   Loading does not imply Ready, Unavailable or executable admission. GLM discovery
   and execution still require supported mapping, current global/runtime policy,
   reviewed pricing and the appropriate receipt; renderer lists cannot bypass them.
5. **Good / base / bad cases:** an authorized Sonnet or GLM has one Matrix AI model
   row backed by Pi, without a Pi label. A held route retains its disabled row and
   reason. An old SDK conversation opens read-only and directs recovery to a new
   Chat. Owner-connected Claude/Pi labels and execution remain unchanged. A slow
   catalog displays loading, and opening it does not steal focus into search.
6. **Required tests:** actual catalog/admission/adapter and persisted queued-run
   paths reject retired SDK Matrix execution before lease/dispatch; old reads and
   non-Matrix routes remain intact. Shared/Web/Electron/Native presentation tests
   cover old-catalog filtering, labels, focus, initial/refresh spinner, no fetch on
   picker open/reopen, concurrent lifecycle read deduplication, pending/settled
   fallback presentation updates, preserved explicit and invalidation refresh, and
   preserved
   selection/held-credit/cancellation. Exact final Preview plus Electron acceptance
   verifies a single Matrix model row, no Pi/SDK detail, no search autofocus and a
   visible loading spinner with the picker closed, including project and agent
   conversation startup. Popup-only animation does not satisfy this requirement.
   Paid GLM or cancellation remains a separate funded gate.
7. **Wrong / correct:** hiding an SDK row alone does not retire its execution.
   Enforce retirement at the credential and actual dispatch boundaries, preserve
   historical owner data, and use current catalog authority. Do not migrate opaque
   sessions, add unauthorized GLM rows, relabel legacy identity as Pi, or settle an
   unknown reservation from status alone.


## Ordinary owner Pi service and Custom MCP broker

### 1. Scope / Trigger
Ordinary private Matrix AI/Pi Chat discovers and calls the owner's connected services
and configured Custom MCP. It does not impersonate a recipe Bot or inherit Bot grants.
Recipe Bot service calls retain their explicit recipe/grant rules. Metadata and tool
results are untrusted data, never new permission or instructions.

### 2. Signatures
`createManagedPiOwnerTools({authority, signalFor, integrations?, mcp?, approvals?})`
provides `open(binding, emit)`, `prepare(binding, request, signal)`,
`dispatch(binding, request, signal)`, `submit(input)` and `closeRun(runId)`.
`managedPiMcpDependencies({env, platformUrl, token, handle, ownerId, clerkOwnerId})`
is production composition only. `createManagedPiMcpClient` provides bounded
`inventory(ownerId, signal)`, `describe(ownerId, serverId, signal)` and
`call(ownerId, {serverId, tool, arguments, runId, approvalReceipt?}, signal)`.

### 3. Contracts
The strict broker discriminated union adds `integration.describe {service}`,
`mcp.inventory {}`, `mcp.describe {serverId:uuid}` and
`mcp.call {serverId:uuid, tool, arguments}`. Preserve `integration.call`
`{service, action, connectionId, params}`. Parameter JSON is capped at32KiB;
requests at240KiB and results at192KiB. Worker requests never name actor, bearer,
URL, approval flag, receipt or generation authority.

At each prepare/dispatch, validate the live registered personal owner, private Chat,
run, runtime handle and execution generation. Only an already registered pending
run may revalidate while `waiting_for_approval`; it cannot create another binding.
`supervised` remains read-only. Full-access service writes/sends still require a
canonical exact-call approval. Descriptions come from the bounded owner-authoritative `/agent-catalog`, intersected
with reviewed local action risk and parameters. Revalidate the admitted workspace
fingerprint with the same live binding. Select one current connection ID and a unique current
service/label; reject ambiguous labels and recheck the account before dispatch.

MCP uses the Platform's existing `/internal/containers/:handle/mcp-servers` and
`mcp-approvals` routes with machine bearer and signed Gateway delegation.
Gateway owns the `x-matrix-mcp-run-id`; calls always carry `approvalGranted:false`.
Prepare intersects current authoritative/local server revision and tool policy;
`always_ask` requires the existing authenticated human proof and a one-use private
receipt. The worker never receives that receipt. First MCP initialization is
serialized per run, and revoked/closed runs cannot initialize another lease.

Approval preparation precedes durable business-effect checkpoint dispatch. Human
waiting is bounded at10minutes on both broker sides; ordinary discovery and call
transport retain their10/25/30second deadlines. Stop/lifetime abort bounds even a
noncooperative preflight. Consume the prepared authorization once; after dispatch,
an unobserved response remains `effect_unknown`, never an automatic write retry.
Terminal/expired/recovered runs abort pending waits, clear prepared state and revoke
MCP leases. Run registries cap64 entries and per-run action state caps60 entries.

The existing isolated staging fixture may delegate only Custom MCP through
`MATRIX_PREVIEW_CUSTOM_MCP_ORIGIN/TOKEN/OWNER_ID` when `MATRIX_PREVIEW_RUNTIME=true`.
Origin must be the exact `pr-N---matrix-platform-preview-*.a.run.app` HTTPS tag;
owner must be `chat-share-preview-fixture-pr-N`. Preserve the actual Chat owner's
independent authority. Ordinary shared Preview access to personal MCP stays denied.
No production OAuth credentials are copied into staging.

### 4. Validation & Error Matrix
- Missing/conflicting configured owner or missing dependencies: omit capability;
  do not pretend the worker can call it.
- Foreign/shared/terminal Chat, stale generation, canceled run or ungranted tool:
  bounded allowlisted refusal before external work.
- Unknown service/action, invalid/extra params, missing/ambiguous/replaced account:
  fail closed; never sync or choose the first account.
- Declined/canceled/stale approval or missing signed MCP human proof: no effect
  checkpoint or remote action. Duplicate tool IDs/receipts cannot dispatch twice.
- Preview policy denial, mismatched policy revision, forged `approvalGranted`, unsafe
  remote URL/redirect/private DNS: existing Platform/broker rejection remains.
- Network/transport failure after dispatch: preserve unknown-effect accounting.
  Raw provider messages, credential material and arbitrary URLs never reach clients.

### 5. Good / Base / Bad Cases
Good: a current owner asks for a registered service read; Pi inventories the account,
describes its parameters and obtains a real bounded result. An enabled allow-policy
MCP read executes through a registered run. Base: a service write pauses for the exact
canonical approval; existing recipe grants and file/memory tools remain independent.
Bad: a worker invents owner/account/receipt, approves itself, races MCP initialization,
reuses a declined request, or resumes a terminal generation to repeat a write.

### 6. Tests Required
`managed-pi-owner-tools.test.ts`: exact account/params/mode checks, fresh unique
negative tool IDs, canonical approval/decline/Stop, changed account, bounded states.
`managed-pi-mcp-tools.test.ts`: lazy/concurrent initialization, signed continuation,
receipt kept private, abort/revoke, actual Pi loop->broker->owner tools and no Bot rows.
`managed-pi-mcp-client.test.ts`: typed client against real Hono routes/CustomMcpBroker
DTOs, revision policy, run headers, once-only receipts, bounded parse and owner scope.
Composition tests cover VPS Clerk-only owner and conflicting identities. Preserve
Preview/SSRF/approval contracts. Exact-head Electron + the existing Preview VPS
must separately evidence model continuation, real remote tool checkpoint and settled
paid usage. A staging allow-policy read does not certify a live production always-ask
proof or a personal OAuth account; report those facts separately.

### 7. Wrong vs Correct
Wrong: expose a remote bearer to Pi, grant owner access from the model's arguments,
use recipe identity for ordinary Chat, or remove Preview/approval gates for testing.
Correct: inject server-owned services into the registered private run, ask through
canonical Chat, consume exact authorization and use the existing bounded Platform
transport. Preserve external unknown effects until independent evidence arrives.


## Embedded Pi SDK 1.0 contract

### 1. Scope / Trigger
Upgrade the Matrix-owned worker SDK to the explicitly requested official stable1.0.0.
The separately installed user Pi CLI is neither proof nor a dependency of that worker.

### 2. Signatures
`Agent({finishTurn})` ends a completed turn using `{action:"end"}` for a blocking person
question or exhausted tool budget. `estimateContextTokens` imports from the public
`@earendil-works/pi-ai/utils/estimate`, no removed agent-core re-export.

### 3. Contracts
Direct pi-agent-core/pi-ai, root pi-ai/pi-telemetry pins and immutable lock graph are
1.0.0. Keep pnpm10.33.4 and global minimumReleaseAge10080. The user-requested fresh
upgrade uses exactly pi-agent-core@1.0.0, pi-ai@1.0.0 and pi-telemetry@1.0.0 release-age
exceptions, supported by pnpm>=10.19; no wildcard/version range/general exclusion.
CI/release paths retain frozen-lockfile. Registry integrities must match the locked
official tarballs. Chord's unused experimental harness disappears from runtime graph;
no SDK-native credential discovery, unreviewed MCP, storage or broad network access.

The Bot digest is `884f3410867236443e79580ae16425c23909bc15fb79daec11db6c3dc81eebd4`;
the managedPi digest is `5e2e3b9f0785deb28f7b6334f7df8f96f84d9365978d4d459778b78acf31fc37`.
Supervisor, invocation, build/worker metadata and acceptance fixtures pin1.0.0.
Preserve distinct profile mount roots and broker_only network policy. Historical
spike/session provenance remains historical; never relabel an old accepted worker.

### 4. Validation & Error Matrix
Removed shouldStopAfterTurn/estimator exports: test failure/type error until public
API migration. Wrong harness/version/digest, including0.86.1: reject admission before
launch. Unknown fresh transitive dependency: do not broaden safety exceptions.
Blocking questions/budget completion must not request an extra inference turn or
consume queued steering. Session compaction/cancellation preserve prior semantics.

### 5. Good / Base / Bad Cases
Good: actual1.0 SDK executes broker-only tools, ends for pending person input and
resumes accepted steering under the current run. Base: unrelated Claude profile
and user CLI remain independent. Bad: changing only a displayed version, accepting
old workers under a new digest, using latest/ranges or disabling frozen installs.

### 6. Tests Required
Actual installed SDK loop/session tests for questions, exhausted budgets, steering,
errors/abort and token estimation; real bundled worker import/build; exact profile
pins/digests and explicit old0.86.1 rejection; private admission and managed Chat.
Root normal install then frozen install must reproduce the lock with official
integrities. Final Electron+host immutable provenance must record SDK1.0 alongside
actual paid model/tool continuation; source manifests alone do not establish deploy.

### 7. Wrong vs Correct
Wrong: infer embedded SDK version from `pi --version`, replace a removed hook name
without testing stop semantics, or put every Pi version on a release-age allowlist.
Correct: verified official exact packages+lock, public1.0 APIs, aligned invocation
certificates, preserved termination and exact immutable deployed worker evidence.


## Audited support recovery of unresolved execution

`POST /api/operator/ai/funded/runtimes/:handle/policy-execution-release` is private
operator support, authenticated solely with the Platform operator secret. It is
not a Chat/runtime/Relay endpoint and accepts no query overrides. The strict body
is limited to 4 KiB. The server derives owner/machine/runtime from the running,
authorized handle and checks the separately supplied expected owner.

The payload pins reservation/token/request IDs and immutable started/expiry
timestamps; supplies a terminal local run ID/state/time, bounded evidence and
reviewer references; explicitly accepts unknown upstream liability; and supplies
an upper liability amount matching the reservation's saved `maxCostMicrousd`.
Only an expired `in_flight` usage request with unknown actual cost is eligible.
A full 15-minute maximum Relay lifetime plus a 1-minute grace must have elapsed
since inference start, with at least 1 minute after the attested local run end.
The supplied ceiling cannot exceed 500,000 microusd. This is administrative risk
acceptance, not evidence that upstream execution stopped or that cost is zero.

Under the existing owner advisory transaction lock, the transition stores one
immutable `execution_admission_release` audit record. It leaves financial status
`in_flight`, actual cost null, every balance/monthly reserve/source allocation,
and debit ledger unchanged. Exact replay returns the recorded result; conflicting
replay rejects. At most ONE audited still-unknown obligation per owner is allowed,
enforced by both transaction checks and a partial unique PostgreSQL index.
Other live executions prevent recovery. Ordinary authorization/start cannot replay
an audited request into another inference dispatch.

The durable `idx_ai_funded_usage_active_owner` index retains its name and excludes
only audited execution releases. A transactional replacement preserves uniqueness
through migration; older instances retain conservative admission checks and skip
newer schema generations. Old code may block new execution beside an audited
unknown obligation, so a runtime rollback can reduce availability. Older binaries
do not implement the audit-aware authorization/start replay fences: schema
compatibility alone does not prove dispatch safety on rollback. Keep a recovered
owner's funded control-plane routing on recovery-aware binaries until exact
settlement; do not roll that path back while its audited usage remains unknown.
Financial protection still includes all
in-flight reservations, even when the backing promotion expires. Late exact
settlement remains once-only and cannot remove a newer execution slot.

Required evidence: rejected ordinary/Relay/runtime auth and oversized/malformed
bodies; exact identity, expiry/lifetime, non-usage and terminal-evidence refusal;
unchanged financial/source state; replay fencing; one-unknown cap; actual independent
PostgreSQL pools with one live execution; and late settlement preserving the newer
slot. No automatic timeout unlock, fake exact charge, grant, or paid upstream call
belongs to this support API.


## Managed GLM reasoning and receipt contract

1. **Scope:** the credential-free Pi bridge describes its models as non-reasoning
   and sends streaming GLM tool requests without `reasoning_effort`. GLM cannot
   disable reasoning; omission selects the provider maximum. Normalize that
   omission at the existing managed GLM request boundary. This does not change
   owner-connected coding routes or Anthropic requests.
2. **Signature:** `serializeFundedOpenAiRequest(value: unknown)` validates the
   sole allowlisted managed GLM model before authorization and returns its bounded
   request and upstream JSON. No new endpoint, credential or configuration is added.
3. **Contract:** `reasoning_effort` accepts `low`, `high`, or `max`; omission sends
   `low`. Explicit supported effort remains unchanged. Preserve tool definitions,
   tool choice, messages, streaming, final-aggregate usage, output bounds and
   `store:false`. Funded generation requests explicitly collect metadata with
   `cf-aig-collect-log:true`, suppress payloads with
   `cf-aig-collect-log-payload:false`, and retain `cf-aig-zdr:true`. Only existing
   server-produced pseudonymous metadata is forwarded. Count/readiness/evaluation
   collection behavior remains unchanged. Gateway-wide settings remain separate.
4. **Validation:** `none`, `minimal`, `medium`, `xhigh`, null and non-string effort
   fail before control-plane admission. The existing bounded first-response and
   complete-response deadlines and caller cancellation remain. Unknown usage after
   timeout cannot become zero or a confirmed charge; exact receipts remain required.
5. **Cases:** an ordinary GLM tool turn sends low; a deliberate high/max request
   preserves that value; unsupported OpenAI aliases reject rather than silently
   selecting maximum reasoning. Metadata logging cannot recreate historical logs
   or prove that a delayed provider response will complete.
6. **Tests:** capture the actual pinned Pi SDK request through its Unix bridge and
   EOF broker into the funded serializer for text and tool turns. Assert low,
   unchanged tools/auto choice/output bound, one dispatch and completed SDK result.
   Test explicit supported/invalid efforts and refusal before admission. Inspect
   actual Anthropic and Workers AI generation headers for metadata collection,
   payload suppression, pseudonymous identity, credential isolation and unchanged
   count/readiness behavior. Run existing usage, rejection, timeout/cancel and
   normalization suites. Live model acceptance remains independent evidence.
7. **Wrong/correct:** do not treat Pi's off flag as upstream disabled reasoning or
   fix latency by retrying a potentially charged request. Send an explicit
   model-supported bounded effort and preserve unknown financial liability.

Provider semantics: [Cloudflare GLM5.3Flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/).
Metadata-only override: [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/).
