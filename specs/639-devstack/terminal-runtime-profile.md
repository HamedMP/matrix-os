# Isolated native Terminal for a DevStack instance

Implements the Terminal deployment boundary in [ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack) and the [DevStack specification](https://github.com/HamedMP/matrix-os/pull/3023). It is independent of the registered Platform routing change and the full native scope-runtime stack.

## Deployment contract

Keep the existing Terminal protocol, descriptor/generation store, Zellij and user-systemd controller. Each instance uses a dedicated locked non-login auxiliary Linux UID and a separate user manager. That manager is launched by a bounded system PID1 service, as the auxiliary UID, with delegated `cpu memory pids`, an actual private network/mount/IPC boundary, and no capabilities. Do not rely on namespace directives in a normal unprivileged user manager: the Linux/x64 spike showed they can be ignored. The bounded delegated-manager spike verified isolated namespaces, effective private templates, denied installed paths, cgroup limits and cleanup without touching installed services.

Opt in with `MATRIX_TERMINAL_RUNTIME_NAMESPACE=<lowercase slug, max 32 characters>`. Unset preserves all installed defaults. Reject partial/mismatched paths before migration, restore or launch. The selected process must be the dedicated non-root `mds-` account, with its own primary group, no other groups and its passwd HOME matching the instance HOME. A Gateway using this Terminal socket runs as the same numeric UID, with only the dedicated socket leaf mounted. No mode widening, installed socket, user-manager bus or host Docker/D-Bus mount is allowed in Gateway.

| Boundary | Owned location |
| --- | --- |
| Data and immutable inputs | `/var/lib/matrix-devstack/<ns>/{home,app,runtime/node,terminal-runtime}`; HOME is owned by the auxiliary UID; source/Node/generation/unit definitions are protected operator artifacts |
| Native control manager | `matrix-devstack-<ns>-terminal-user-manager.service`; XDG runtime `/run/matrix-devstack-terminal/<ns>`; dedicated user bus in that root |
| Unit search | `<instance>/terminal-runtime/user-units:/usr/lib/systemd/user`; exclude installed `/etc/systemd/user` and owner-writable search directories |
| Capacity | `/sys/fs/cgroup/system.slice/<manager-unit>/matrix.slice/matrix-terminal.slice`; reuse existing capacity admission with this exact root |
| Terminal transport | `/run/matrix-devstack-terminal/<ns>/terminal/terminal-runtime.sock`, existing 0700 parent / 0600 socket, separate from the manager bus |
| Zellij state | Own HOME, XDG config/data/cache, and `/run/matrix-devstack-terminal/<ns>/zellij` socket root; keep the actual manager bus address separate |

Generate a small configuration artifact (no automatic install/launch): private `default.target` wanting only the vendor `dbus.socket`, existing `matrix-zellij@.service` and `matrix-terminal.slice` names within the private manager, and the manager/daemon environment and placement inputs. Keeper template binds the own HOME, content-addressed runtime root and own Node executable. Run the daemon and keeper inside the same delegated manager. Bind the instance’s Zellij socket directory at `/mnt` inside that manager only, so the Zellij protocol suffix fits Linux’s Unix socket path limit. Use bounded per-unit and aggregate resources; operator masks installed/peer roots and uses a finite qualification lease. Do not load the installed host wrapper or host.env. Existing start/stop, descriptor locking, readiness and recovery semantics stay in force. Reuse the source generation GC helper with the owned descriptor root; do not invoke installed GC or global user-manager controls.

The daemon must pass the owned unit root to generation admission and verify the effective loaded template and slice (`FragmentPath`, no foreign drop-ins) against its private files before initialization. Use the private manager cgroup root for capacity. Preserve generation pinning and invocation fencing: a descriptor pinned to an earlier profile-aware generation starts its immutable keeper with the current owned Node. Use only generations built for this profile; installed or pre-profile generation compatibility is outside this qualification. The keeper's fallback PATH remains owned and does not inherit Main credentials or XDG/Zellij paths. Keep production generation handoff/defaults intact.

| Boundary | Authority |
| --- | --- |
| Existing authenticated Gateway Terminal API/WS | Existing owner/auth checks, unchanged request protocol |
| Dedicated Terminal socket | Same isolated OS UID only; no group permission expansion |
| User-unit management and profile rendering | Owned operator/auxiliary manager; fixed paths, no user-requested unit/host names |

No new endpoints, database schema, auth bypass or external calls. A missing owned manager/generation/definition fails closed; it never selects an installed or peer runtime. Only the isolated UID's owned state is eligible for Zellij discovery, restore or cleanup. No new VPS, changes to installed services or automatic account provisioning in product code.

## Implementation and acceptance

1. Write failing tests for the canonical profile, foreign/partial paths, wrong UID/group/Node, sanitized environment, effective unit files and legacy defaults. Keep the deployment/definition helpers separate from large controller/adapter files. Wire `service.ts` to the shared profile, existing generation-loader option, GC helper and capacity factory. Add a config renderer/CLI that emits private unit definitions and environment, without writing them into system paths.
2. Test the actual old-generation keeper handoff and preservation of its Node/PATH, and the existing owner-only socket, readiness, generation, workspace and controller suites. Retain the test logs showing red before implementation and green after it.
3. In an owned Linux/x64 Stage 2 instance, stage the exact content-addressed Zellij/keeper/attach assets and generated private definitions. Verify kernel namespaces, loaded definition paths and resource caps. Prove a normal authenticated Gateway → Terminal API/socket session, real command output, reconnect/reattach and cross-UID denial. Verify installed service/definition snapshots, stop only owned units and retain data/UID mapping. A PTY smoke or manager spike does not prove a real Terminal session.
4. Open a draft PR with exact source and acceptance boundaries. Update the separate public site docs PR. Qualifying three real Git worktrees with hot update, Web/Clerk and funded AI remains a separate full DevStack gate; do not claim it from this isolated instance.
