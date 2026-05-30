---
description: Set up or tear down a staging platform container and disposable feature VPS for branch testing.
---

# Staging Platform VPS

Use this command when a feature needs a real staging platform, Stripe test mode,
or a disposable customer VPS. Follow `docs/dev/staging-platform-vps.md` as the
source of truth.

## User Input

```text
$ARGUMENTS
```

Expected input examples:

- `setup pr 273 handle hamed-billing-staging clerk user_...`
- `teardown handle hamed-billing-staging`
- `status handle hamed-billing-staging`

## Rules

- Keep `/home/deploy/matrix-os` on `main`.
- Use a manual worktree under `/home/deploy/matrix-os.worktrees/<slug>` for
  feature code.
- Use `http://127.0.0.1:${STAGING_PLATFORM_PORT:-9100}` for staging operator
  routes.
- Never use runtime slot `primary` for branch testing.
- Never deploy a feature bundle to the whole fleet.
- Delete feature VPSes through `DELETE /vps/<machineId>`, not directly in
  Hetzner.
- Remove temporary Cloudflare routes after testing.

## Setup Flow

1. Read `.specify/memory/constitution.md` and `docs/dev/staging-platform-vps.md`.
2. Confirm the current branch, PR number, and worktree path.
3. Source staging env:

   ```bash
   set -a
   source /home/deploy/matrix-os/.env.staging-platform
   set +a
   PLATFORM_API_URL="http://127.0.0.1:${STAGING_PLATFORM_PORT:-9100}"
   ```

4. Start the staging platform container:

   ```bash
   docker compose \
     --env-file /home/deploy/matrix-os/.env.staging-platform \
     -f /home/deploy/matrix-os/docker-compose.staging.yml \
     up -d --build
   ```

5. Verify health with the local operator API.
6. Build and publish an immutable branch host bundle from the feature worktree.
7. Provision a non-primary feature VPS with `/containers/provision`.
8. Deploy the exact bundle version to only that feature handle with
   `/vps/deploy`.
9. Verify `/vps/fleet`, then direct SSH using `~/.ssh/customer_vps_smoke`.
10. Report the exact URL: `https://app.matrix-os.com/vm/<handle>`.

## Status Flow

1. Source staging env and set `PLATFORM_API_URL`.
2. Query `/vps/fleet` and filter by handle.
3. If a public IP exists, verify:

   ```bash
   ssh -i ~/.ssh/customer_vps_smoke \
     -o IdentitiesOnly=yes \
     -o StrictHostKeyChecking=accept-new \
     root@<publicIPv4> \
     'cat /opt/matrix/app/BUNDLE_VERSION; cat /opt/matrix/release.json; systemctl is-active matrix-gateway matrix-shell matrix-sync-agent; curl -fsS http://127.0.0.1:4000/health; curl -fsS -o /dev/null -w "shell_status=%{http_code}\n" http://127.0.0.1:3000'
   ```

4. Report release version, git commit, service state, and URL.

## Teardown Flow

1. Source staging env and set `PLATFORM_API_URL`.
2. Query `/vps/fleet` for the requested handle and capture `machineId`.
3. Delete the feature VPS:

   ```bash
   curl --fail --silent --show-error \
     -X DELETE "${PLATFORM_API_URL%/}/vps/<machineId>" \
     -H "Authorization: Bearer $PLATFORM_SECRET"
   ```

4. Stop the staging platform:

   ```bash
   docker compose \
     --env-file /home/deploy/matrix-os/.env.staging-platform \
     -f /home/deploy/matrix-os/docker-compose.staging.yml \
     down
   ```

5. Inspect and remove temporary Cloudflare route changes before declaring
   teardown complete.
6. Confirm the feature handle is absent or marked deleted in `/vps/fleet`.

