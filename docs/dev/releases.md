# Release Process

Matrix OS production releases are VPS-native host bundles. R2 stores immutable tarball bytes, and platform Postgres is the source of truth for release metadata and channel pointers. Customer VPSes update by downloading a registered bundle and atomically replacing `/opt/matrix/app`; user data stays in `/home/matrix/home` and local Postgres.

For installable CLI releases, use [CLI Release Process](cli-release.md). CLI versions publish `@finnaai/matrix` and use `cli-v<version>` tags; they are intentionally separate from host-bundle versions.

## Engineer Summary

- `main` is the source of truth. A push to `main` runs `.github/workflows/host-bundle-release.yml`.
- The workflow builds `dist/host-bundle/matrix-host-bundle.tar.gz`, uploads it to R2, registers it in platform Postgres through `POST /system-bundles/releases`, and promotes the `dev` channel.
- R2 JSON manifests are not authoritative. The platform DB release row and channel row are authoritative; R2 only holds the tarball and `.sha256` bytes.
- Existing VPSes are updated by platform deploy fan-out: `POST /vps/deploy {"version":"<version>"}` or `{"channel":"dev"}`.
- A customer VPS sync agent fetches DB-backed release metadata, verifies SHA-256, extracts to staging, moves the old app to `/opt/matrix/app.rollback`, moves the new app into `/opt/matrix/app`, writes `/opt/matrix/release.json`, and restarts Matrix services.
- Host-bundle updates must never overwrite owner data. Do not delete or replace `/home/matrix/home`, `/opt/matrix/env`, or the local Postgres data directory during deploys or rollbacks.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` and CI/release paths use `pnpm install --frozen-lockfile`; do not bypass either during releases.
- Host bundle release validation is blocking. If typecheck, tests, public build-env validation, build, publish, or registration fails, do not publish or deploy the bundle.
- Eligible main/tag releases request a golden snapshot build after publication. This request is an optional acceleration path: enqueue/build failure does not block publication or the unchanged existing-fleet deploy job. See [Golden VPS Snapshots](golden-vps-snapshots.md).
- CLI releases are manual through `.github/workflows/release.yml`; bump `packages/sync-client/package.json`, run the sync-client checks, and dispatch the workflow with the same semver.
- Fleet upgrade operations, blocked-machine handling, and the durable control-plane setup are documented in [Fleet Upgrade Operations](fleet-upgrade-operations.md).
- Staging platform containers and disposable feature VPSes are temporary test
  surfaces. Tear them down before promoting a feature to `stable`; see
  [Staging Platform and Feature VPS Runbook](staging-platform-vps.md).

## Version Scheme

```
v{YYYY.MM.DD}-{github_run_number}
```

Main builds use date-based versions such as `v2026.05.12-43`. Tags still work for human-named milestones and publish the tagged host bundle.

Release metadata also records:

- Git commit and ref
- channel
- build date
- bundle R2 key
- bundle SHA-256
- bundle size
- severity and changelog when supplied

## Host Bundle Release Flow

1. Merge to `main`.

   GitHub Actions builds a host bundle and publishes it to the `dev` channel. The tarball and checksum are uploaded to immutable R2 keys:

   ```text
   system-bundles/<version>/matrix-host-bundle.tar.gz
   system-bundles/<version>/matrix-host-bundle.tar.gz.sha256
   ```

   The workflow then registers the release in platform DB via `POST /system-bundles/releases`.

2. Watch the workflow.

   ```bash
   gh run list --workflow "Host Bundle Release" --limit 5
   gh run watch <run-id> --exit-status
   ```

   Required GitHub secrets/vars:

   | Name | Kind | Used by |
   |------|------|---------|
   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | secret | shell build |
   | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` or `NEXT_PUBLIC_POSTHOG_KEY` | secret/var | shell build |
   | `NEXT_PUBLIC_POSTHOG_HOST` | var | shell build; EU uses `https://eu.i.posthog.com` |
   | `NEXT_PUBLIC_POSTHOG_API_HOST` | var | shell build; EU uses `https://eu.i.posthog.com` |
   | `R2_ACCOUNT_ID` | secret | publish |
   | `R2_ACCESS_KEY_ID` | secret | publish |
   | `R2_SECRET_ACCESS_KEY` | secret | publish |
   | `R2_BUCKET` | var | publish; defaults to `matrixos-sync` |
   | `PLATFORM_PUBLIC_URL` | var | publish/deploy; defaults to `https://app.matrix-os.com` |
   | `PLATFORM_SECRET` | secret | release registration and deploy fan-out |

