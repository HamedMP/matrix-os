# User-systemd terminal runtime alternative

Status: accepted production architecture. Host bundles built from the activation
layer carry `/opt/matrix/app/TERMINAL_USER_SYSTEMD_ENABLED` with the exact contents
`1\n`; earlier bundles remain dormant. `MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=1`
remains the exact acceptance override and `MATRIX_TERMINAL_USER_SYSTEMD_ENABLED=0`
is the emergency disable override. Legacy migration and reboot recovery are not
required. This document does not replace the accepted terminal persistence
specification.

## Decision being tested

Use one root-installed static user service instance per immutable runtime ID:

```text
matrix-zellij@rt_<32 lowercase hex>.service
```

The authenticated gateway writes one atomic owner descriptor, starts the exact
instance through the existing lingering `matrix` user manager, and attaches
through Zellij's ordinary socket. The gateway owns only browser attachment
PTYs. The unit owns the keeper, Zellij server, shell, and coding-agent process
tree in a distinct cgroup.

The unit is never enabled and has `Restart=no`. A reboot therefore starts the
user manager but not a terminal instance, command, or coding agent. An explicit
Recover action may create a new instance from validated recovery state; patched
Zellij recovery is deliberately not part of this narrower lifetime mechanism.

## Guarantee matrix

| Guarantee | Full root supervisor stack | Static user-systemd alternative | Evidence required before production |
| --- | --- | --- | --- |
| Browser disconnect does not end workload | Yes | Yes; attach PTY remains gateway-owned | Disconnect and reattach both runtime kinds |
| Gateway graceful restart does not end workload | Yes | Yes; unit is outside `matrix-gateway.service` | Unchanged PID and cgroup |
| Gateway crash does not end workload | Yes | Yes | SIGKILL gateway, wait for restart, compare PID/cgroup |
| Two bundle updates preserve workloads | Yes | Intended; updater installs a new immutable generation and never stops user units | Two independently versioned bundles |
| Rollback preserves workloads | Yes | Intended; current generation pointer rolls back while active units keep their exact generation | Roll back after both updates |
| New sessions after rollback use rollback-compatible assets | Yes | Yes if the rollback app marker references a retained generation | Start and attach a post-rollback session |
| Gateway memory ceiling excludes terminals | Yes | Yes; user units are outside the gateway cgroup | Read `/proc/<pid>/cgroup`; pressure gateway |
| Per-session resource controls | Root-owned service/slice | User-manager service/slice; depends on cgroup-v2 controller delegation | Inspect effective `MemoryMax`/`TasksMax` and force a bounded failure |
| Aggregate resource controls | Root terminal slice | User `matrix-terminal.slice`; same delegation dependency | Inspect effective slice properties |
| Immutable runtime identity | Root receipt and name index | Descriptor filename, service instance, and Zellij name all use the runtime ID | Invalid-ID and collision tests |
| Metadata rename changes process identity | No | No; display name is descriptor/UI metadata | Rename without PID or unit change |
| Create idempotency | Operation receipts | Exclusive atomic descriptor plus idempotent fixed-unit start | Repeated identical create and conflicting reuse |
| Crash between descriptor and start | Receipt reconciliation | Valid inactive descriptor remains retryable | Inject start failure, then retry |
| Delete is process-tree complete | Supervisor-serialized cgroup deletion | Exact `systemctl --user stop` with `KillMode=control-group`, then descriptor removal | Verify all descendants and socket disappear |
| Root-authoritative liveness | Yes | No; user manager is live authority and descriptor is owner intent | Accepted product tradeoff or no-go |
| Privileged terminal IPC | Typed root socket with peer credentials | None | Verify gateway invokes only its own user manager |
| Hostile owner cannot bypass terminal caps | Stronger supervisor enforcement | No; owner already has a shell and can create same-UID processes on the dedicated VPS | Accepted threat-model tradeoff or no-go |
| Operation receipts/replay | Yes | No | Accepted product tradeoff or no-go |
| Reboot automatically resumes work | Never | Never; instances are started, not enabled, and never restarted | Reboot with active shell and agent; prove no new PID/output |
| Explicit viewport/scrollback recovery | Patched Zellij flow | Optional; can reuse the verified patched Zellij and explicit UI/API | Separate recovery proof if retained |
| First activation adopts legacy PIDs | Never | Never | Metadata-only interrupted migration proof |
| Stale cleanup | Comprehensive reconciliation/retention | Bounded descriptor/generation sweep | Symlink, corruption, and active-reference tests |

