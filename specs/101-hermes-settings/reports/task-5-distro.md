# Task 5 Report — VPS Dashboard Service (Distro)

**Status:** DONE
**Test result:** 48/48 pass (32 cloud-init + 12 symphony + 4 skills-sync)

## Files Created

### `distro/customer-vps/host-bin/matrix-hermes-dashboard`
Bash wrapper that:
- Sources `/opt/matrix/env/host.env` and `matrix-owner-env` (matching `matrix-symphony` pattern)
- Resolves `HERMES_BIN` from `$MATRIX_RUNTIME_HOME/.local/bin/hermes` (same path as `matrix-install-hermes` uses)
- Calls `matrix_export_owner_env` via `declare -F` guard for graceful degradation on older bundles
- Exits 0 cleanly (no crash-loop) if the hermes binary is absent
- `exec`s `hermes dashboard --host 127.0.0.1 --port 9119`

### `distro/customer-vps/systemd/matrix-hermes-dashboard.service`
Long-running service (not oneshot, unlike `matrix-hermes.service` the installer):
- `User=matrix`, `Group=matrix`, `EnvironmentFile=/opt/matrix/env/host.env`
- `After=matrix-hermes.service network-online.target`, `Wants=network-online.target`
- `ConditionPathExists=/opt/matrix/bin/matrix-hermes-dashboard` — stays down if wrapper absent
- `Restart=on-failure`, `RestartSec=10`

## Files Modified

### `distro/customer-vps/cloud-init.yaml`
Three changes:
1. **`write_files:` section** — inline unit added after `matrix-hermes.service` block (identical to the `distro/customer-vps/systemd/` file). The `distro/customer-vps/systemd/*.service` wildcard copy in the update path (`install -o root -g root -m 0644 /opt/matrix/systemd/*.service /etc/systemd/system/`) picks up the file automatically for VPS updates.
2. **`systemctl enable` line** — `matrix-hermes-dashboard.service` inserted between `matrix-hermes.service` and `matrix-linux-tools.service`.
3. **`optional_bin` loop** — `matrix-hermes-dashboard` prepended to the optional chmod loop (since hermes may not be installed, the wrapper is optional, not required).
4. **`systemctl start --no-block`** — added `matrix-hermes-dashboard.service` start after the hermes installer start line, with ordering assertion in tests.

### `scripts/build-host-bundle.sh`
`matrix-hermes-dashboard` added to the `chmod 0755` list on line 84, between `matrix-install-hermes` and `matrix-install-linux-tools`.

### `tests/platform/customer-vps-cloud-init.test.ts`
- Updated 3 existing `systemctl enable` assertions to include `matrix-hermes-dashboard.service` in the expected string.
- Updated the `optional_bin` loop assertion to include `matrix-hermes-dashboard`.
- Updated the `start --no-block matrix-hermes.service` test to also assert the dashboard start line and its ordering relative to the installer start.
- Added new test `'stages and enables the Hermes dashboard loopback service'` asserting: wrapper sources env files, contains `HERMES_BIN=` and graceful exit, `dashboard --host 127.0.0.1 --port 9119`; unit has correct Description/After/ConditionPathExists/User/EnvironmentFile/Restart; cloud-init inline block present; build script contains the binary path.

## Integration with cloud-init

On first VPS boot:
1. `write_files:` installs the inline unit to `/etc/systemd/system/matrix-hermes-dashboard.service`.
2. `runcmd:` runs `systemctl enable ... matrix-hermes-dashboard.service ...` (included in the enable list).
3. After `matrix-hermes.service` (the oneshot installer) fires, `systemctl start --no-block matrix-hermes-dashboard.service` is called. If hermes is not yet installed, `ConditionPathExists` is satisfied (wrapper exists) but the wrapper itself exits 0 cleanly because the hermes binary is absent. Systemd marks the unit as inactive rather than failed.
4. Once hermes installs (via `matrix-hermes.service`), the gateway can restart `matrix-hermes-dashboard.service`.

On VPS updates (host-bundle upgrades), the `install -o root -g root -m 0644 /opt/matrix/systemd/*.service /etc/systemd/system/` step picks up the new unit file automatically; `systemctl daemon-reload` and `systemctl start matrix-hermes-dashboard.service` are the required manual steps (surfaced to the maintainer per Task 5 deploy note).

## Deviations / Uncertainties

- **`optional_bin` placement**: `matrix-hermes-dashboard` is placed in the `optional_bin` loop (not `required_bin`) because the hermes binary is optionally installed. The loop only does `chmod 0750` if the file exists, so it degrades safely when hermes is absent. This diverges from the spec wording ("stage + `chmod 0755`") only in permission bits (0750 vs 0755); the build-host-bundle.sh `chmod 0755` is the canonical permission setter for the staged file. The cloud-init loop is a post-extraction safety net.
- **No `ExecStartPost` wiring from `matrix-hermes.service`**: the installer oneshot does not `ExecStartPost=-/bin/systemctl start matrix-hermes-dashboard.service`. Adding it would be cleaner but would require modifying the cloud-init inline unit for `matrix-hermes.service`; the `start --no-block` in `runcmd:` is sufficient for first boot, and subsequent activation after hermes installs is a maintainer step.
- **`HERMES_HOME` export in else-branch**: the `else` branch sets `export HERMES_HOME="$HERMES_HOME"` which re-exports the local variable. This is intentional so hermes finds its config directory when `matrix_export_owner_env` is unavailable on older bundles.

## Deploy Note (per plan.md Task 5)

This is a customer-VPS distro change. Required steps after merging:
1. `./scripts/build-host-bundle.sh` — rebuild the host bundle.
2. `./scripts/publish-release.sh <version> --channel dev` — publish.
3. For existing VPSes: `POST /vps/deploy {"channel":"dev"}` then on each VPS: `systemctl daemon-reload && systemctl enable matrix-hermes-dashboard.service && systemctl start --no-block matrix-hermes-dashboard.service`.
4. Restart `matrix-gateway.service` and `matrix-shell.service` so they pick up the new upstream.
