# S1 · Run self-host Matrix as the installing person's account

Spike for [2701](./spec.md) layer 4 (ENG-519). Question: can self-host run
the Matrix services as the person's own Unix account (so the gateway reaches
their herdr-core socket, whose only protection is "same uid"), without forking
the managed customer VPS layout?

**Decision: (a), parametrise the run user**, using the existing
`MATRIX_RUNTIME_USER` / `MATRIX_RUNTIME_GROUP` convention that the launchers
and `matrix-install-tool-pack` already read. The shipped unit files and host
binaries keep their managed defaults (`matrix`, `/home/matrix/home`); the
self-host installer overrides them with systemd drop-ins and `host.env`.
Managed customer VPS behaviour does not change: every override is either a
self-host-only file or an env value the managed path never sets.

Browser use is the one exception (see below): it keeps a separate `matrix`
service account as a sandboxed sidecar, which (b) would also have needed.

## Assumptions found

Only what the self-host installer installs or runs. Golden-snapshot, sync
agent, Hermes, OpenClaw, messaging and backup helpers are managed-only and
untouched.

| Where | Assumption | Self-host handling |
| --- | --- | --- |
| `scripts/install-server.sh` | creates system user `matrix`, `MATRIX_HOME` must be under `/home/matrix`, `usermod -d`, `loginctl enable-linger matrix`, `runuser -u matrix`, `sudo -iu matrix` in summary, restore unit `User=matrix` | parametrised on the run user; `MATRIX_HOME` must be under the run user's home (default `~/matrix`, or `/home/matrix/home` when the run user is `matrix`) |
| `systemd/matrix-{gateway,shell,code,terminal-runtime}.service` | `User=matrix`, `Group=matrix` | drop-in `/etc/systemd/system/<unit>.d/10-self-host-run-user.conf`: `User=`, `Group=` (run user's primary group), `SupplementaryGroups=matrix docker` |
| `systemd/matrix-{code-server,developer-tools}.service` | run as root, read `MATRIX_RUNTIME_USER` | nothing; `host.env` carries the run user |
| `systemd-user/matrix-zellij@.service` | `ConditionPathExists=/home/matrix/home/...`, `Environment=MATRIX_HOME=/home/matrix/home` | user-unit drop-in in `/etc/systemd/user/matrix-zellij@.service.d/` resets the condition and sets `MATRIX_HOME` |
| `host-bin/matrix-{gateway,shell,code,terminal-runtime}` | `MATRIX_HOME` default `/home/matrix/home` | `host.env` sets `MATRIX_HOME` (already honoured) |
| `host-bin/matrix-owner-env` `matrix_reconcile_owner_home` | migrates `${MATRIX_LEGACY_HOME:-/home/matrix}/{.local,.cache,.config,.hermes}` into `MATRIX_HOME` and replaces them with symlinks | **hazard**: pointed at a real person's home this would move their `~/.config`. New opt-out `MATRIX_SKIP_LEGACY_HOME_MIGRATION=1`, written by the installer for any run user other than `matrix`; default unchanged |
| `host-bin/matrix-gateway` | `chown -R matrix:matrix "$MATRIX_HOME/system/icons" "$MATRIX_HOME/apps"` whenever user `matrix` exists | would abort the gateway (non-root chown to another user under `set -e`). Now chowns to `${MATRIX_RUNTIME_USER:-matrix}`; identical on managed |
| `host-bin/matrix-terminal-user-keeper.mjs`, `terminal-runtime` service | `MATRIX_HOME` default | env from drop-in / `host.env` |
| `/opt/matrix`, `/opt/matrix/env/*`, `/opt/matrix/runtime/node` | `root:matrix`, group-readable/writable | run user joins group `matrix` |
| `host-bin/matrix-browser-runtime.py`, browser payload (`scripts/spikes/browser-vps/runtime-services.json`, `native-windows.mjs`) | `pwd.getpwnam('matrix')`, Chrome profile in `/home/matrix/.local`, six units `User=matrix`, managed identity (`user_…`, UUID machine id), nginx site `sites-available/matrix` | browser keeps the `matrix` **service account** (no login shell for new installs) as a sidecar; the gateway reaches it over loopback ports as today. Python and gateway accept the self-host identity only when `MATRIX_SELF_HOSTED=1`, and the lifecycle edits `sites-available/matrix-self-host` on self-host |
| `browser-lab/setup.ts` | `sudo -n python3 … matrix-browser-runtime.py --status/--retry` | installer writes a narrow sudoers file for exactly those two commands for the run user (no `NOPASSWD:ALL`) |

## Why not (b)

(b) keeps every service as `matrix` and adds a per-user
`matrix-herdr-bridge.service` exposing `herdr-core connect` on a group socket.
That adds a second always-on process and a socket whose access equals a shell
as the person, while every Matrix terminal still runs as `matrix` (different
files, keys and tools than the person's own). (a) needs only drop-ins and two
small default-preserving edits, so the managed layout does not fork.

## Upgrades of existing self-host installs

An existing `/opt/matrix/env/host.env` without `MATRIX_RUNTIME_USER` is a
legacy install run by `matrix`; re-running the installer keeps it. Passing a
different `--user` on such a machine fails with a message instead of moving
owner data (AGENTS.md user-data invariant).

## Live checks still needed

- Fresh Ubuntu 24.04: gateway, shell, code and terminal runtime come up as
  the run user; Zellij user units start under that user's manager.
- `matrix-browser-runtime.py` completes on self-host (Chrome as `matrix`,
  viewer through nginx).
- `/opt/matrix/release.json` ownership after `tar -x` as root satisfies the
  browser lifecycle's root-owned check.
