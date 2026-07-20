# Feature Specification: Persistent Terminal Sessions Across Deployments

**Feature Branch**: `109-persist-terminal-sessions`
**Created**: 2026-07-20
**Status**: Draft — implementation blocked on mandatory disposable-VPS spikes
**Input**: User request: "Persist terminal sessions across deployments using externally supervised runtimes, immutable identities, explicit recovery, durable bounded resurrection state, strict privilege boundaries, and deployment-safe lifecycle guarantees."

## Scope Boundary

This feature owns the lifetime, identity, recovery, deletion, and deployment behavior of normal shell sessions and interactive coding-agent terminal sessions on production customer VPSes. It adds the owner-facing lifecycle contract, the privileged runtime-control boundary, durable recovery metadata, bounded terminal-history resurrection, and updater guarantees needed for a terminal process to outlive gateway, shell, browser, and normal host-bundle restarts.

This feature coordinates with:

- `specs/107-terminal-multi-device/`, which owns terminal workspace/tab topology, client sizing, WebSocket output, and gateway scrollback. This spec replaces spec 107's incorrect assumption that gateway-owned Zellij servers already survive gateway shutdown.
- `specs/105-coding-agent-shells/`, which owns the coding-agent experience. This spec changes how its interactive processes are launched and how authoritative liveness is determined, but does not change provider product semantics.
- `specs/070-vps-per-user/`, the host-bundle release path, and the customer-VPS updater, which must preserve independently owned terminal cgroups during updates and rollbacks.

Out of scope:

- adopting or reparenting already-running gateway-owned processes;
- automatically restarting terminals, commands, or agents after a host reboot;
- automatically resuming an agent after recovery;
- hiding the ordinary Linux process arguments of a command that the owner explicitly runs;
- changing deployment cadence;
- Docker as a production runtime;
- a hard per-session memory limit in v1;
- public documentation publication in this repository. Public lifecycle documentation ships as a separate PR to the private `FinnaAI/matrix-os-site` repository after the behavior is verified.

## Verdict and Mandatory Implementation Gate

The target architecture is selected, but implementation MUST NOT begin until both disposable-VPS spikes below pass with the exact bundled Zellij 0.44.1 binary on a production-representative Ubuntu customer VPS. Throwaway spike code and units are evidence, not production implementation. Failure of either spike requires revising this spec's service or recovery model; it does not permit weakening an invariant.

### Gate S1 — Foreground supervision and cgroup ownership

The spike MUST prove that a foreground keeper can remain the service main process while owning a Zellij server, shell/pane, and optional agent inside one per-runtime cgroup. It MUST record the gateway, browser attach client, keeper, Zellij server, initial shell/pane, and agent PIDs plus `/proc/<pid>/cgroup` before and after:

1. detaching all browser clients;
2. stopping, restarting, and crashing the gateway;
3. restarting the shell service;
4. stopping the terminal unit;
5. killing the keeper;
6. killing the Zellij server.

S1 passes only when:

- the keeper is long-running and remains the service `MainPID`;
- the keeper, Zellij server, initial shell/pane, and optional agent are in the runtime unit cgroup;
- the gateway and every attach client remain outside that cgroup;
- browser, shell, and gateway lifecycle events do not change the keeper, server, shell, or agent PIDs;
- stopping the runtime unit makes its cgroup report `populated 0`;
- unexpected keeper or server loss produces exactly one deterministic interrupted/failed outcome;
- readiness is withheld until the exact Zellij session responds and all required cgroup membership checks pass.

### Gate S2 — Zellij 0.44.1 resurrection and bounded history

The spike MUST establish the exact Zellij 0.44.1 configuration spelling and observed behavior equivalent to:

```kdl
session_serialization true
pane_viewport_serialization true
scrollback_lines_to_serialize 10000
serialization_interval 5
```

S2 passes only when it proves:

- the exact cache location and files belonging to one immutable runtime identity;
- restoration of layout, viewport, and at most 10,000 scrollback lines per pane;
- an approximately five-second maximum serialization interval loss window;
- restored commands remain behind explicit Zellij confirmation and `--force-run-commands` is absent;
- missing, corrupt, incompatible, and expired cache state can be detected and falls back to a fresh shell without running a prior command or agent;
- complete runtime-specific recovery state can be removed on explicit deletion;
- disk accounting can attribute and bound inactive recovery state by runtime;
- live serialization can be disabled safely under aggregate pressure, or the feature remains blocked pending a filesystem-quota design.