## Durable state and authority

The owner descriptor is stored at:

```text
$MATRIX_HOME/system/terminal-runtimes/<runtime-id>.json
```

It contains only lifecycle metadata and references: runtime ID, scope, derived
Zellij session name, kind, display name, owner-scoped cwd, owner-scoped KDL
layout, optional owner-scoped environment-file path, immutable runtime
generation, and creation timestamp. It contains no command string, command
argv, prompt, secret, provider configuration, or environment value. Workspace
launch environment values live in a separate mode-0600, bounded, strictly typed
JSON file and never enter systemd argv or the descriptor.

The live source of truth is the exact user unit and its cgroup. A valid inactive
descriptor after an unexpected failure or reboot is interrupted/recoverable,
not live. A descriptor created before a failed unit start is an acceptable
orphan and may be retried idempotently.

## Update and rollback model

Each bundle carries a content-addressed directory:

```text
/opt/matrix/terminal-runtime/generations/gen_<sha256>/
  GENERATION
  matrix-terminal-attach.mjs
  matrix-terminal-user-keeper.mjs
  zellij
```

`/opt/matrix/terminal-runtime/current` is an atomic symlink used only when a
new unit starts. Every descriptor pins its exact generation, so an already
running keeper and later explicit recovery do not silently switch Zellij
versions. Updates add and verify a generation before switching `current`.
Generation IDs hash the three ordered content digests, not `sha256sum` output
paths, so verification is stable across build, extraction, and installation
directories. The helper rejects symlinked or non-regular inputs.
Rollback switches `current` to the generation recorded by the restored app.
No update or rollback stops `matrix-zellij@*`, `matrix-terminal.slice`, or
`user@<uid>.service`.

Activation is app-payload-scoped rather than system-unit-scoped. The updater
backs up and restores `/opt/matrix/app` as its rollback boundary, while systemd
unit installation is forward-only. Keeping the exact activation marker inside
the app payload therefore makes rollback to a pre-activation bundle remove the
marker before the old gateway starts. The gateway opens the marker with
`O_NOFOLLOW`, requires a two-byte regular file containing exactly `1\n`, and
fails closed for missing, malformed, or symlinked state. A bundle must be
explicitly deployed to a canary or channel before this activation reaches a VPS.
The activation layer does not adopt a live legacy Zellij process into a user
unit. Initial rollout is therefore limited to fresh/disposable hosts or canaries
whose legacy sessions have been deliberately drained; an automatic customer
fleet rollout is not implied by merging the activation code.

The first bundle that introduces this installer can be applied by an older,
already-running sync-agent process that does not yet know about terminal
generations. Before the dormant flag is activated, the activation/acceptance
path must reload the newly installed sync agent and perform one supported
exact-version reapply. That idempotent reapply installs and verifies the
generation and user units; it is an explicit activation prerequisite, not a
default-on or customer rollout side effect. Later updates use the loaded
installer directly.

Full-bundle transfer is independently bounded from runtime continuity. If the
first transfer fails, the sync agent refreshes the exact-version signed
manifest, requires the immutable version, checksum, and size to match, and
resumes the partial bundle once. Exhausting both attempts fails closed with a
structured updater error; it never weakens the requirement that active runtime
PIDs and cgroups remain unchanged. Exact-head acceptance verifies the restarted
installed updater contains this bounded path, classifies only allowlisted
process and staging states on failure, and gives the separately bounded
checksum, extraction, generation-install, and replacement phases explicit
post-transfer time.

Reference-aware generation garbage collection keeps
the current app generation, rollback app generation, and every generation
referenced by a valid descriptor, skip symlinks, and enforce a bounded retained
count. Descriptor create, rename, and delete operations take the same
cross-process kernel advisory lock that garbage collection holds continuously
from descriptor scan through exact generation deletion. The lock file is
opened with `O_NOFOLLOW`, checked as a regular file, and owned by the descriptor
root owner; a symlink or ownership mismatch fails closed. Corrupt files and
symlinks are ignored rather than followed. Disposable VPS evidence must still
prove the behavior on the target filesystem and cgroup image before activation.

