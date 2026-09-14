# User-systemd terminal activation

Matrix OS runs one static user-systemd service for each project terminal
workspace and one for `main`:

```text
matrix-zellij@<workspace-runtime-id>.service
```

All shell, build, and coding-agent tabs for that workspace share the service's
single Zellij server and project-level cgroup. The root
`matrix-terminal-runtime.service` is a replaceable control plane; the gateway is
a client of its protected Unix socket. Neither process owns the running
workspace process tree.

## Installed runtime source of truth

The host bundle installs:

- `/etc/systemd/user/matrix-zellij@.service`
- `/etc/systemd/user/matrix-terminal.slice`
- `/opt/matrix/terminal-runtime/generations/gen_<sha256>/...`
- `/opt/matrix/terminal-runtime/current`
- `/opt/matrix/app/TERMINAL_RUNTIME_GENERATION`

Before opening its socket, the terminal control service verifies the app marker,
exact generation directory, executable keeper/Zellij/attach assets, `current`
symlink, and both regular static user-unit files. Missing, malformed, symlinked,
or mismatched installation state fails closed with a generic startup error.

`TERMINAL_USER_SYSTEMD_ENABLED` remains in new bundles only as compatibility
state for older rollback-era gateways. The project-workspace gateway does not
use that marker or construct a user-systemd controller.

## Fail-closed activation readiness

Activation never falls back to the legacy gateway-owned terminal runtime. The
terminal control service opens its socket only when the app generation marker,
the matching regular generation directory, executable Zellij/keeper/attach
assets, the `current` symlink, and both static user-unit files all agree.
Missing, malformed, symlink-substituted, or undiscoverable prerequisites fail
startup with a generic error. The updater treats the failed health check as an
activation failure and rolls the candidate app back.

Release metadata is staged before app replacement, but the updater commits `/opt/matrix/release.json` only after health succeeds. Operational verification
must also read the active `/opt/matrix/app/BUNDLE_VERSION`; a release marker by
itself is not evidence that the candidate app is running.

## Installation and update behavior

Fresh provisioning and the self-host installer copy the static user units,
enable linger for the `matrix` account, start its user manager if necessary,
and run `systemctl --user daemon-reload`. The host updater installs and verifies
new immutable assets before switching `current`.

Before replacing any application, host helper, system unit, user unit, attach
helper, or generation pointer, the updater writes a root-owned transaction
backup under `/opt/matrix/staging/update-transaction`. A failed or interrupted
apply restores that complete set, reloads both systemd managers, restores unit
enablement and prior activity, and verifies the previous gateway. Candidate-
modified files are restored through same-directory atomic replacements, and
candidate-added units are stopped and disabled before their definitions are
removed. When rollback crosses the
legacy/project-workspace boundary, the candidate's matching migration code
runs its journaled rollback before the candidate application is removed.

These paths must never stop or restart:

- `matrix-zellij@*`
- `matrix-terminal.slice`
- `user@<matrix-uid>.service`

An ordinary update may restart the gateway and
`matrix-terminal-runtime.service`. That only replaces sockets, WebSockets,
attachments, and observers. Active workspace units, Zellij servers, tabs, and
workload PIDs remain unchanged. Rollback has the same continuity rule.

The gateway orders itself after and *wants* the terminal control plane, but it
does not require it. If terminal startup or its socket later fails, non-terminal
Matrix OS surfaces remain available and terminal operations return a generic
service-unavailable response. Candidate release health remains stricter: the
updater commits a terminal-enabled bundle only after both the exact gateway
version and the terminal socket health check succeed.

Each runtime descriptor pins its immutable generation. Reference-aware garbage
collection retains all generations referenced by valid descriptors in addition
to current and rollback generations, so an active older workspace remains
attachable after later bundles.

## Rollout

1. Build and register an immutable bundle without promoting a channel.
2. Deploy the exact version to a disposable or canary VPS.
3. Verify a real project workspace, its unit, and its tabs across gateway and
   terminal-control restarts, an in-place update, and rollback.
4. Promote channels separately only after the canary evidence is accepted.

### New signups

Provision only from a golden image or clean-image bootstrap that installs the
complete `app`, `terminal-runtime`, and `user-systemd` bundle layout before
starting the gateway. A machine that fails activation readiness is failed, not
silently downgraded. Refresh and verify the golden image before offering the
activation release to new customers.

### Existing users

VPSes whose installed updater predates terminal-runtime bundle sections must
use a two-stage migration:

1. Deploy a dormant bootstrap bundle and verify that its new updater and static
   runtime assets are installed while the project-workspace cutover is not yet
   activated.
2. Deploy the activation bundle through that updater, then verify the exact
   immutable generation, both user units, user-manager discovery, and a real
   `matrix-zellij@<workspace-runtime-id>` project terminal.

A direct old-updater-to-activation jump must fail closed and roll back. A
bounded exact-version reapply may repair a disposable canary after its updater
has advanced, but it is not a substitute for the supported fleet migration.

## Capacity changes

The control service reads:

```text
MATRIX_TERMINAL_MAX_TABS_PER_WORKSPACE  # default 64
MATRIX_TERMINAL_MAX_TABS_TOTAL          # default 256
```

Both are bounded to 1..10,000, and total must be at least the per-workspace
value. They limit concurrent tabs only. Lowering a value blocks later creates
after the active count reaches the limit and never kills an existing tab.
Raising a value can be activated by restarting the control service without
restarting any workspace unit.

## First activation and later rollback

The coordinated project-workspace cutover intentionally interrupts the legacy
one-session-per-terminal processes once. Migration journals and stages new
metadata/reference state, then creates every replacement workspace and tab
before stopping any legacy session. A replacement preparation failure leaves
the legacy processes running. After all replacements are usable, the cutover
stops the legacy processes and atomically commits the staged state; it does not
claim to preserve their process memory across that accepted boundary.

After that cutover, normal bundles must preserve running workspace units. A
rollback within the project-workspace architecture also preserves them. A
rollback across the original legacy boundary can restore old metadata but
cannot recreate processes stopped during the one-time migration. After such a
rollback, redeploy or restart the legacy runtime and explicitly start any
required replacement sessions; terminated process memory cannot be restored.

Reboot recovery is deliberately separate from bundle continuity. Static
workspace instances are started, not enabled, and use `Restart=no`; a VPS reboot
does not silently relaunch commands or coding agents.

## Verification

For a production-representative host, verify:

1. Twenty-three tabs in one project produce one workspace unit and one Zellij
   server.
2. A second project produces a second independent cgroup.
3. Gateway restart, gateway SIGKILL/restart, control-service restart, two exact
   bundle updates, and rollback leave workspace and workload PIDs unchanged.
4. Raising/lowering tab admission limits has no effect on existing PIDs.
5. Idle Codex reclaim closes only the selected tab, not its workspace unit.
6. Explicit project deletion removes exactly its unit, descendants, Zellij
   socket/session, descriptor, and generated layout.
7. Effective per-project and aggregate `MemoryHigh`, `MemoryMax`, and `TasksMax`
   values are present on the target cgroup-v2 host.

Merging the stack does not itself promote a channel or deploy customer VPSes.
Use the normal immutable host-bundle release and exact-version deployment path.
