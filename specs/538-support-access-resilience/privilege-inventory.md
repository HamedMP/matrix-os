# Customer VPS privilege dependency inventory

This inventory is based on the host bundle source as of 2026-09-28. It is an
implementation gate, not a claim that owner privileges have already changed.
Production is VPS-native; Docker runs the local PostgreSQL container only.

| Caller | Current privilege path | Required action | Migration gate |
| --- | --- | --- | --- |
| `matrix-restore.service` (`matrix`) | Docker group and rootful socket | Start/create the `matrix-postgres` container and restore the owner database | Run restore as a root-owned unit with a fixed container specification. Verify initial install, reboot, restore, and backup on a disposable VPS. |
| `matrix-sync-agent.service` (`matrix`) | Passwordless sudo across release, rollback, systemd, host binaries, and configuration | Install and roll back an authenticated host bundle | Move installation into a root-owned service, with a root-owned staging directory and parent paths. Refetch and authenticate owner-writable update requests; never trust a marker's URL, hash, extracted files, or shell input. |
| `matrix-update` and gateway system update | `sudo systemctl restart matrix-sync-agent.service` on repair; writable trigger markers | Request apply, repair, and rollback | Typed, bounded requests to the root updater; retain owner-visible progress. Test exact version and channel semantics. |
| `matrix-agent-runtime-control` | Reexecutes itself via sudo | Control allowlisted runtime services | Replace with a fixed root helper or root-owned unit whose arguments are validated. Prove arbitrary unit names and commands are rejected. |
| Gateway Symphony actions through `matrix-symphony-control` | Calls sudo for `matrix-symphony.service` start and stop | Control the retired or still-installed Symphony service | Move the exact service action to a fixed root-owned helper or unit. Test status, start, stop, absence, and failed service transitions from the gateway before owner sudo removal. |
| `matrix-code`, tool-pack and Linux-tool installers | Sudo to install packages and launch helper units | Install selected developer tools and code server | Root-owned installer with fixed tool IDs and package provenance. Confirm first boot and retry do not block core readiness. |
| Gateway, shell, Terminal, agents, and owner processes | Inherit `docker` supplementary group and blanket sudo | User applications and interactive jobs | Revoke both paths only after the above migrations pass. Change the live Docker socket owner/group, restart affected services, and replace user sessions without killing durable Terminal jobs. |
| Cloud-init and `scripts/install-server.sh` | Grant `matrix` Docker and blanket sudo | Initial host setup | Stop granting those privileges on new images only after the native migration passes. Existing guests need a separate two-gate cutover. |

The path `/opt/matrix` is currently group-writable by `matrix`, so root ownership
on `/opt/matrix/bin` alone does not protect those binaries: the parent can be
renamed. The existing `/opt/matrix/staging` is owner-writable. Both must be
made non-writable by `matrix` before any updater code, extracted release, or
systemd unit sourced from them runs as root. Retain explicit owner-writable
children for app state and trigger requests, and validate every request again
at the root boundary.

The current updater intentionally stops `matrix-gateway`, `matrix-shell`, and
`matrix-terminal-runtime` during bundle replacement. A brief client reconnect
is therefore expected. Acceptance requires a disposable-VPS test proving that
owner home, PostgreSQL data, Terminal jobs, agent jobs, and process state that
is promised durable survive the cutover; any unpreserved process class must
be identified and repaired before cohort rollout.

In particular, gateway shutdown currently invokes the coding-agent turn
lifecycle's `shutdown()`, which aborts active turns. The migration must drain
or defer an upgrade while a non-detachable turn is active, and verify actual
turn completion after reconnect. A healthy new gateway alone is not evidence
that the old run survived. Terminal Zellij keepers use separate user units,
but their process IDs and tab contents still need an end-to-end preservation
check during the service stop and restart.

Removing `matrix` from `/etc/group` does not revoke Docker from already running
processes. The cutover must verify the live socket ACL and fresh process group
sets, then deny `sudo -n true`, raw Docker socket access, edits to operator SSH
files, and replacement of root-run helpers from an owner session. The operator
must retain a separately verified SSH login and provider rescue path throughout.
