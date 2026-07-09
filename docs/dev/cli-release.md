# CLI Release Process

The installable Matrix CLI is the `@finnaai/matrix` package in `packages/sync-client`. It is separate from the VPS host-bundle release path: host bundles update customer VPS runtime code, while CLI releases update what users install through npm, Homebrew, `get.matrix-os.com`, and the macOS MatrixSync installer.

## Current Prepared Release

`0.3.11` is the prepared CLI patch release after `0.3.10`, including the explicit attached-session clipboard image paste command and path-only clipboard fallback fixes.

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
pnpm --filter @finnaai/matrix exec node ./scripts/validate-package-runners.mjs
```

Also verify the version is new:

```bash
npm view @finnaai/matrix version
git tag -l 'cli-v*'
```

## Release

Use the manual GitHub Actions workflow named `CLI Release` with `version=0.3.11` and `update_homebrew=true`. This follows the existing `cli-v0.3.11` workflow/tag release path after the PR merges. The workflow:

1. Validates the requested semver, local package version, npm availability, and `cli-v<version>` tag availability.
2. Installs the workspace and runs the sync-client build, tests, and publish-shape check.
3. Publishes `@finnaai/matrix` to npm with provenance.
4. Creates GitHub release `cli-v<version>`.
5. Builds standalone Linux/macOS CLI binaries and attaches them to the GitHub release.
6. Updates `FinnaAI/homebrew-tap` with the npm tarball URL and SHA-256 when `update_homebrew` is enabled.

## Post-Release Verification

```bash
npm view @finnaai/matrix version
npm view @finnaai/matrix dist.tarball
npx --yes @finnaai/matrix --version
pnpm dlx @finnaai/matrix --version
brew update && brew info finnaai/tap/matrix
MATRIX_VERSION=0.3.11 sh scripts/install.sh
matrix --version
matrix login --help
matrix run --help
matrix forward --help
```

For launch-critical cloud coding, test the command path against a live Matrix VPS:

```bash
matrix login --profile cloud
matrix run -it -- claude
matrix run -- ls
matrix forward 5173
```

For standalone binaries, also verify the GitHub release contains:

- `matrix-0.3.11-linux-x64`
- `matrix-0.3.11-linux-arm64`
- `matrix-0.3.11-darwin-x64`
- `matrix-0.3.11-darwin-arm64`

For macOS app packaging, also verify the GitHub release contains `MatrixSync-0.3.11.pkg` when the macOS job was enabled.

## Rollback

npm package versions are immutable. If a bad CLI release is published, ship a patch release such as `0.3.12` and update Homebrew through the release workflow. Only deprecate the bad npm version when the replacement is available:

```bash
npm deprecate @finnaai/matrix@0.3.11 "Use @finnaai/matrix@0.3.12"
```
