# VPS-per-User Changelog

This file records production-relevant changes made after the initial Spec 070 merge.
It is intentionally operator-focused: what changed, why it changed, and what was verified.

For the product-wide Matrix OS changelog, see `CHANGELOG.md`.

## 2026-05-05 — Vite Default Apps and Founder VPS Refresh

### Summary

Default home apps are now shipped as Vite builds instead of plain static HTML.
The customer host bundle build runs `scripts/build-default-apps.mjs` before
packaging, and customer gateway startup syncs bundled app source/build outputs
plus default system icons into existing VPS homes. This prevents existing homes
from serving stale app manifests or `needs_build` responses after an in-place
host bundle refresh.

### Host Bundle

Published:

```text
system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz
system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz.sha256
```

Verified checksum:

```text
261547365f256b05704deafa6e545b0fb3897e80a74e33e67574e8ad444b290b  matrix-host-bundle.tar.gz
```

### Live Verification

Refreshed in place and verified:

- `hamedmp` VPS: `178.105.110.52`
- `arian` VPS: `178.105.101.129`

Checks performed on both hosts:

- `matrix-gateway.service`, `matrix-shell.service`, `matrix-code.service`, and
  `matrix-sync-agent.service` are active.
- Gateway `/health` returns `status: ok`.
- Platform-verified shell requests return Next HTML with no
  `clerk.example.com` script reference.
- Existing homes contain built Vite app output for `whiteboard` and nested game
  apps such as `games/2048`.
- Existing homes contain the shipped `workspace`, `files`, `chat`, `whiteboard`,
  and `terminal` SVG icons.

## 2026-05-04 — Agent CLI Self-Update Permissions and Dev VPS

### Summary

Customer VPS host bundles now keep `/opt/matrix/runtime/node/lib/node_modules`
and `/opt/matrix/runtime/node/bin` group-writable with setgid directories. The
`matrix` service user can update bundled global agent CLIs in place with
`npm install -g --prefix /opt/matrix/runtime/node ...` instead of hitting
`EACCES` on rename.

The dedicated hot-reload dev VPS is also live at `dev.matrix-os.com`. It runs
Postgres, MinIO, the gateway, shell, and cloudflared on `matrix-dev`, with shell
and gateway source bind-mounted for HMR/watch reload.

### Host Bundle

Published:

```text
system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz
system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz.sha256
```

Verified checksum:

```text
fff28027768362dcdfe82c8cd4f50903cc2942a8bfd872b74b3968046ba8662c  matrix-host-bundle.tar.gz
```

### Live Verification

- Patched and verified `codex` and `claude` self-update on founder VPSes:
  - `hamedmp`: `178.105.110.52`
  - `arian`: `178.105.101.129`
- Verified both report:
  - `codex-cli 0.118.0`
  - `Claude Code 2.1.91`
- Verified `dev.matrix-os.com` returns a Clerk signed-out redirect and loads
  Clerk from `clerk.matrix-os.com`.
- Verified dev VPS services are healthy:
  - `matrixos-dev-vps`
  - `matrix-os-cloudflared-1`
  - `matrix-os-postgres-1`
  - `matrix-os-minio-1`

## 2026-05-04 — Deterministic Default Icons and Founder VPS Refresh

### Summary

Default app manifests now reference only icons shipped in `home/system/icons/`, so new homes and restored VPS homes no longer depend on Gemini icon generation for first paint. The shell proxy also routes `/icons/*` through the gateway compatibility redirect, and customer host wrapper scripts are executable by the `matrix` service user after root-owned in-place bundle extraction.

### Host Bundle

Published for the current default image version:

```text
system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz
system-bundles/matrix-os-host-dev/matrix-host-bundle.tar.gz.sha256
```

Verified checksum:

```text
e9cf006eeead7557f337d395fd835710ad10fe8fcdaf43a8f18797a3480c5474  matrix-host-bundle.tar.gz
```

### Live Verification

