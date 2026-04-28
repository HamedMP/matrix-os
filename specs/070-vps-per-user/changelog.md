# VPS-per-User Changelog

This file records production-relevant changes made after the initial Spec 070 merge.
It is intentionally operator-focused: what changed, why it changed, and what was verified.

For the product-wide Matrix OS changelog, see `CHANGELOG.md`.

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