The current Zellij guide documents session serialization, optional viewport/scrollback serialization, cache-backed resurrection, and confirmation-gated command restoration, but this documentation is not a substitute for the exact-version spike: [Zellij options](https://zellij.dev/documentation/options.html) and [session resurrection](https://zellij.dev/documentation/session-resurrection.html).

## Background and Repository Evidence

1. Normal sessions are launched through a gateway-owned `node-pty` and retained in a gateway in-memory map (`packages/gateway/src/shell/zellij.ts`). Interactive coding-agent Zellij sessions use the same ownership pattern (`packages/gateway/src/zellij-runtime.ts`).
2. `matrix-gateway.service` runs as `matrix` under systemd's default control-group lifecycle and hard memory controls. The updater stops the gateway on both successful deployment and rollback (`distro/customer-vps/systemd/matrix-gateway.service`, `distro/customer-vps/host-bin/matrix-sync-agent`).
3. The browser recreates saved names that are absent from the live Zellij list (`shell/src/components/terminal/TerminalApp.tsx`), which turns an interrupted session into a misleading empty replacement shell.
4. The mutable display name is currently the runtime identity. Rename changes the Zellij identity plus name-keyed registry, scrollback, preference, and agent-state records (`packages/gateway/src/shell/registry.ts`).
5. The generated Zellij config does not explicitly enable viewport serialization, while the bundle pins Zellij 0.44.1 (`packages/gateway/src/shell/zellij-config.ts`, `scripts/build-host-bundle.sh`).
6. Agent prompts, settings, working directories, commands, arguments, and dynamic configuration currently enter process arguments and durable KDL layouts (`packages/gateway/src/agent-launcher.ts`, `packages/gateway/src/zellij-runtime.ts`).
7. Customer VPS provisioning grants `matrix` unrestricted `NOPASSWD:ALL`. A terminal-only supervisor protocol is not a narrow privilege boundary until that grant is removed and other privileged flows use separately typed root-owned services/helpers (`distro/customer-vps/cloud-init.yaml`).
8. User-systemd lingering is enabled, but that does not provide an independently proven narrow authority or per-runtime resource-control model.
9. Existing gateway scrollback stores owner terminal output with a 5 MiB per-session default (`packages/gateway/src/shell/scrollback-store.ts`). Zellij resurrection creates an additional owner-controlled history store with separate privacy and retention implications.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Running Terminal Survives Normal Deployments (Priority: P1)

As a Matrix OS owner running a shell command or interactive coding agent, I want normal gateway, shell, browser, and host-bundle deployments to leave the running terminal process untouched so long-running work is not interrupted by product updates.

**Why this priority**: Deployment interruption is the primary failure this feature exists to eliminate.

**Independent Test**: Start a continuous-output command and a coding agent, record their runtime identities, PIDs, and cgroups, then apply two consecutive bundles plus a forced failed update and rollback. The terminal runtime PIDs and cgroup remain unchanged while new gateway attach clients reconnect.

**Acceptance Scenarios**:

1. **Given** a live terminal runtime, **When** the gateway is restarted or crashes, **Then** the keeper, Zellij server, shell, and agent remain alive with unchanged PIDs and the runtime remains attachable after gateway recovery.
2. **Given** a live terminal runtime, **When** a normal host bundle is applied, **Then** updater stop/start operations do not target the terminal unit, supervisor, or terminal slice, and terminal output continues.
3. **Given** a live runtime created by a newer compatible gateway, **When** the application bundle rolls back to the previous supported gateway, **Then** the runtime remains alive and attachable through protocol v1.
4. **Given** every browser/device is detached, **When** no owner is actively viewing the terminal, **Then** the runtime remains live until it exits, is explicitly deleted, or fails.

---

### User Story 2 - Recovery Is Explicit After Reboot or Failure (Priority: P1)

As a Matrix OS owner returning after a reboot or runtime failure, I want the UI to show that my terminal was interrupted and let me explicitly recover it, including bounded visible history when safe, without silently rerunning commands or agents.

**Why this priority**: Persistence must not turn into unattended command execution.

**Independent Test**: Reboot with live shell and agent terminals, verify no terminal instance starts automatically, then recover one session with valid serialized state and another with missing/corrupt state.

**Acceptance Scenarios**:

1. **Given** a runtime was live before reboot, **When** the host returns, **Then** no terminal unit, prior command, or agent starts automatically and the UI shows `interrupted` with an explicit Recover action.
2. **Given** valid bounded resurrection state, **When** the owner chooses Recover, **Then** layout, viewport, and bounded scrollback return while prior commands remain confirmation-gated and the prior agent is not resumed.
3. **Given** missing, corrupt, incompatible, expired, or evicted resurrection state, **When** the owner chooses Recover, **Then** a fresh shell starts in the last safe working directory (or owner home), and the UI reports `history_unavailable` or `cwd_unavailable` without exposing internals.
4. **Given** a saved shell layout references an absent runtime, **When** the browser loads, **Then** it shows the authoritative interrupted/recoverable state and never silently creates a replacement runtime.

---

### User Story 3 - Rename and Multi-Device Attach Preserve One Runtime (Priority: P1)

As a Matrix OS owner, I want display names and saved layouts to remain convenient while the underlying runtime identity stays immutable, so renaming or opening from another device cannot replace or fork a running terminal.

**Why this priority**: Mutable name-based identity is the source of unsafe rename, recreation, and race behavior.

**Independent Test**: Create a runtime, attach two devices, rename it, and race Rename/Recover and Recover/Recover calls. Every response resolves to one immutable runtime and one unit/Zellij identity.

**Acceptance Scenarios**:

1. **Given** a live runtime, **When** the owner renames it, **Then** only display metadata and the global name index change; runtime ID, unit identity, Zellij identity, recovery history identity, keeper, shell, and agent remain unchanged.
2. **Given** two devices open the same display name or runtime reference, **When** both attach, **Then** both connect to the same existing runtime and neither request implicitly creates or recovers it.
3. **Given** two concurrent Recover requests, **When** the runtime is inactive, **Then** at most one unit starts and both callers observe the same recovering/live operation.
4. **Given** an old name-only saved layout, **When** it is opened within the 24-hour compatibility window, **Then** the alias resolves to the immutable runtime and the layout migrates to runtime ID plus display metadata.

---

### User Story 4 - Explicit Delete Is Complete and Irreversible (Priority: P2)

As a Matrix OS owner deleting a terminal, I want its full process group and recovery data removed only after termination is proven, so it cannot keep running or later resurrect unexpectedly.

**Why this priority**: Owner control and safe deletion are constitutional requirements.

**Independent Test**: Delete a runtime with multiple panes, descendants, and attached clients; verify clients are notified, the cgroup becomes empty before state removal, all runtime-specific history is removed, and a later Recover cannot recreate it.

**Acceptance Scenarios**:

1. **Given** a populated runtime cgroup, **When** Delete begins, **Then** lifecycle becomes `deleting`, new recovery is forbidden, clients are notified, and the complete cgroup is stopped.
2. **Given** the cgroup is still populated, **When** cleanup runs, **Then** no receipt, name index, agent state, gateway scrollback, or resurrection state is removed yet.
3. **Given** `cgroup.events` reports `populated 0`, **When** deletion completes, **Then** all runtime-owned state is removed and repeated Delete calls remain idempotent.
4. **Given** Delete committed before a concurrent Recover, **When** Recover acquires the runtime state, **Then** it cannot start or recreate the deleted runtime.

---

### User Story 5 - Operators Get a Narrow, Observable Runtime Boundary (Priority: P2)

As a Matrix OS operator, I want terminal lifecycle operations constrained to a typed owner-only protocol and fixed unit shape, with bounded metadata and coarse telemetry, so terminal persistence does not grant the gateway generic root or systemd control.

**Why this priority**: Separation from the gateway is safe only if the new privileged boundary is narrower than the current unrestricted sudo model.

**Independent Test**: Attempt traversal, metacharacter, oversized-ID, alternate-template, unrelated-unit, arbitrary-path, executable, environment, and systemd-property injections. Every request is rejected before any systemd executor runs; valid operations affect only the fixed terminal template.

**Acceptance Scenarios**:

1. **Given** a gateway peer owned by `matrix`, **When** it sends a valid versioned request, **Then** the supervisor performs only the corresponding typed operation for a validated runtime ID.
2. **Given** any invalid or out-of-scope request, **When** it reaches the socket, **Then** it is rejected with a bounded generic response before locks, filesystem path derivation, descriptor access, or systemd invocation.
3. **Given** a normal lifecycle event, **When** telemetry is emitted, **Then** it contains only counts, coarse states, cgroup pressure, descriptor count, aggregate bytes, and a truncated runtime-ID hash—never terminal contents, display names, commands, providers, prompts, credentials, or paths.
4. **Given** an existing or newly provisioned VPS, **When** this feature is deployed, **Then** the `matrix` owner no longer has generic passwordless sudo or generic `systemctl` authority.

---

### User Story 6 - Legacy Sessions Migrate Without False Survival Claims (Priority: P3)

As an existing Matrix OS owner, I want saved terminal names and working directories migrated into the new model after one clearly disclosed interruption, without claims that old gateway-owned processes survived or automatic reruns of prior work.

**Independent Test**: Upgrade a home containing legacy shell/workspace records, inspect generated immutable identities and recoverable state, and verify no legacy PID is adopted and no prior command/agent starts.

**Acceptance Scenarios**:

1. **Given** legacy session metadata, **When** the first persistent-runtime release reconciles it, **Then** each valid logical session gets a new immutable runtime ID, safe display metadata, and a recoverable receipt.
2. **Given** an old gateway-owned process was stopped by the first deployment, **When** migration completes, **Then** the UI reports interruption and never claims PID continuity.
3. **Given** legacy serialization cannot be proven safely convertible by the exact-version spike, **When** migration runs, **Then** prior history is reported unavailable instead of guessed or executed.
4. **Given** local development outside production, **When** the supervisor is absent, **Then** the existing direct `node-pty` development path remains available; production fails closed with a generic service-unavailable response.

### Edge Cases

- The gateway loses its HTTP response after the supervisor accepts Create/Recover: retry resolves the same operation and runtime instead of creating a duplicate.
- Rename races Rename: the global name index and per-runtime locks serialize both operations; the last successfully committed rename wins without changing identity.
- Recover wins before Delete: Delete durably marks `deleting`, stops the started unit, verifies an empty cgroup, then removes state.
- Delete wins before Recover: the name/runtime is no longer recoverable and Recover cannot recreate it.
- The unit is active but its receipt is missing or corrupt: reconciliation never kills the populated cgroup based only on missing metadata; it inspects validated cgroup evidence, quarantines corrupt metadata, and reconstructs bounded metadata with a safe generated display name.
- A receipt exists without a unit: the receipt never proves liveness; lifecycle is interrupted/recoverable according to validated recovery evidence.
- A unit is activating past 30 seconds: the cgroup is stopped, the operation is marked failed/recoverable exactly once, and its descriptor is removed.
- An inactive unit exists without receipt or populated cgroup: failed unit state may be reset, but user data is not inferred deleted.
- A future receipt schema is encountered: it is quarantined read-only and reported `failed/unsupported_state`; no process starts or stops solely from it.
- The stored working directory is missing or escapes owner home after symlink/realpath changes: recovery uses owner home and reports `cwd_unavailable`.
- A descriptor expires while its matching unit is activating or locked: cleanup defers until it proves no matching active operation or lock holder.
- Live serialization alone exceeds the aggregate history budget: prune nothing live; use only an S2-proven safe serialization-disable mechanism, otherwise block implementation on quota design.
- The host is under OOM pressure: soft controls reduce risk but cannot guarantee survival without a hard limit; an authoritative runtime loss reconciles to interrupted/failed.

## Requirements *(mandatory)*

### Functional Requirements

#### Implementation gates

- **FR-001**: Production implementation MUST remain blocked until Gate S1 and Gate S2 pass on a disposable production-representative Ubuntu VPS using the exact bundled `/opt/matrix/bin/zellij` 0.44.1 and their evidence is committed or linked from the implementation plan.
- **FR-002**: Failure of either mandatory spike MUST trigger a service/recovery architecture revision and renewed spec review; acceptance criteria, security boundaries, or resource limits MUST NOT be weakened merely to pass.

#### Runtime ownership and service model

- **FR-003**: Production terminal processes MUST be owned by a stable supervisor/runtime service boundary independent of the application gateway, shell, browser, and normal host-bundle application lifecycle.
- **FR-004**: The selected production model MUST consist of one root-owned `matrix-terminal-runtime.service`, a fixed `matrix-terminal-session@.service` template, and `matrix-terminal.slice`; the stable supervisor starts at boot but MUST NOT enumerate or start terminal instances automatically.
- **FR-005**: Each terminal instance template MUST use `Type=notify`, `User=matrix`, `Group=matrix`, `Slice=matrix-terminal.slice`, `ExecStart=/opt/matrix/bin/matrix-terminal-keeper %i`, `KillMode=control-group`, `TimeoutStartSec=30`, `TimeoutStopSec=30`, `Restart=no`, and `StandardOutput=null`. It MUST have no `EnvironmentFile`, `[Install]`, `WantedBy`, `RequiredBy`, `Requires`, or `PartOf`, so each runtime has foreground readiness and complete cgroup termination without boot enablement.
- **FR-006**: Browser/gateway Zellij attach PTYs MUST remain gateway children outside terminal instance cgroups and MUST never become liveness evidence.
- **FR-007**: Production MUST require a healthy compatible supervisor socket. Missing, unhealthy, or incompatible supervision MUST return a generic 503 and MUST NOT fall back to gateway-owned terminal creation. Local development MAY retain direct `node-pty` launching.
- **FR-008**: Stable runtime executables and versioned native support files MUST live outside `/opt/matrix/app`, be root-owned, and be installed through temporary files plus atomic rename rather than in-place truncation. Running helpers MUST retain their current process image across normal updates.

#### Immutable identity and metadata

- **FR-009**: Only the supervisor MAY generate runtime IDs. Each ID MUST contain exactly 128 bits encoded as 32 lowercase hexadecimal characters matching `^[0-9a-f]{32}$`.
- **FR-010**: Runtime identity MUST derive deterministically as Zellij `matrix-t-<runtimeId>` and systemd `matrix-terminal-session@<runtimeId>.service`; one trusted helper MUST validate and escape the ID. No client may submit a unit name, template, flag, or path.
- **FR-011**: Display names MUST continue to satisfy the existing safe-name contract, while rename changes only display metadata and the global name index. It MUST NOT rename the runtime, unit, Zellij session, receipt, scrollback, resurrection, or agent-runtime identity.
- **FR-012**: Canonical names and 24-hour compatibility aliases MUST be globally unique under one name-index lock. Saved shell layouts MUST migrate from name-only references to runtime ID plus display metadata.
- **FR-013**: Session list responses MUST add `runtimeId`, `lifecycleState`, `recoverable`, `recoveryReason`, and `metadataRevision`. Existing name-based routes remain compatible by validating and resolving the name to its current runtime ID server-side.

#### Authoritative lifecycle and reconciliation

- **FR-014**: The public lifecycle state set MUST be `starting`, `live`, `interrupted`, `recoverable`, `recovering`, `deleting`, `exited`, and `failed`, with bounded recovery reasons.
- **FR-015**: Evidence precedence MUST be: durable delete intent; unit/cgroup/keeper/readiness/live-Zellij evidence; current descriptor and operation generation; valid receipt and resurrection state; then presentation-only agent metadata.
- **FR-016**: `live` MUST require an active ready unit, a live keeper client, an exact responsive Zellij session, and verified keeper/server/shell cgroup membership. A spawn event, receipt, attach client, or agent metadata alone MUST NOT report liveness.
- **FR-017**: Reconciliation MUST implement every edge case in this spec, MUST never automatically kill a populated validated runtime because metadata is missing/corrupt, and MUST never start or kill a process based solely on an unsupported receipt.
- **FR-018**: Boot-ID mismatch with no active unit MUST reconcile a prior-live runtime to `interrupted`. Host boot MUST NOT start a terminal, command, or agent; only explicit Recover may start a recovery unit.
- **FR-019**: Authoritative runtime loss or explicit fresh-process recovery MAY clear stale agent-running presentation state; inactive receipt metadata alone MUST NOT.

#### Receipts and recovery intent

- **FR-020**: The supervisor MUST own versioned durable receipts under `$MATRIX_HOME/system/terminal-runtime/receipts/<runtimeId>.json`. A v1 receipt MUST contain only the following identity, display, safe cwd, timestamp, revision, last-known, boot, and Zellij fields:

```json
{
  "schemaVersion": 1,
  "runtimeId": "32-lowercase-hex",
  "displayName": "validated-name",
  "cwd": {
    "kind": "home-relative",
    "path": "projects/example"
  },
  "createdAt": "ISO-8601",
  "metadataRevision": 1,
  "lastKnown": {
    "state": "live",
    "at": "ISO-8601",
    "bootId": "bounded-host-boot-id"
  },
  "zellij": {
    "sessionName": "matrix-t-<runtimeId>"
  }
}
```

- **FR-021**: Receipts MUST NOT contain a command, prompt, credential, token, provider argument, sandbox option, or inherited environment. A receipt proves identity and recovery intent, never liveness.
- **FR-022**: Cwd MUST be resolved and realpathed inside owner home at create time, converted to an owner-relative path, and validated again at recovery. Missing/invalid cwd MUST fall back to owner home with `cwd_unavailable`.
- **FR-023**: Receipt creation/update MUST create temporary files with `wx`, verify owner/mode/link count, fsync file and parent, and atomically publish/rename `0600` files inside a `0700` pinned parent. Reads/deletes MUST use pinned parents, `lstat`, no-follow opens, single-link checks, bounded size, and strict schema validation; unsupported versions are quarantined read-only.

#### Ephemeral launch descriptors and sensitive launch data

- **FR-024**: One-shot descriptors MUST live under root-owned `/run/matrix-terminal-runtime/descriptors` with a `0700` parent and `0600` files, a 128 KiB per-file maximum, 128-pending cap, and 10-minute TTL.
- **FR-025**: Descriptor publication MUST use exclusive temporary creation plus no-replace link/rename semantics. Claim MUST verify the caller PID belongs to the exact runtime cgroup, transition pending to claimed atomically, use no-follow single-link bounded validation, unlink immediately, then return parsed data.
- **FR-026**: Descriptors MUST contain only strict versioned create/recover intent, runtime/operation IDs, safe owner-relative cwd, and bounded one-shot launch data. They MUST never be logged, placed in systemd arguments, copied to environment files, or retained after parsing.
- **FR-027**: Failed start, cancellation, timeout, gateway crash, or invalid descriptor content MUST trigger immediate descriptor cleanup; a recurring symlink-safe sweep MUST remove proven leftovers and stop on supervisor shutdown.
- **FR-028**: No user-derived prompt, command text, cwd, credential, token, sandbox path, or dynamic agent option may appear in supervisor, keeper, pane helper, provider-launch, or systemd argv, unit metadata, environment files, or journals. Cwd MUST be applied with `chdir`; prompts MUST enter providers through stdin or typed RPC; dynamic provider configuration MUST use the one-shot descriptor or inherited anonymous FD.
- **FR-029**: Existing Claude prompt/settings-in-argv and Codex base64 configuration-in-argv flows MUST be removed for supervised terminals. Fixed nonsensitive provider flags and the ordinary argv of an explicitly executed Linux command remain observable and MUST be documented as a residual limitation.

#### Supervisor protocol and privilege boundary

- **FR-030**: The owner-only Unix socket MUST expose a length-bounded, versioned protocol v1 with exactly `CreateStart`, `Inspect`, `List`, `Recover`, `RenameMetadata`, `Delete`, and `Reconcile`.
- **FR-031**: The protocol MUST reject arbitrary unit/systemd methods, executable names, shell strings, filesystem paths, environment variables, credentials, alternate templates, and systemd properties. It MUST authenticate `SO_PEERCRED` as the `matrix` owner.
- **FR-032**: Validation of runtime ID, operation ID, message length, operation shape, and metadata MUST occur before lock/path/descriptor/unit derivation. Systemd MUST be invoked without a shell and only for the fixed trusted template.
- **FR-033**: Supervisor operations MUST use kernel-backed `flock` locks under `/run/matrix-terminal-runtime/locks`, acquire the global name-index lock before a per-runtime lock, and carry a fixed-length operation ID for crash-safe idempotency.
- **FR-034**: New and existing customer VPSes MUST remove unrestricted `matrix ALL=(ALL) NOPASSWD:ALL`. Every existing nonterminal privileged flow MUST migrate to a root-owned service or separately typed fixed helper. Generic passwordless `sudo systemctl` MUST NOT remain.

#### Recovery, history, privacy, and deletion

- **FR-035**: Keeper and attach processes MUST use the same dedicated durable Zellij cache rooted under `$MATRIX_HOME/system/terminal-runtime/zellij-cache`; runtime sockets remain ephemeral under `/run`.
- **FR-036**: Recover with valid resurrection state MUST restore the serialized layout, viewport, and bounded scrollback while leaving commands confirmation-gated. It MUST never use `--force-run-commands` and MUST never automatically resume an agent.
- **FR-037**: Missing, corrupt, incompatible, expired, or evicted resurrection state MUST start a fresh shell in the last validated cwd and return a safe `history_unavailable` outcome.
- **FR-038**: The product MUST disclose that gateway scrollback and Zellij resurrection can retain commands, output, paths, and secrets printed in the terminal. Descriptor deletion does not erase either history store.
- **FR-039**: Delete MUST durably commit `deleting`, prevent recovery, stop the complete unit cgroup, notify attached clients, and wait for `cgroup.events` to report `populated 0` before removing receipt, name index, agent state, gateway scrollback, or Zellij resurrection data.
- **FR-040**: Delete MUST be idempotent for an already-absent validated name/runtime and MUST make subsequent recovery impossible.

#### API and UI behavior

- **FR-041**: Add `POST /api/terminal/sessions/:name/recover` under the existing owner authentication. The route MUST validate the name at the boundary, resolve it server-side, apply `bodyLimit`, accept no body or exactly strict `{}`, use the shared create/recover limiter across `/api/terminal` and legacy `/api` mounts, and return idempotent `200 live` or `202 recovering` only from authoritative state.
- **FR-042**: Create, list, rename, delete, recover, health, input/write/tab, and reconciliation surfaces MUST use strict boundary schemas and one generic bounded error mapper. Input/write/tab operations against a non-live runtime MUST return a generic conflict.
- **FR-043**: The shell MUST replace silent recreation with an Interrupted/Recover UI in Canvas first and Desktop compatibility surfaces second. The interaction MUST follow the UX guide: overlay/no layout shift, same-control toggle behavior where relevant, Escape/light dismiss, and an actionable empty/interrupted state.
- **FR-044**: Multi-device attach MUST resolve and attach to an already-live runtime only. Attach MUST never imply Create or Recover.

#### Deployment, compatibility, migration, and documentation

- **FR-045**: Stable host components MUST be `/opt/matrix/bin/matrix-terminal-supervisor`, `/opt/matrix/bin/matrix-terminal-keeper`, `/opt/matrix/bin/matrix-terminal-pane`, and `/opt/matrix/bin/matrix-terminal-runtime-op`, with versioned support files under `/opt/matrix/libexec/terminal-runtime/v1/`.
- **FR-046**: Protocol v1 MUST be frozen to support the current and previous gateway bundle. New gateway fields/operations MUST remain optional when an older compatible supervisor is live; unsupported future receipt schemas require an explicit compatibility epoch and fail closed.
- **FR-047**: The updater MUST install stable bytes and unit definitions before starting a new gateway, run `daemon-reload`, and never restart existing terminal instances or the supervisor during a normal update. Normal update/rollback stop allowlists may contain gateway, shell, and Symphony only; they MUST exclude `matrix-terminal-session@*`, `matrix-terminal.slice`, and `matrix-terminal-runtime.service`.
- **FR-048**: Failed updates, application rollback, explicit rollback, and unit-file `daemon-reload` MUST leave active terminal cgroups untouched. Maintenance that cannot preserve compatibility MUST use a separately announced reboot/maintenance operation.
- **FR-049**: First-release migration MUST create new runtime IDs and recoverable receipts from validated legacy names/cwd in `shell-sessions.json` and workspace records, disclose one final interruption, never claim PID adoption, and never rerun a previous command or agent. Legacy serialization is imported only if Gate S2 proves safe exact-name conversion. Metadata from already-external development sessions MAY be reconciled, but their live PIDs MUST never be adopted.
- **FR-050**: Spec 107 MUST be amended so gateway shutdown no longer claims Zellij servers survive “as today.” Implementation planning and release docs MUST include terminal privacy, one-time migration interruption, post-migration deployment guarantees, and the separate public-site documentation PR.

### Non-Functional Requirements

- **NFR-001**: A live runtime's keeper, Zellij server, shell, and agent PIDs/cgroup MUST remain unchanged through two consecutive normal bundles, gateway crash/restart, shell restart, browser/device detach, forced update failure, and application rollback.
- **NFR-002**: Readiness MUST be reached within 30 seconds or fail safely with the unit cgroup stopped and one reconciled outcome.
- **NFR-003**: Create/Recover retries and concurrent requests MUST create at most one runtime unit for one immutable runtime ID.
- **NFR-004**: Supervisor messages and descriptors MUST be bounded before allocation; filesystem records MUST be bounded before parsing.
- **NFR-005**: Recovery history MUST be bounded to 10,000 lines per pane, 64 MiB target per inactive set, 128 inactive recoverable sets, seven days inactive retention, and a 1 GiB aggregate target. Live receipts are never pruned.
- **NFR-006**: Journals and client responses MUST contain no terminal contents, names, commands, providers, credentials, prompts, paths, raw upstream errors, or raw validation issue arrays.
- **NFR-007**: All runtime collections, descriptor queues, locks, subscribers, timers, temp files, quarantine records, and recovery sets MUST have explicit caps, eviction/cleanup behavior, and shutdown drains.

### Key Entities

- **Terminal runtime**: Immutable owner-scoped execution identity, unit/Zellij identities, lifecycle state, readiness evidence, and current operation generation.
- **Display name index**: Globally locked mapping of validated current names and bounded aliases to immutable runtime IDs.
- **Receipt**: Owner-controlled durable identity and recovery-intent record; never liveness evidence.
- **Launch descriptor**: Root-owned, bounded, short-lived, one-shot launch material consumed only by the exact runtime cgroup.
- **Recovery set**: Runtime-specific Zellij serialization plus owner gateway scrollback, with independent privacy disclosure and retention accounting.
- **Operation**: Fixed-length idempotency identity for Create/Recover/Rename/Delete/Reconcile under ordered kernel locks.
- **Authoritative runtime evidence**: Unit state, cgroup occupancy, keeper readiness, exact responsive Zellij session, and required process membership.

## Security Architecture

### Authentication and authorization matrix

| Surface | Principal | Authentication | Authorization and limits |
|---|---|---|---|
| `GET/POST /api/terminal/sessions` and existing name-scoped routes | VPS owner | Existing gateway owner auth installed before terminal routes | Owner's runtimes only; strict params/bodies; mutating routes use `bodyLimit`; Create uses shared limiter |
| `POST /api/terminal/sessions/:name/recover` | VPS owner | Existing gateway owner auth | Validated name resolved server-side; no body or strict `{}`; shared Create/Recover limiter; idempotent state response |
| Terminal WebSocket attach/input/tab surfaces | VPS owner | Existing exact/pattern browser query-token path plus owner auth | Attach live runtime only; bounded schema per frame; non-live mutations conflict |
| Supervisor Unix socket | Local `matrix` owner process | Kernel `SO_PEERCRED` | Protocol v1's seven typed operations only; fixed template; bounded messages |
| Keeper descriptor claim | Exact terminal-unit keeper PID | Peer credentials plus exact cgroup verification | Claim only matching runtime/operation descriptor, once |
| Any other local principal or unauthenticated remote caller | None | Rejected | No operation or route-shape disclosure; generic response |

### Input validation and filesystem safety

- Validate URL path/query/body fields and every WebSocket frame at the route boundary with bounded strict schemas.
- Validate runtime IDs before locks, paths, unit names, descriptors, or systemd calls. Derive unit names in trusted code; never accept them.
- Validate display names with the existing session-name contract and enforce uniqueness inside the global index lock.
- Resolve cwd through owner-home realpath containment at create and recover time; persist owner-relative paths only.
- Use pinned parent descriptors, `lstat`, no-follow opens, bounded reads, exclusive publication, fsync, atomic rename/link semantics, restrictive modes, and recurring symlink-safe cleanup.
- Security tests MUST include traversal, whitespace, control characters, metacharacters, leading flags, oversized IDs, alternate templates, unrelated services, symlink replacement, hard-link replacement, descriptor replacement, and no-follow attacks before any privileged executor call.

### Error, credential, and logging policy

- External callers receive only allowlisted lifecycle/result codes and generic messages. Raw systemd, Zellij, filesystem, provider, path, validation, or database errors remain server-side and are never copied into client state.
- Client stores must allowlist/cap server messages before display.
- Secrets are never sent through URLs, command arguments, unit metadata, descriptor logs, environment files, receipts, or journals.
- Logs use bounded generic lifecycle codes and truncated runtime-ID hashes. Per-runtime debug detail requiring names/paths is owner-controlled and opt-in outside journals.
- Health/reachability surfaces return coarse compatibility/readiness booleans only.

### Privilege baseline

The privileged boundary is not accepted until unrestricted sudo is removed from both new and existing VPSes. The supervisor may invoke only the fixed template through non-shell systemd APIs/commands after validation. Other root needs must use their own typed service/helper contracts; terminal work cannot introduce a generic privilege proxy.

## Integration Wiring

### Stable host components

| Component | Owner/lifetime | Responsibility |
|---|---|---|
| `matrix-terminal-runtime.service` | root; boot-stable; not restarted by normal bundles | Own supervisor socket, protocol, locks, receipts, descriptors, reconciliation, resource accounting |
| `matrix-terminal-session@.service` | one instance per runtime; `matrix` process identity | Fixed unit/cgroup shape and foreground keeper lifecycle |
| `matrix-terminal-keeper` | stable helper; runtime `MainPID` | Claim descriptor, allocate PTY, launch/monitor Zellij, verify readiness, notify systemd |
| `matrix-terminal-pane` | stable helper | Apply cwd and deliver one-shot nonsensitive/sensitive launch channels without dynamic Matrix argv |
| `matrix-terminal-runtime-op` | fixed typed helper | Constrained install/maintenance operations where the supervisor protocol is not appropriate |
| Gateway runtime client | application bundle | Translate owner API operations to protocol v1; attach browser PTYs only; never own production terminal liveness |

Native bindings needed by stable helpers reside under `/opt/matrix/libexec/terminal-runtime/v1/`, never application directories that are replaced during bundle deployment.

### Startup and shutdown sequence

1. Host boot starts the stable supervisor and creates/verifies owner-only runtime directories/socket; it does not enumerate or start template instances.
2. Gateway startup resolves and validates a compatible supervisor client before registering production terminal dependencies. Registration fails closed if unavailable/incompatible.
3. Gateway requests Reconcile and treats returned authoritative state as the source of truth for API/UI decoration.
4. Create/Recover acceptance survives gateway loss; gateway restart observes the operation rather than canceling or duplicating it.
5. Gateway shutdown drains WebSocket subscribers and attach PTYs only. It does not stop supervisor, template units, runtime cgroups, or Zellij servers.
6. Supervisor shutdown removes socket/timers and handles in-flight metadata safely but does not occur during normal application deployments.

### Cross-package communication and configuration

- Gateway routes and shell registries receive a typed runtime client through dependency injection at registration time; no `globalThis` or call-time optional dependency lookup.
- Existing `/api/terminal` and legacy `/api` mounts share the same limiter instance and runtime client.
- Shell/Canvas/Desktop and coding-agent summaries consume additive lifecycle fields; presentation metadata never feeds back as liveness.
- Fixed resource values and paths ship in root-owned unit/supervisor configuration. No provider credentials or dynamic owner launch content enters unit environment files.
- Public docs live in the separate site repository; this repository records the required content and verification dependency in rollout tasks.

## Concurrency and Atomicity

- Acquire the global name-index lock before a runtime lock everywhere; never invert the order.
- Receipt operation generations and fixed operation IDs make accepted operations idempotent across gateway crashes and retries.
- Unique display-name creation is server-side idempotent under the global lock; a lost Create response resolves the existing name/runtime.
- Recover/Recover starts one unit and returns the same recovering/live operation.
- Recover/Delete and Rename/Recover follow the edge-case outcomes above without runtime identity changes.
- Durable `deleting` intent has highest precedence. The reaper and reconciliation cannot recover or prune a deleting runtime until cgroup emptiness is proven.
- No recovery data is deleted in a partial stop. Acceptable orphan state is a `deleting` record plus stopped/partially stopped unit, retried under the same operation generation.
- Network/provider calls are never inside supervisor locks. The supervisor performs only local bounded filesystem/cgroup/systemd operations.

## Failure Modes

| Failure | Required behavior |
|---|---|
| Supervisor absent/incompatible in production | Generic 503; no direct spawn fallback |
| Gateway crashes after operation acceptance | Supervisor continues; restarted gateway inspects same operation/runtime |
| Keeper/server dies unexpectedly | Unit cgroup is killed; exactly one interrupted/failed state; stale agent-running state cleared from authoritative loss |
| Start exceeds 30 seconds | Stop cgroup, clean descriptor, mark failed/recoverable once |
| Receipt missing/corrupt while cgroup populated | Preserve process; inspect/quarantine/reconstruct safe metadata; never kill from metadata absence |
| Unsupported receipt version | Read-only quarantine; `failed/unsupported_state`; do not start/stop based on it |
| Descriptor missing/invalid/expired | Fail start safely, remove descriptor, generic result; sweep only when no matching operation/unit/lock |
| Cwd unavailable/unsafe | Use owner home and bounded `cwd_unavailable` reason |
| Zellij history missing/corrupt/incompatible | Fresh shell fallback and `history_unavailable`; no command/agent rerun |
| Recovery history over inactive limits | Prune oldest non-live recovery sets only; never prune live receipts |
| Live serialization exceeds budget | Use only spike-proven safe disable; otherwise feature remains blocked on quota design |
| Delete stop is partial | Retain all durable/history state, remain `deleting`, retry until cgroup empty |
| Updater fails or rolls back | Never stop terminal units/slice/supervisor; runtime PIDs remain unchanged |
| Host reboot | Start supervisor only; reconcile prior-live receipts interrupted; require explicit Recover |
| Client disconnect/send failure | Isolate/evict attach client without changing runtime cgroup; notify remaining clients best-effort |
| Host-wide OOM | Reconcile authoritative loss; document residual risk because v1 has no hard `MemoryMax` |

No external network fetch is required in the supervisor lifecycle path. Any future external call added to this path requires a bounded timeout and separate trust-boundary review.

## Resource Management

### Runtime controls

`matrix-terminal.slice` defaults:

- accounting enabled for memory, tasks, CPU, and IO;
- aggregate `MemoryHigh=75%`, `TasksMax=2048`, `CPUWeight=80`, and `IOWeight=80`;
- per-session soft `MemoryHigh=50%` and `TasksMax=512`;
- no initial per-session `MemoryMax`;
- complete cgroup termination on delete.

Percent limits MUST be proven accepted and enforced on the target systemd version during Gate S1; otherwise equivalent explicitly calculated host values require a spec amendment.

### Persistence controls

| Resource | Limit | Cleanup/pressure behavior |
|---|---:|---|
| Descriptor | 128 KiB | Unlink immediately on claim; immediate failure cleanup; 10-minute recurring sweep |
| Pending descriptors | 128 | Reject before allocation/publication |
| Serialized scrollback | 10,000 lines/pane | Periodic serialization; owner-visible privacy disclosure |
| Inactive recoverable sets | 128 | Oldest non-live first after seven days/pressure |
| Inactive recovery target | 64 MiB/runtime | Oldest non-live pruning only |
| Aggregate recovery target | 1 GiB | Never prune live receipt; apply S2-proven live serialization control or block |
| Existing gateway scrollback | Existing 5 MiB/session default | Included in aggregate accounting; delete only after empty cgroup on explicit Delete |
| Receipts/quarantine/temp files | Strict bounded schema/size and capped count | Recurring symlink-safe accounting and cleanup; timers cleared on shutdown |

Realtime subscriber registries MUST retain caps, stale-connection eviction, per-subscriber send isolation, dead-sender removal, and explicit shutdown drains.

## Rollout and Verification Phases

1. **Phase 0 — mandatory spikes**: execute Gates S1 and S2 on a disposable VPS, capture exact commands/config, versions, PIDs/cgroups, cache mapping, disk usage, readiness, termination, corruption, and command-gating evidence. Revise this spec if either fails.
2. **Phase 1 — privilege and stable host foundation**: remove generic sudo through typed replacements; add stable supervisor/helpers, slice/template, protocol/receipt/descriptor contract tests, installer/updater compatibility, and production fail-closed wiring. TDD begins with negative protocol/filesystem tests.
3. **Phase 2 — normal and agent runtime migration**: route new shell and coding-agent creates through immutable runtimes; remove sensitive launch argv/layouts; add authoritative list/inspect/reconcile and explicit Delete.
4. **Phase 3 — recovery and UI**: add recovery API, bounded Zellij state, interrupted/recoverable presentation, Canvas-first Recover flow, name/runtime layout migration, and privacy disclosure. Capture mandatory screenshots/recording and run React Doctor for React changes.
5. **Phase 4 — updater and legacy migration**: enforce stop allowlists, atomic stable installs, rollback compatibility, one-time interruption disclosure, validated legacy receipts, and no-adoption semantics.
6. **Phase 5 — production-representative acceptance**: execute every disposable-VPS scenario below across two bundles plus rollback, then update spec 107 and public/private lifecycle docs to match verified behavior.

Each implementation phase MUST follow Red → Green → Refactor, pass focused tests, `bun run typecheck`, `bun run check:patterns`, `bun run test`, and applicable integration/security tests. Any React phase MUST also pass React Doctor and include current visual evidence.

## Disposable-VPS Acceptance Matrix

- Run a continuous-output command and interactive coding agent; record gateway, attach, keeper, server, shell, and agent PIDs/cgroups.
- Restart/crash gateway, restart shell, refresh/restart browser, and disconnect all devices: only gateway/attach PIDs may change.
- Attach two devices and rename live: one runtime ID/unit/Zellij/server/shell/agent remains.
- Apply two bundles, unit-file `daemon-reload`, forced update failure, explicit rollback, and newer-to-previous gateway rollback: runtime PIDs/cgroups remain unchanged and attach works.
- Crash gateway during launch, race concurrent Recover, race Recover/Delete, and inject invalid IDs/units: no duplicate unit/descriptor and no unrelated systemd call.
- Enforce aggregate task, descriptor, receipt, serialization, journal, and disk limits.
- Stop a runtime unexpectedly: UI becomes interrupted/recoverable and stale agent-running state clears.
- Reboot: no terminal/command/agent starts; UI becomes interrupted; explicit Recover restores valid bounded state with commands gated.
- Corrupt/remove recovery state: Recover starts a safe fresh shell with a generic history message.
- Delete: clients are notified, complete cgroup stops, state/history is removed only after `populated 0`, and recovery remains impossible.
- Verify existing reaper never stops/deletes live or activating units.
- Verify spec 107 and public documentation match the measured behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of production-representative acceptance runs, a live terminal's keeper, Zellij server, shell, and agent PIDs remain unchanged through two consecutive normal deployments, gateway crash/restart, shell restart, browser restart, update failure, and rollback.
- **SC-002**: In 100 concurrent Recover requests for one inactive runtime, exactly one runtime unit is started and all successful responses identify the same immutable runtime.
- **SC-003**: A production terminal is never reported live before all readiness evidence passes; failed starts terminate within 30 seconds and leave zero pending descriptor leaks.
- **SC-004**: After every explicit Delete acceptance run, the unit cgroup reaches `populated 0` before 100% of runtime receipt, name index, agent state, gateway scrollback, and resurrection state is removed; later Recover attempts cannot recreate it.
- **SC-005**: After reboot, zero prior terminal units, commands, or agents start automatically; 100% of prior-live valid receipts appear interrupted until explicit owner recovery.
- **SC-006**: Valid recovery restores layout, visible viewport, and no more than 10,000 scrollback lines per pane; unsafe/missing recovery state falls back to a fresh shell in 100% of corruption cases without automatic command/agent execution.
- **SC-007**: Security contract tests reject 100% of traversal, metacharacter, flag, oversized-ID, alternate-template, unrelated-unit, symlink, hard-link, and descriptor-replacement cases before systemd execution.
- **SC-008**: Automated argv/unit/journal scans find zero user prompts, dynamic command text, credentials, cwd values, sandbox paths, provider configuration, or filesystem paths in Matrix-managed launch metadata.
- **SC-009**: Inactive recovery storage remains within 128 sets, seven-day retention, 64 MiB/runtime target, and 1 GiB aggregate target without pruning a live receipt.
- **SC-010**: Existing normal terminal, coding-agent terminal, multi-device, and local-development contracts remain green; production without a compatible supervisor fails closed with a generic 503.

## Assumptions

- “No process arguments” means no user-derived or sensitive Matrix launch data in managed argv. Fixed nonsensitive provider flags and ordinary argv of explicitly executed programs remain possible.
- The 128-count persistence cap applies only to inactive recoverable state. Live receipts are never pruned.
- Recovery retention is seven days and `Restart=no` is selected for v1.
- The owner is the single authenticated customer-VPS principal; no new organization/shared-terminal authorization model is introduced here.
- The newer stable supervisor remains installed when the replaceable application bundle rolls back, and protocol v1 supports the current and previous gateway bundle.
- Public documentation is maintained in the separate private site repository because this checkout has no `www/content/docs` tree.

## Deferred Scope

- Automatic current-boot restart or reboot resurrection.
- Automatic coding-agent resume.
- PID/cgroup adoption or reparenting of legacy runtimes.
- Hard per-session memory enforcement and its OOM tradeoffs.
- General-purpose privileged command execution.
- Cross-user or organization-shared terminal runtimes.
- Hiding ordinary Linux argv for commands explicitly executed by the owner.
