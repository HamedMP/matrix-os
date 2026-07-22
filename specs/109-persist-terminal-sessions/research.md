# Research: Persistent Terminal Sessions

## Decision 1: Mandatory gates run on a PR preview VPS

**Decision**: extend the existing `preview-vps` path with a separate
same-repository, label-gated pull-request workflow that waits for the exact-head
PR VPS, includes throwaway assets only in that preview host bundle, invokes one
fixed launcher through the existing authenticated/bounded terminal runner and
legacy sudo grant, then runs the harness in a detached, fixed-prefix transient
system service. The workflow polls the recovered gateway for a completed,
capped evidence archive, validates it, and uploads it as a GitHub artifact. The
detachment is required because S1 intentionally restarts and crashes the gateway;
a gateway-owned harness is killed with that cgroup and cannot return its own
result. Retain
`workflow_dispatch` for reruns after the workflow exists on the default branch;
GitHub cannot manually dispatch a brand-new workflow from an unmerged PR.

Customer VPS nginx currently presents a generated self-signed certificate and
the platform's established transport sets `CUSTOMER_VPS_TLS_VERIFY=false`. The
spike matches that policy only for the authenticated, exact-IP disposable
preview. It sends a handle-derived gateway token, never `PLATFORM_SECRET`; any
transport-token exposure is limited to the reaped preview and is not carried
into the production supervisor design.

**Rationale**: the preview flow already builds the exact host bundle, pins the PR
SHA, provisions an isolated Ubuntu VPS, and has bounded automatic reaping. The
spike requires systemd, cgroup v2, and the bundled `/opt/matrix/bin/zellij`; a
container or developer laptop cannot prove those properties.

**Alternatives considered**:

- Local/container spike: rejected because it cannot prove production systemd,
  cgroup ownership, updater behavior, or the bundled binary.
- Ad-hoc operator SSH with uncommitted scripts: rejected because customer
  previews do not expose a repository-scoped SSH credential and evidence would
  not be reproducible or tied to a reviewed commit.
- Production implementation first: forbidden by FR-001.

## Decision 2: Evidence is bounded and privacy-safe

**Decision**: preserve only JSON/text metadata needed by S1/S2: versions, fixed
unit/config text, PID roles, `/proc/<pid>/cgroup`, `cgroup.events`, process state,
cache relative paths/sizes/digests, line counts, and pass/fail codes. Replace host
IP, display names, cwd, terminal contents, and command payloads with fixed probe
tokens before upload. Cap the artifact at 8 MiB and every file at 256 KiB.

**Rationale**: terminal contents can contain credentials and paths. The gates need
structure and outcomes, not user data.

**Alternatives considered**:

- Upload full journals/scrollback: rejected as unnecessary sensitive retention.
- Store only a boolean: rejected because reviewers cannot audit the empirical
  process tree, cache mapping, or failure behavior.

## Decision 3: One native peer-credential acceptor, TypeScript handlers

**Decision**: use a minimal Linux C acceptor for the stable supervisor socket.
It obtains `SO_PEERCRED`, enforces uid and frame bounds, then starts one fixed
TypeScript operation handler with the accepted socket and credentials on
anonymous FDs. Client bytes, runtime IDs, paths, and operations never enter argv
or environment.

**Rationale**: Node's documented `node:net` IPC surface does not expose peer
credentials. Node-API is ABI-stable, but extracting a private `net.Socket` file
descriptor would still depend on undocumented Node internals. A tiny auditable
acceptor keeps the kernel boundary native while leaving schemas/state logic in
the repository's required language.

**Alternatives considered**:

- Socket mode/group only: rejected because FR-031 requires kernel peer identity.
- `socket._handle.fd` plus addon: rejected because `_handle` is undocumented.
- General root daemon in C/Rust: rejected as a much larger non-TypeScript trusted
  codebase and new toolchain.
- User systemd: rejected by the selected architecture and broad user-manager
  authority.

References: [Node `net` IPC documentation](https://nodejs.org/api/net.html),
[Node-API ABI stability](https://nodejs.org/api/n-api.html).

## Decision 4: Protocol framing and idempotency

**Decision**: protocol v1 uses one 4-byte unsigned big-endian length followed by
strict UTF-8 JSON, capped at 128 KiB. Requests contain only `version`, one of the
seven operation names, a 32-hex operation ID, and the operation's typed bounded
fields. Responses use the same framing and a bounded code/result union. The
acceptor closes after one request/response.

**Rationale**: one-shot framing is easy to bound and fuzz. Fixed operation IDs,
global-name-before-runtime `flock` ordering, and receipt operation generations
make retry behavior deterministic across gateway/handler crashes.

**Alternatives considered**:

- newline JSON: rejected because framing/oversize behavior is ambiguous.
- protobuf/gRPC: rejected as unnecessary dependency and codegen surface.
- arbitrary systemd D-Bus proxy: rejected as a privilege expansion.

## Decision 5: Stable runtime packaging

**Decision**: build `packages/terminal-runtime` during the host bundle, copy its
compiled modules, node-pty runtime files, and native acceptor atomically into
`/opt/matrix/libexec/terminal-runtime/v1/`, and install fixed executable wrappers
under `/opt/matrix/bin`. Never import from `/opt/matrix/app` at runtime.

**Rationale**: gateway rollback replaces only the app directory. Existing keepers
must retain their old mapped code/native binding while future instances use the
new atomically installed version.

**Alternatives considered**:

- Import package files from `/opt/matrix/app`: rejected because a deployment can
  replace those bytes while keepers are active.
- Bundle JS into each wrapper: rejected because native node-pty support and
  protocol compatibility still need a versioned support directory.

## Decision 6: Zellij recovery stays explicit and gated

**Decision**: use the pinned `v0.44.3-matrix.1` build: upstream Zellij 0.44.3
source plus a minimal Matrix patch that serializes bounded pane contents for
command panes, preserves the pristine resurrected grid behind the native
held-command banner, and includes the viewport inside the serialization row
limit. Command panes retain Zellij's serialized `start_suspended true` gate.
Production recovery never passes `--force-run-commands`; cache
corruption/incompatibility yields a fresh shell and bounded reason. A prior agent
never resumes automatically.

**Rationale**: disposable-VPS evidence on 0.44.1 passed S1 but failed viewport
and bounded-scrollback restoration. Source inspection found that released 0.44.3
and upstream `main` both omit serialized contents for command panes and retain
the destructive held-pane reflow, so a released upgrade does not fix either
defect. Matrix-owned plaintext replay would duplicate terminal emulation and
command-gating behavior. The narrow patch retains native gating while making the
history state explicit and non-destructive.

**Alternatives considered**:

- Use released Zellij 0.44.3 unchanged: rejected because its held-command banner
  still clears restored viewport and scrollback on reflow.
- Replace Zellij resurrection with Matrix-owned screen dumps/replay: rejected
  because it loses terminal state fidelity and creates a second command-gating
  state machine.
- Treat any cache directory as recoverable: rejected because receipt/cache
  presence does not prove compatibility or safe command gating.

## Decision 7: Multiple PRs are mandatory

**Decision**: preserve the six stack layers in `plan.md` rather than placing the
entire feature in one upstack PR.

**Rationale**: the feature crosses native privilege code, filesystem contracts,
gateway APIs, coding-agent launch semantics, React UI, updater/cloud-init, and
live VPS verification. A single PR would exceed repository limits and obscure
trust-boundary review.

**Alternatives considered**:

- One implementation PR: rejected by the 3,000-addition/50-file hard limit and
  by the independent empirical gate.
