# Fleet Upgrade Operations

Production customer runtime is VPS-native. Platform containers are not the
customer rollout path; customer VPSes upgrade by downloading a registered host
bundle and swapping `/opt/matrix/app`.

## Target Setup

Use three independent control paths so a single stale token cannot strand a VPS:

1. **Outbound control agent**: each VPS runs a small systemd service/timer that
   polls platform for signed commands over HTTPS. Upgrade commands carry either
   `{ "channel": "stable" }` or `{ "version": "vYYYY.MM.DD-N" }`; the agent runs
   `/opt/matrix/bin/matrix-update <target>` locally and posts status back.
2. **Inbound fast path**: platform may still call `/api/internal/upgrade` for
   immediate fan-out, but this is an optimization only. It must not be the only
   way to reach old machines.
3. **Break-glass SSH**: every provisioned VPS must install a platform operator
   SSH key for the `matrix` user with a forced command wrapper that only allows
   safe operations such as `matrix-update`, service status, and journal tails.

The current inbound path uses `UPGRADE_TOKEN=HMAC_SHA256(PLATFORM_SECRET,
handle)`. That is fail-closed, but old VPSes can drift if they were provisioned
with a previous secret or token format. The outbound agent fixes this by letting
the VPS initiate trust refreshes and receive token-rotation commands.

## Standard Release Flow

1. Merge to `main` and wait for the `Host Bundle Release` workflow.
2. Confirm the published version and changelog:

   ```bash
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     https://app.matrix-os.com/system-bundles/releases/<version>.json
   ```

3. Promote the tested version:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/system-bundles/channels/stable \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"version":"<version>"}'
   ```

4. Deploy by channel:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/vps/deploy \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"channel":"stable"}'
   ```

5. Verify with `/vps/releases` and Grafana:

   ```bash
   curl --fail --silent --show-error \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     https://app.matrix-os.com/vps/releases
   ```

Grafana dashboards to check:

- **Release Channels**: channel pointers, reported runtime version distribution,
  and reachable VPSes not on `stable`.
- **VPS Fleet Overview**: provisioned machine inventory, control reachability,
  runtime release reports, load, memory, disk, and probe latency.

## Handling Blocked Machines

A blocked machine is one that is `running` in platform DB but rejects both
release probes and upgrade triggers with `401`, or times out entirely.

1. Try the inbound deploy once:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/vps/deploy \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"channel":"stable","handle":"<handle>"}'
   ```

2. If the VPS accepts unauthenticated user update routes, trigger the host-local
   updater through the gateway:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://<vps-ip>/api/system/update \
     -H "Content-Type: application/json" \
     -d '{"channel":"stable"}'
   ```

3. If both fail, use break-glass SSH:

   ```bash
   ssh matrix@<vps-ip> 'sudo -n /opt/matrix/bin/matrix-update stable'
   ssh matrix@<vps-ip> 'cat /opt/matrix/release.json'
   ssh matrix@<vps-ip> 'systemctl is-active matrix-gateway matrix-shell matrix-sync-agent'
   ```

4. If SSH is unavailable, treat the VPS as unmanaged drift. Repair requires
   Hetzner console/rescue access or reprovision/recover through backup restore.
   Do not SSH-copy a bundle as the normal fix.

## Public Release Surface

The platform release DB is the source of truth. Public release pages should read
from:

- `GET https://app.matrix-os.com/system-bundles/releases?channel=stable`
- `GET https://app.matrix-os.com/system-bundles/releases/<version>.json`

The website should show:

- release version, channel, date, git commit, bundle checksum
- changelog/features
- upgrade command: `matrix-update stable`
- shell path: Settings -> System -> Updates
- operator path for fleet upgrades

Do not expose signed R2 URLs on public pages; those are short-lived operational
links returned for authenticated/download paths.
