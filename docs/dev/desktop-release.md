# Desktop Release Runbook

Matrix OS Desktop ships outside the customer VPS host-bundle flow. The app is
signed, notarized, packaged, and updated through desktop GitHub release
artifacts. The VPS host-bundle release still controls gateway and web shell
runtime code.

## Sources

This pipeline borrows the useful parts of two working desktop release systems:

- Superset: reusable desktop build workflow, mac arm64/x64 artifact split, app
  update resource verification, canary prerelease, and merged mac update
  manifests.
- SlayZone: release manifest with SHA-256 sums, explicit channel metadata, and
  dry-run release bundles before publish.

## Required Secrets

The macOS jobs expect an Apple Developer ID Application certificate readable by
electron-builder:

- `MATRIX_DESKTOP_MAC_CERTIFICATE` or `CSC_LINK`
- `MATRIX_DESKTOP_MAC_CERTIFICATE_PASSWORD` or `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD` or `APPLE_APP_PASSWORD`
- `APPLE_TEAM_ID`

`MATRIX_DESKTOP_MAC_CERTIFICATE` may be a base64-encoded `.p12` payload or a
secure URL supported by electron-builder. Do not publish a public release from a
run where signing or notarization was skipped.

## Channels

- Stable: tag `desktop-vX.Y.Z` or run `Desktop Release` with `channel=stable`
  and `mode=publish`. Stable releases are eligible for GitHub's latest release.
- Beta: run `Desktop Release` with `channel=beta`. The GitHub release is marked
  prerelease and app builds allow prerelease updates.
- Canary: `Desktop Canary Release` runs every 12 hours and can be triggered
  manually. It moves the `desktop-canary` prerelease and appends a
  `-canary.YYYYMMDDHHMMSS` version suffix in CI.

## Dry Run

Use dry-run mode for release pipeline changes:

```bash
gh workflow run desktop-release.yml \
  -f version=0.1.0 \
  -f channel=stable \
  -f mode=dry-run
```

The run uploads a combined `desktop-release-*` artifact with installers,
update manifests, `desktop-release-manifest.json`, and `SHA256SUMS.txt`.

## Publish

1. Confirm the desktop PR stack is merged and Greptile was 5/5 on every PR.
2. Ensure `desktop/package.json` has the intended stable version.
3. Create and push a tag:

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The release workflow builds macOS arm64/x64 DMG+ZIP artifacts, Linux x64
AppImage artifacts, merges `latest-mac.yml`, generates checksums, and creates
the GitHub release with generated changelog notes.

## Updates

Packaged desktop builds default to GitHub releases as the update feed. The app
checks on launch and then hourly. Downloads happen in the background and install
only after the user quits and reopens the app.

Environment overrides:

- `MATRIX_DESKTOP_UPDATE_CHANNEL=stable|beta|canary`
- `OPERATOR_UPDATE_FEED=https://...` for a generic-provider break-glass feed
- `MATRIX_DESKTOP_RELEASE_OWNER` / `MATRIX_DESKTOP_RELEASE_REPO` for forks

Never force-restart the app for an update; attached terminal/session work must
survive until the user intentionally relaunches.

## Verification

For every published run:

```bash
gh release view desktop-v0.1.0 --json tagName,isPrerelease,latestRelease,assets
gh release download desktop-v0.1.0 --pattern SHA256SUMS.txt --pattern desktop-release-manifest.json
```

Install the DMG on a clean macOS user, confirm Gatekeeper opens it without an
unidentified-developer warning, sign in, then leave it running long enough to
observe the update check in logs. For a canary smoke, install the canary DMG and
confirm `MATRIX_DESKTOP_UPDATE_CHANNEL=canary` allows prerelease updates.
