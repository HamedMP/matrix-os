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
   `158a42f750eec1cca6aebd90cbe5b5955eea57fca1c06d08b72b084b94e32ef4`.
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
revision. Stop at Human Review before requested Greptile and landing gates. Automated
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
   owner admission barrier until exact evidence arrives; this policy is unchanged.
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
   spinner while preserving any bound model and safe funding reason. Cached
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
   cover old-catalog filtering, labels, focus, initial/refresh spinner and preserved
   selection/held-credit/cancellation. Exact final Preview plus Electron acceptance
   verifies a single Matrix model row, no Pi/SDK detail, no search autofocus and a
   visible loading spinner. Paid GLM or cancellation remains a separate funded gate.
7. **Wrong / correct:** hiding an SDK row alone does not retire its execution.
   Enforce retirement at the credential and actual dispatch boundaries, preserve
   historical owner data, and use current catalog authority. Do not migrate opaque
   sessions, add unauthorized GLM rows, relabel legacy identity as Pi, or settle an
   unknown reservation from status alone.
