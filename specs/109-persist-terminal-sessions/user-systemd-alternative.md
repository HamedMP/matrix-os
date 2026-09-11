# User-systemd project-workspace terminal runtime

Status: adopted production architecture for the project-scoped terminal stack.
This replaces the earlier proposal for one user-systemd unit per terminal or
coding-agent session.

## Topology

Each persisted terminal workspace has exactly one root-installed static user
service instance:

```text
matrix-zellij@rt_<32 lowercase hex>.service
```

The runtime ID is deterministically derived from the workspace's opaque
`matrix-w-<32 lowercase hex>` logical Zellij name. A project has one workspace;
`main` is the only unscoped workspace. Every shell, build, and coding-agent
session inside that workspace is one Zellij tab, not another service.

The user unit owns the keeper, Zellij server, all tabs, and every descendant in
one project-level cgroup. `matrix-terminal-runtime.service` is only the control
plane: it owns the protected Unix socket, observers, shared attachments,
checkpoints, migration, and reconciliation. The gateway talks only to that
socket and never creates or stops user units directly.

## Source of truth and identity

Owner-controlled workspace/tab metadata is canonical under `$MATRIX_HOME`.
The process-lifecycle descriptor is stored at:

```text
$MATRIX_HOME/system/terminal-runtimes/<workspace-runtime-id>.json
```

It contains bounded lifecycle references only: immutable runtime ID, workspace
scope, derived physical Zellij session name, logical workspace name, validated
owner cwd/layout paths, pinned generation, and creation time. It contains no
prompt, secret, command, provider configuration, or environment value.

The live unit and its cgroup are authoritative for process liveness. Stable
Matrix `TerminalRef` values remain authoritative for public identity and are
reconciled to current structured Zellij tab/pane IDs after reconnect.

## Continuity guarantees

| Event | Workspace process result | Control/UI result |
| --- | --- | --- |
| Browser or CLI disconnect | Unchanged | Attachment closes; later attach restores snapshot/replay |
| Gateway restart or crash | Unchanged | WebSockets reconnect through the control socket |
| `matrix-terminal-runtime` restart | Unchanged | Observers/attachments are recreated and stable refs reconcile |
| Ordinary bundle update | Unchanged | New app/control generation starts; existing unit stays pinned |
| Bundle rollback | Unchanged | Restored app/control generation starts; referenced unit generation is retained |
| Explicit tab termination | Only the selected tab stops | Sibling tabs and project unit stay alive |
| Confirmed project deletion | Exact project unit and descendants stop | Workspace metadata is removed |
| VPS reboot | Not automatically resumed | Descriptor remains recoverable metadata |
| Initial legacy cutover | Existing legacy processes stop once | Names, cwd, refs, preferences, and scrollback migrate |

The one-time legacy interruption is accepted. After activation, normal gateway
and bundle changes must not stop `matrix-zellij@*`, `matrix-terminal.slice`, or
`user@<uid>.service`. The installer and updater may install static unit files and
run `systemctl --user daemon-reload`; they must not stop or restart live
workspace instances.

Before crossing that interruption boundary, the migration must create and
verify all replacement workspaces and tabs. Failure while preparing a
replacement leaves every legacy session running. Only a confirmed
missing-session error is idempotent during the stop phase; permission, socket,
and command failures abort the cutover.

## Immutable updates and rollback

Each host bundle carries a content-addressed generation:

```text
/opt/matrix/terminal-runtime/generations/gen_<sha256>/
  GENERATION
  matrix-terminal-attach.mjs
  matrix-terminal-user-keeper.mjs
  zellij
```

`/opt/matrix/terminal-runtime/current` selects assets only for a newly created
workspace unit. Every descriptor pins the generation that created it. Updates
install and verify the new generation before switching `current`; rollback
switches it back to the generation referenced by the restored app. Reference-
aware garbage collection retains the current generation, rollback generation,
and every generation named by a valid descriptor.