3. Deploy to existing VPSes.

   Normal `main` pushes publish `dev` but do not automatically fan out to the fleet. Trigger deploy after the workflow is green:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/vps/deploy \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"version":"v2026.05.12-43"}'
   ```

   Security releases can use the workflow `severity=security` path, which auto-deploys the built version after publish.

4. Verify every VPS.

   ```bash
   ssh root@<vps-ip> 'cat /opt/matrix/app/BUNDLE_VERSION; cat /opt/matrix/release.json'
   ssh root@<vps-ip> 'systemctl is-active matrix-gateway matrix-shell matrix-sync-agent'
   ssh root@<vps-ip> 'curl -fsS http://127.0.0.1:4000/health'
   ```

   Also check browser behavior against `https://app.matrix-os.com` and confirm the shell shows the expected Host Bundle and Git Commit.

5. Tag a release:

   ```bash
   git tag -a v0.X.0 -m "Brief description of what's in this release"
   git push origin v0.X.0
   ```

   Tag pushes publish the tagged host bundle and promote the `canary` channel by default.

6. Promote a tested release:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/system-bundles/channels/stable \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"version":"v0.X.0"}'
   ```

   If this version should be the default for newly provisioned customer VPSes,
   make sure the provisioner reads the `stable` channel or set the configured
   customer image/version default to the same version. Do not leave new-user
   provisioning pointed at a feature preview or staging channel.

7. Existing VPSes update or downgrade by channel/version:

   ```bash
   matrix-update stable
   matrix-update canary
   matrix-update v0.X.0
   ```

   Users can do the same from Matrix Settings -> System -> Updates: select `stable`, `canary`, `beta`, or `dev`, inspect the releases published for that channel, then install the latest release or any listed version for an upgrade or downgrade. The VPS sync agent asks the platform for DB-backed release metadata and downloads the bundle through a short-lived signed R2 URL.

8. Grafana scrapes `/metrics`.

   `matrix_vps_info{handle,machine_id,version,status}` exposes the platform DB view of every VPS and its recorded Matrix OS version.

## User Data Invariant

Release code may replace these paths:

```text
/opt/matrix/app
/opt/matrix/release.json
```

Release code must preserve these paths:

```text
/home/matrix/home
/opt/matrix/env
local Postgres data directory
```

The bundled `home/` directory is a template, not an overwrite source. Startup sync can add/update app templates and shipped assets, but protected owner files such as `system/desktop.json`, `system/theme.json`, `system/wallpapers/`, `system/icons/`, configs, state, layouts, conversations, logs, memory, and user profile/session files must be skipped on existing homes.

If a user reports reset settings after an update, first inspect:

```bash
journalctl -u matrix-gateway -n 200 --no-pager
grep 'protected user data' /home/matrix/home/system/logs/template-sync.log | tail -50
cat /opt/matrix/release.json
```

## Bundle Size Hygiene

Host bundles should contain runtime files, not build caches. The build script must exclude:

- `shell/.next/cache`
- shell E2E screenshots/tests
- nested bundled-app `node_modules`
- generated dependency caches that are not needed by `matrix-gateway`, `matrix-shell`, `matrix-code`, or runtime agent CLIs

Quick size audit:

```bash
du -sh dist/host-bundle/matrix-host-bundle.tar.gz dist/host-bundle/stage
du -sh dist/host-bundle/stage/app/* dist/host-bundle/stage/runtime/*
du -sh dist/host-bundle/stage/app/shell/.next/* dist/host-bundle/stage/app/home/apps/*
```

Expected large components today are the runtime Node distribution, code-server, and globally bundled coding CLIs. Unexpected large components are build caches, package manager stores copied into app templates, screenshots, test fixtures, or per-app `node_modules`.

## Checking Tags

```bash
# List all tags
git tag -l

# Show details of a specific tag
git show v0.1.0

# See commits since last tag
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

## Public site (Vercel)

The public site deploys independently from the private `FinnaAI/matrix-os-site`
repository. Site releases and rollbacks must be performed from that repository.

Or configure Vercel to deploy on tag push via GitHub webhook.

## Rollback / Downgrade

```bash
matrix-update v0.X.0
```

Channel rollback can be platform-driven by promoting `stable` back to a known-good version, or user-driven from Matrix Settings by selecting a previous release in the current channel list.

## Tag Naming Examples

| Tag       | Description |
|-----------|-------------|
| `v0.1.0`  | Core OS: kernel, shell, gateway, first-boot |
| `v0.2.0`  | Channels + cron + heartbeat |
| `v0.3.0`  | Multi-tenant platform + Clerk auth |
| `v0.4.0`  | Onboarding + Mission Control |
| `v1.0.0`  | Public launch-ready |
