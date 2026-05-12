# Release Process

Matrix OS production releases are VPS-native host bundles. Git tags mark immutable releases, R2 stores the tarball bytes, and the platform Postgres database is the source of truth for release metadata and channel pointers.

## Version Scheme

```
v{major}.{minor}.{patch}
```

- **major**: Breaking changes to APIs, file formats, or container interface
- **minor**: New features, new phases completed
- **patch**: Bug fixes, small improvements

Current convention: we're pre-1.0, so minor bumps are features and patch bumps are fixes.

## Host Bundle Release Flow

1. Merge to `main`.

   GitHub Actions builds a host bundle and publishes it to the `dev` channel. The tarball and checksum are uploaded to immutable R2 keys:

   ```text
   system-bundles/<version>/matrix-host-bundle.tar.gz
   system-bundles/<version>/matrix-host-bundle.tar.gz.sha256
   ```

   The workflow then registers the release in platform DB via `POST /system-bundles/releases`. R2 JSON manifests are not the source of truth.

2. Tag a release:
   ```bash
   git tag -a v0.X.0 -m "Brief description of what's in this release"
   git push origin v0.X.0
   ```

   Tag pushes publish the tagged host bundle and promote the `canary` channel by default.

3. Promote a tested release:

   ```bash
   curl --fail --silent --show-error \
     -X POST https://app.matrix-os.com/system-bundles/channels/stable \
     -H "Authorization: Bearer $PLATFORM_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"version":"v0.X.0"}'
   ```

4. Existing VPSes update or downgrade by channel/version:

   ```bash
   matrix-update stable
   matrix-update canary
   matrix-update v0.X.0
   ```

   The VPS sync agent asks the platform for DB-backed release metadata and downloads the bundle through a short-lived signed R2 URL.

5. Grafana scrapes `/metrics`.

   `matrix_vps_info{handle,machine_id,version,status}` exposes the platform DB view of every VPS and its recorded Matrix OS version.

## Checking Tags

```bash
# List all tags
git tag -l

# Show details of a specific tag
git show v0.1.0

# See commits since last tag
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

## www (Vercel)

Vercel deploys from `main` automatically. To deploy a specific tag:
```bash
git checkout v0.X.0
cd www
vercel --prod
```

Or configure Vercel to deploy on tag push via GitHub webhook.

## Rollback / Downgrade

```bash
matrix-update v0.X.0
```

Channel rollback is a platform operation: promote `stable` back to a known-good version, then users on `stable` can update/downgrade to that release.

## Tag Naming Examples

| Tag       | Description |
|-----------|-------------|
| `v0.1.0`  | Core OS: kernel, shell, gateway, first-boot |
| `v0.2.0`  | Channels + cron + heartbeat |
| `v0.3.0`  | Multi-tenant platform + Clerk auth |
| `v0.4.0`  | Onboarding + Mission Control |
| `v1.0.0`  | Public launch-ready |
