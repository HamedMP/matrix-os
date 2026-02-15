# Release Process

Matrix OS uses git tags to mark deployable releases. Tags follow [SemVer](https://semver.org/) with a `v` prefix.

## Version Scheme

```
v{major}.{minor}.{patch}
```

- **major**: Breaking changes to APIs, file formats, or container interface
- **minor**: New features, new phases completed
- **patch**: Bug fixes, small improvements

Current convention: we're pre-1.0, so minor bumps are features and patch bumps are fixes.

## Creating a Release

1. Ensure all tests pass:
   ```bash
   bun run test
   ```

2. Tag the release:
   ```bash
   git tag -a v0.X.0 -m "Brief description of what's in this release"
   ```

3. Push the tag:
   ```bash
   git push origin v0.X.0
   ```

4. To push all tags at once:
   ```bash
   git push origin --tags
   ```

## Checking Tags

```bash
# List all tags
git tag -l

# Show details of a specific tag
git show v0.1.0

# See commits since last tag
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

## Deploying from a Tag

### Docker Image (single-user or platform containers)

```bash
# Build from a specific tag
git checkout v0.X.0
docker build -t matrix-os:v0.X.0 -f distro/Dockerfile .

# Or tag latest
docker tag matrix-os:v0.X.0 matrix-os:latest
```

### Platform Service (VPS)

```bash
git checkout v0.X.0
cd packages/platform
pnpm install
node --import=tsx src/main.ts
```

### www (Vercel)

Vercel deploys from `main` automatically. To deploy a specific tag:
```bash
git checkout v0.X.0
cd www
vercel --prod
```

Or configure Vercel to deploy on tag push via GitHub webhook.

## Rollback

```bash
# Roll back to a previous tag
git checkout v0.X.0

# Or reset main to a tag (destructive, confirm first)
git reset --hard v0.X.0
```

## Tag Naming Examples

| Tag       | Description |
|-----------|-------------|
| `v0.1.0`  | Core OS: kernel, shell, gateway, first-boot |
| `v0.2.0`  | Channels + cron + heartbeat |
| `v0.3.0`  | Multi-tenant platform + Clerk auth |
| `v0.4.0`  | Onboarding + Mission Control |
| `v1.0.0`  | Public launch-ready |