Refreshed in place and verified:

- `hamedmp` VPS: `178.105.110.52`
- `arian` VPS: `178.105.101.129`

Checks performed on both hosts:

- `matrix-gateway.service`, `matrix-shell.service`, and `matrix-code.service` are active.
- Gateway `/health` returns `status: ok`.
- Platform-verified shell requests return Next HTML with no `clerk.example.com` script reference.
- Shell `/icons/2048.png` reaches the gateway `/icons/*` redirect path.
- Gateway `/api/apps` reports only shipped default icons: app-specific shipped icons plus shared `game-center` for default game apps.

## 2026-05-04 — Founder VPS Refresh Lessons

### Summary

The first founder VPS migrations exposed a split between legacy user-container deploys and customer VPS host-bundle deploys. Updating the platform or Docker user image is not enough for VPS-hosted users; their shell/gateway/runtime assets come from the R2 host bundle downloaded at boot or manually refreshed in place.

This follow-up hardened the release path and documented the operator checks:

- `scripts/build-host-bundle.sh` now requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` so a bundle cannot silently bake the Clerk example frontend API.
- Customer VPS gateway startup reads `DATABASE_URL` from host env or assembles it from `/opt/matrix/env/postgres.env`, keeping runtime state in owner-controlled Postgres.
- Cloud-init writes host/Postgres env in a way that does not depend on a pre-existing `matrix` group during `write_files`.
- The gateway serves `/icons/<slug>.png` through system-icon fallbacks and avoids browser-visible Gemini 503 loops when `GEMINI_API_KEY` is intentionally absent.
- The shell no longer auto-posts icon generation on missing icons, no longer calls legacy `/api/canvas`, and only pans the canvas from canvas-surface events instead of bubbled events from selected app windows.

### Host Bundle

Fresh local bundle built during this slice:

```text
7ac0c0ddf5f78980190bfa14e9fd41bd7108e4b48d029844eb4623bffe4f8a5a  matrix-host-bundle.tar.gz
```

Publish target remains:

```text
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz.sha256
```

### Console Error Triage

Use these signatures before changing code:

- `clerk.example.com`: stale or invalid shell bundle; rebuild with real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- `/api/auth/ws-token 404`: stale shell/gateway routing on the served host; deploy the fresh bundle and restart services.
- `/api/canvas 410`: legacy client still served; fresh shell should not call this endpoint.
- `/icons/*.png 404` plus icon POST 503: old auto-generation flow with missing Gemini; fresh flow uses stable fallbacks.
- Cloudflare beacon `ERR_BLOCKED_BY_CLIENT`, SES notices, and MetaMask extension errors are usually browser/extension noise unless paired with a Matrix-owned failure.

### Follow-Ups

- Automate in-place host-bundle upgrades for running customer VPSes.
- Add inventory/drift reporting for container images and VPS host-bundle checksums.
- Add migration automation for legacy containers to customer VPSes with data validation and rollback.
- Add browser-level smoke coverage for the customer VPS shell console.

## 2026-04-28 — Customer Host Provisioning Completion

### Summary

The initial VPS-per-user merge could create a Hetzner server, but the customer host did not have the Matrix host service binaries or the runtime credentials needed to complete provisioning, route traffic, or back up data. The platform row stayed in `provisioning` because the host never reached `POST /vps/register`.

This follow-up completed the customer-host side:

- Published a host bundle containing the customer VPS runtime and service wrappers.
- Made cloud-init download and verify the bundle before starting host services.
- Routed bundle downloads through the platform tunnel so large R2 bundles are accessible from customer hosts.
- Fixed Ubuntu 24.04 bootstrap details for cloud-init, apt, users, groups, and systemd ordering.
- Added platform-authenticated shell access so VPS-hosted shell traffic does not require Clerk secrets on the customer host.
- Added R2 credentials and backup-script fixes so hourly DB backups can write `system/db/latest` and snapshots.
- Bundled coding agent CLIs (`claude`, `codex`, `opencode`, `pi`) into the VPS runtime.

### Commits

| Commit | Change |
| --- | --- |
| `38e4fe1d` | Published the customer VPS host bundle pipeline. |
| `08392959` | Defaulted customer VPS provisioning to `cpx22`. |
| `7ca05c3f` | Reused existing R2 credentials for host bundle publication. |
| `2d915f15` | Served host bundles through the platform tunnel. |
| `91a4b43d` | Allowed large customer VPS bundle downloads. |
| `5601bab9` | Switched provisioning to the production customer VPS cloud-init. |
| `e8c30d36` | Kept generated artifacts out of the Docker context. |
| `d13ad917` | Fixed generated customer VPS cloud-init YAML validity. |
| `55e54273` | Created the `matrix` group before `write_files`. |
| `fcd0b2bd` | Made customer VPS bootstrap compatible with Ubuntu Noble. |
| `820477ed` | Made apt bootstrap fail fast and retry bounded downloads. |
| `c86d8c77` | Completed customer VPS host registration. |
| `1f6c4185` | Trusted platform auth before Clerk middleware on customer VPS shell. |
| `095b7041` | Provisioned customer VPS backup credentials and fixed backup upload path. |
| `d9fea1ea` | Bundled coding agent CLIs for customer VPS hosts. |

### Host Bundle

The host bundle is published at:

```text
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz.sha256
```

For `matrix-os-host-dev`, the latest verified checksum after this work was:

```text
349d1fb56e6ef818acac75cbca4edf52d61ff732bb70dde5f976715a26626947  matrix-host-bundle.tar.gz
```

The bundle now includes:

- `/opt/matrix/bin/matrix-gateway`
- `/opt/matrix/bin/matrix-shell`
- `/opt/matrix/bin/matrix-sync-agent`
- `/opt/matrix/runtime/node`
- Global agent CLIs in `/opt/matrix/runtime/node/bin`
- Application sources and built shell assets under `/opt/matrix/app`

### Live Verification

Verified on the `hamedmp` customer VPS:

- Hetzner server: `matrix-hamedmp`
- Platform status: `running`
- Shell route: platform-authenticated request to `127.0.0.1:3000` returns `HTTP/1.1 200 OK` with Next HTML.
- Active units:
  - `matrix-gateway.service`
  - `matrix-shell.service`
  - `matrix-sync-agent.service`
  - `matrix-db-backup.timer`
- Running container:
  - `matrix-postgres`
- R2 metadata and backup:
  - `system/vps-meta.json` exists.
  - `system/db/latest` exists.
  - `system/db/latest` pointed to `system/db/snapshots/2026-04-28T1509Z.dump` during verification.
  - The referenced DB snapshot exists.
- Agent CLIs available to the `matrix` user:
  - `claude` `2.1.91`
  - `codex` `0.118.0`
  - `opencode` `1.14.25`
  - `pi` `0.70.2`

### Verification Commands

Focused tests and checks that passed during the final slices:

```bash
pnpm exec vitest run tests/platform/customer-vps-cloud-init.test.ts
pnpm exec vitest run tests/platform/customer-vps-cloud-init.test.ts tests/platform/customer-vps.test.ts tests/platform/customer-vps-routes.test.ts tests/platform/proxy-routing.test.ts
bun run typecheck
bun run check:patterns
```

`bun run test` was attempted but did not complete cleanly in the local environment. Failures were broad and unrelated to the VPS changes, including git subprocess `EPERM`, app-runtime child process failures, E2E gateway failures, heartbeat timeouts, and long template build timeouts.

### Remaining Follow-Ups

- Add in-place host bundle upgrade automation for already-running customer VPSes.
- Add automatic new-signup VPS provisioning behind `CUSTOMER_VPS_ENABLED`.
- Add existing-user migration from containers to VPS.
- Add retention pruning for customer DB snapshots.
- Add ARM bundle support if `cax` hosts become a target.