Host update rollback is one recoverable transaction over the application,
host helpers, system and user unit definitions, unit enablement, attach helper,
generation pointer, and migration journal. Rollback across the legacy boundary
runs the candidate migration rollback before deleting the candidate code.
Interrupted updates resume compensation from a durable, root-owned transaction
marker. Restores use atomic file replacement, stop candidate-touched units, and
reinstate the previous unit enablement and activity state. Candidate health
requires both the exact gateway version and a working
terminal-control socket, while the gateway itself only wants the terminal unit
so unrelated product surfaces remain available during terminal degradation.

Generation IDs hash the three ordered content digests for Zellij, the keeper,
and the attach helper, rather than hashing path-bearing command output. This
makes verification stable across build, extraction, and installation paths.
For an existing VPS whose running updater predates terminal-runtime payloads,
activation requires a dormant bootstrap followed by one supported
exact-version reapply using the newly installed updater. A direct jump to activation is intentionally rejected and rolled back; it never falls back to the legacy terminal owner.

The stack currently pins Zellij 0.44.3. A future Zellij protocol upgrade must
prove that the new control client can manage servers pinned to older live
generations, or use an explicit maintenance migration. It must never silently
replace the binary beneath a running service.

## Capacity and OOM behavior

The default admission policy is:

```text
MATRIX_TERMINAL_MAX_TABS_PER_WORKSPACE=64
MATRIX_TERMINAL_MAX_TABS_TOTAL=256
```

Both values accept 1..10,000 and the total must be at least the per-workspace
limit. Only concurrent tabs count; exited and failed historical tabs do not.
The 23-tab test is a regression scenario, not a product ceiling.

Changing either limit affects only later tab creation. Lowering a limit never
terminates existing tabs. Raising it requires only reloading or restarting the
control plane, which does not restart workspace units, so the ceiling can be
increased later without workload interruption.

One server per project removes the roughly per-server overhead of the former
one-Zellij-server-per-tab design. Each project unit has `TasksMax=1024`,
`MemoryHigh=60%`, and `MemoryMax=75%`; the aggregate `matrix-terminal.slice`
has `TasksMax=4096`, `MemoryHigh=75%`, and `MemoryMax=90%`. A project that
exhausts its unit limit cannot directly kill sibling project units. The
aggregate slice prevents terminal workloads from consuming the entire user
manager budget.

The bounded Chat idle reaper may reclaim a proven-idle Codex process after the
runner confirms a safe resume boundary. It terminates only that session's exact
tab. It never stops the shared project service or sibling shells, builds, or
agents.

## Failure and cleanup policy

- Descriptor creation is exclusive and idempotent; conflicting identity fails
  closed.
- Workspace mutations serialize admission, creation, termination, deletion,
  and observer replacement.
- A valid inactive descriptor after an unexpected failure is recoverable, not
  proof of a running process.
- Orphan cleanup is owned by the terminal control plane, is bounded, ignores
  corrupt/symlink state, and drains on shutdown.
- Exact workspace deletion uses `systemctl --user stop` with
  `KillMode=control-group`, then removes only validated generated artifacts.
- The service and socket return generic bounded errors; raw paths, Zellij
  errors, and provider details are logged server-side only.

## Required acceptance evidence

1. Twenty-three tabs in one project create exactly one Zellij server and one
   `matrix-zellij@<workspace-runtime-id>.service`.
2. Two projects create two independently bounded unit cgroups.
3. Workspace and workload PIDs remain unchanged across browser disconnect,
   gateway restart/SIGKILL, terminal-control restart, two bundle updates, and
   rollback.
4. Raising tab limits admits new tabs without changing existing workspace or
   workload PIDs; lowering limits leaves existing tabs alive.
5. Idle reclaim stops only the proven-idle tab and preserves sibling tabs.
6. Exact project deletion removes its unit, Zellij session/socket, descendants,
   descriptor, and generated layout without touching another project.
7. Reboot does not automatically restart commands or agents.