## Disposable-preview acceptance control surface

The production acceptance workflow needs a direct control path before the
dormant runtime flag is enabled. That route exists only when `MATRIX_HANDLE`
and `MATRIX_RUNTIME_SLOT` are the same validated `pr-<number>` disposable
preview identity. It is absent on customer runtimes.

| Route | Availability | Authentication | Input and resource bounds |
| --- | --- | --- | --- |
| `POST /api/internal/terminal-acceptance/run` | Exact disposable PR preview only | HMAC-SHA256 over version, timestamp, 128-bit nonce, and exact body digest using the handle-scoped platform verification key | 16 KiB body; typed command array; bounded timeout/output; dedicated 64-request/minute verification bucket with 30-second lockout; 120-second clock window; 512-entry, five-minute replay cache |

The workflow derives the handle-scoped key locally from the Actions-only
platform secret but never sends either reusable secret. Every request uses a
fresh nonce, and the gateway rejects stale, forged, or replayed requests before
execution. The response body is signed with the same request timestamp and
nonce and verified before the workflow consumes it. This application-layer
request/response authentication is required because disposable VPS origins use
per-host self-signed TLS certificates. Acceptance payloads and responses are
bounded repository assets and lifecycle evidence only; they must contain no
credentials, terminal contents, prompts, provider configuration, environment
values, or user files.

## Scope split

The typed root updater and removal of unrestricted Matrix sudo remain valuable
host-security changes, but terminal persistence does not require a privileged
terminal supervisor. They should be reviewed and landed as an independent
security stack. The user-systemd design must remain compatible with that typed
updater by making generation install, user-unit install, pointer activation,
and user-manager reload fixed updater operations.

Reusable work from the existing stack:

- verified patched Zellij build and digest checks;
- immutable runtime ID and validation rules;
- keeper PTY behavior and readiness tests;
- gateway attachment adapters;
- explicit Interrupted/Recoverable UI and recovery action;
- metadata-only legacy migration semantics;
- exact-head disposable-VPS evidence and rollback assertions;
- typed updater and unrestricted-sudo removal as a separate security concern.

Not required for this alternative:

- always-running root terminal supervisor;
- custom Unix socket framing and peer-credential acceptor;
- privileged systemd executor for terminal lifecycle;
- root-authoritative operation receipts and replay;
- root name index and alias protocol.

## Size estimate

At the heads inspected on 2026-07-31, the nine production stack layers add
18,498 lines and delete 1,583. The typed updater layer is +2,989/-503 and the
sudo-removal layer is +640/-234; those should not be charged to the terminal
lifetime mechanism.

The dormant implementation is about 1,200 production additions, plus roughly
800 focused test lines and this decision record. Production activation,
legacy-session migration, explicit Interrupted UI, patched-Zellij source, and
reproducible-build evidence are excluded; those are separable layers and the
verified Zellij work can be reused unchanged if explicit recovery remains in
scope.

## Go/no-go gate

Go only if an isolated disposable preview proves all of the following at one
exact PR head:

1. One ordinary shell and one real coding-agent runtime use different user-unit
   cgroups outside `matrix-gateway.service`.
2. Their keeper, Zellij, and workload PIDs remain unchanged across browser
   disconnect, gateway restart, gateway SIGKILL/restart, two bundle updates,
   and rollback.
3. Both sessions reattach through the normal Zellij socket after every event.
4. Exact deletion removes the unit cgroup, Zellij socket/session, descendants,
   and descriptor; corrupt and symlink state fails closed.
5. Effective per-unit and aggregate resource limits are present on the target
   cgroup-v2 image and a limit breach affects only the intended runtime.
6. Reboot produces no replacement terminal, command, or coding-agent PID and
   no new workload output. Descriptors remain interrupted only.
7. If explicit patched-Zellij recovery stays in scope, bounded viewport and
   scrollback restore and command confirmation remain intact.

No-go if user-manager controller delegation is unavailable, user-bus access is
unreliable from the gateway service, exact deletion leaves descendants, or the
product requires root-authoritative receipts and hostile-owner enforcement.
