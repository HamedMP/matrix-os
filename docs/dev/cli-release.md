# CLI Release Process

The installable Matrix CLI is the `@finnaai/matrix` package in `packages/sync-client`. It is separate from the VPS host-bundle release path: host bundles update customer VPS runtime code, while CLI releases update what users install through npm, Homebrew, and the macOS MatrixSync installer.

## Current Prepared Release

`0.3.0` is the prepared CLI release for the post-onboarding PR set. It includes the user-facing `matrix run` command, shell-session attachment support, completion updates, and the signup/onboarding-compatible login flow already present in `packages/sync-client`.

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

Dispatch from `main`:

```bash
gh workflow run release.yml --ref main -f version=0.3.0
gh run watch <run-id> --interval 30
```

## macOS `.pkg` Setup

By default, the release workflow skips the macOS package job. To build, sign, notarise, and attach `MatrixSync-<version>.pkg` to future CLI releases, configure the GitHub repository variable:

```text
ENABLE_MACOS_PKG=true
```

Then add the following repository secrets:

| Secret | Purpose |
| ------ | ------- |
| `APPLE_DEV_ID_APP_P12_BASE64` | Base64-encoded `.p12` export containing the Developer ID Application certificate and private key. |
| `APPLE_DEV_ID_INSTALLER_P12_BASE64` | Base64-encoded `.p12` export containing the Developer ID Installer certificate and private key. |
| `APPLE_CERT_PASSWORD` | Password used when exporting the `.p12` files. |
| `KEYCHAIN_PASSWORD` | Temporary CI keychain password; generate a long random value. |
| `APPLE_DEV_ID_APP` | Full signing identity, for example `Developer ID Application: Company Name (TEAMID)`. |
| `APPLE_DEV_ID_INSTALLER` | Full signing identity, for example `Developer ID Installer: Company Name (TEAMID)`. |
| `APPLE_TEAM_ID` | Apple Developer Team ID. |
| `APPLE_ID` | Apple ID email used for notarization. |
| `APPLE_APP_PASSWORD` | App-specific password for `APPLE_ID`, created at appleid.apple.com. |

Create the Apple certificates in the Apple Developer portal:

1. Create or reuse a **Developer ID Application** certificate.
2. Create or reuse a **Developer ID Installer** certificate.
3. Install both in Keychain Access on a trusted Mac.
4. Export each certificate with its private key as a `.p12`.
5. Base64 encode each `.p12`:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
base64 -i DeveloperIDInstaller.p12 | pbcopy
```

The workflow imports both certificates into a temporary keychain, builds `packages/sync-client/macos/MatrixSync.xcodeproj`, stages the npm CLI into `/usr/local/lib/matrix-os/cli`, signs the flat package with `productsign`, notarises it with `xcrun notarytool`, staples the ticket, uploads the artifact, and attaches it to the GitHub release.

Local dry run on a Mac:

```bash
export APPLE_DEV_ID_APP="Developer ID Application: Company Name (TEAMID)"
export APPLE_DEV_ID_INSTALLER="Developer ID Installer: Company Name (TEAMID)"
export APPLE_TEAM_ID="TEAMID"
export VERSION=0.3.1
./scripts/build-macos-pkg.sh

export APPLE_ID="you@example.com"
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
./scripts/notarise-macos.sh "dist/macos/MatrixSync-0.3.1.pkg"
```

Use a new patch version for the first macOS-enabled release, for example `0.3.1`. npm versions are immutable, and the `cli-v0.3.0` workflow already completed without a `.pkg` because `ENABLE_MACOS_PKG` was disabled.

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

For macOS, also verify the GitHub release contains `MatrixSync-<version>.pkg` when the macOS job was enabled:

```bash
gh release view "cli-v0.3.1" --json assets --jq '.assets[].name'
pkgutil --check-signature "dist/macos/MatrixSync-0.3.1.pkg"
spctl --assess -vv --type install "dist/macos/MatrixSync-0.3.1.pkg"
```

## Rollback

npm package versions are immutable. If a bad CLI release is published, ship a patch release such as `0.3.1` and update Homebrew through the release workflow. Only deprecate the bad npm version when the replacement is available:

```bash
npm deprecate @finnaai/matrix@0.3.0 "Use @finnaai/matrix@0.3.1"
```
