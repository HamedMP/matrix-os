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
