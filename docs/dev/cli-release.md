# CLI Release Process

The installable Matrix CLI is the `@finnaai/matrix` package in `packages/sync-client`. It is separate from the VPS host-bundle release path: host bundles update customer VPS runtime code, while CLI releases update what users install through npm, Homebrew, `get.matrix-os.com`, and the macOS MatrixSync installer.

## Current Prepared Release

`0.3.1` is the prepared CLI patch release for the post-onboarding PR set. It includes the user-facing `matrix run` command, shell-session attachment support, completion updates, the signup/onboarding-compatible login flow, and the canonical `matrix shell connect` fixes already present in `packages/sync-client`.

## Versioning

- Use semver without a leading `v` in `packages/sync-client/package.json`.
- GitHub release tags use `cli-v<version>`, for example `cli-v0.3.0`.
- Do not reuse Matrix OS host-bundle tags such as `v2026.05.12-43` or `v0.X.0` for the CLI.
- Publish only the `@finnaai/matrix` package. The repo root package is private and must not be published.

## Preflight

Run these from the repo root before dispatching the release workflow:

```bash
pnpm install --frozen-lockfile
pnpm --filter @finnaai/matrix build
pnpm --filter @finnaai/matrix test
pnpm --filter @finnaai/matrix exec node ./scripts/check-publish.mjs
```

Also verify the version is new:

```bash
npm view @finnaai/matrix version
git tag -l 'cli-v*'
```

## Release

Use the manual GitHub Actions workflow named `Release` with `version=0.3.0`. The workflow:

1. Validates the requested semver, local package version, npm availability, and `cli-v<version>` tag availability.
2. Runs root typecheck and tests.
3. Builds and notarises the macOS `.pkg` when `ENABLE_MACOS_PKG=true`.
4. Publishes `@finnaai/matrix` to npm with provenance.
5. Creates GitHub release `cli-v<version>`.
6. Updates `FinnaAI/homebrew-tap` with the npm tarball URL and SHA-256.

## Post-Release Verification

```bash
npm view @finnaai/matrix version
npm view @finnaai/matrix dist.tarball
brew update && brew info finnaai/tap/matrix
MATRIX_VERSION=0.3.0 sh scripts/install.sh
matrix --version
matrix login --help
matrix run --help
```

For macOS, also verify the GitHub release contains `MatrixSync-0.3.0.pkg` when the macOS job was enabled.

## Rollback

npm package versions are immutable. If a bad CLI release is published, ship a patch release such as `0.3.1` and update Homebrew through the release workflow. Only deprecate the bad npm version when the replacement is available:

```bash
npm deprecate @finnaai/matrix@0.3.0 "Use @finnaai/matrix@0.3.1"
```
