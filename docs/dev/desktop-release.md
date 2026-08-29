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

## Required signing configuration

### macOS

The macOS jobs expect an Apple Developer ID Application certificate readable by
electron-builder:

- `MATRIX_DESKTOP_MAC_CERTIFICATE` or `CSC_LINK`
- `MATRIX_DESKTOP_MAC_CERTIFICATE_PASSWORD` or `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD` or `APPLE_APP_PASSWORD`
- `APPLE_TEAM_ID`

`MATRIX_DESKTOP_MAC_CERTIFICATE` may be a base64-encoded `.p12` payload or a
secure URL supported by electron-builder. macOS release jobs fail before the
build if any certificate, certificate-password, or notarization secret is
missing; unsigned artifacts must never reach a release.

### Windows (recommended: Azure Artifact Signing)

Windows releases are x64 NSIS installers. The release workflow runs on a
Windows GitHub runner, signs through Azure Artifact Signing (formerly Trusted
Signing), and fails closed if signing is missing or invalid. It verifies the
Authenticode signature on both `Matrix OS.exe` and the NSIS installer before an
artifact can be uploaded. This is app packaging; Electron's [Windows build
instructions](https://www.electronjs.org/docs/latest/development/build-instructions-windows)
are for compiling Electron itself and are not required.

Provision the signer once:

1. In the Azure portal, create an **Artifact Signing** account in the chosen
   region. Complete organization identity validation, then create a
   **Public Trust** certificate profile. Record the account name, profile name,
   regional endpoint, and the certificate profile's complete subject DN. North
   Europe uses `https://neu.codesigning.azure.net`; use the endpoint shown by
   the account rather than guessing.
2. Create a Microsoft Entra application and service principal dedicated to
   Matrix OS Desktop releases. Do not create a client secret.
3. Add a federated credential to that application with:
   - issuer: `https://token.actions.githubusercontent.com`
   - subject: `repo:HamedMP/matrix-os:environment:desktop-release`
   - audience: `api://AzureADTokenExchange`
4. At the certificate-profile resource scope, assign the service principal the
   least-privilege **Artifact Signing Certificate Profile Signer** role. The
   scope has this form:

   ```text
   /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>
   ```

5. In GitHub, create an environment named `desktop-release`. Restrict its
   deployment branches/tags to reviewed release refs. The Windows job uses this
   environment so every OIDC token has one stable, narrow subject.
6. Add these repository Actions secrets:
   - `MATRIX_DESKTOP_WINDOWS_AZURE_CLIENT_ID`: Entra application (client) ID
   - `MATRIX_DESKTOP_WINDOWS_AZURE_TENANT_ID`: Entra directory (tenant) ID
   - `MATRIX_DESKTOP_WINDOWS_AZURE_SUBSCRIPTION_ID`: Azure subscription ID
7. Add these repository Actions variables:
   - `MATRIX_DESKTOP_WINDOWS_SIGNING_MODE=azure`
   - `MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME=<complete certificate subject DN>`
   - `MATRIX_DESKTOP_WINDOWS_SIGNING_ENDPOINT=<regional HTTPS endpoint>`
   - `MATRIX_DESKTOP_WINDOWS_SIGNING_ACCOUNT=<Artifact Signing account>`
   - `MATRIX_DESKTOP_WINDOWS_CERTIFICATE_PROFILE=<certificate profile>`

The publisher value must match the issued certificate subject exactly,
including the `CN=`, organization, locality/state when present, and country.
The updater embeds this subject and rejects an update whose signer does not
match it. The workflow authenticates with `azure/login` and short-lived GitHub
OIDC credentials; no Azure client secret or signing private key is stored in
GitHub.

Useful one-time Entra/RBAC commands after creating the Artifact Signing account
and certificate profile in the portal:

```bash
APP_CLIENT_ID="$(az ad app create --display-name matrix-os-desktop-release --query appId -o tsv)"
APP_OBJECT_ID="$(az ad app show --id "$APP_CLIENT_ID" --query id -o tsv)"
SP_OBJECT_ID="$(az ad sp create --id "$APP_CLIENT_ID" --query id -o tsv)"

# Create credential.json with the issuer, subject, and audience listed above.
az ad app federated-credential create --id "$APP_OBJECT_ID" --parameters credential.json

az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Artifact Signing Certificate Profile Signer" \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>"
```

### Windows certificate-file fallback

If Azure Artifact Signing is unavailable, an exportable OV `.pfx` can be used.
Set `MATRIX_DESKTOP_WINDOWS_SIGNING_MODE=certificate`, retain the exact
`MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME`, and add:

- `MATRIX_DESKTOP_WINDOWS_CERTIFICATE`: base64-encoded `.pfx` (or a secure URL
  accepted by electron-builder)
- `MATRIX_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD`: the `.pfx` password

The fallback maps those secrets to electron-builder's `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` only inside the Windows job. Never commit a certificate,
password, Azure token, or generated signing metadata. Prefer Artifact Signing:
it avoids an exportable private key and gives the workflow short-lived access.

## Channels

- Stable: tag `desktop-vX.Y.Z` or run `Desktop Release` with `channel=stable`
  and `mode=publish`. The immutable version release holds the signed artifacts;
  `desktop-stable` points to `latest-mac.yml`, `latest-linux.yml`, and the
  Windows `latest.yml` manifest.
- Beta: run `Desktop Release` with `channel=beta`. The immutable GitHub release
  is marked prerelease and `desktop-beta` points to its channel manifests.
- Canary: `Desktop Canary Release` runs every 12 hours and can be triggered
  manually. It publishes an immutable `desktop-vX.Y.Z-canary.YYYYMMDDHHMMSS`
  prerelease, then advances the `desktop-canary` pointer.
- Dev: run `Desktop Release` with `channel=dev`. It follows the same immutable
  release plus `desktop-dev` pointer model for explicitly selected test builds.

The repository-wide GitHub **Latest** release is not part of Desktop discovery.
Every channel pointer release contains only update manifests. Those manifests
embed the generated changelog and use absolute URLs for artifacts stored on the
immutable version release. The pointer advances only after that release is
published, so a failed promotion can leave an unused immutable release but
cannot point clients at incomplete artifacts.

Version releases are write-once. The publish workflow fails before building if
the `desktop-v<version>` release already exists, and it also rejects an existing
version tag that points at another commit. Never replace an immutable release;
choose a new version instead. After new channel manifests are uploaded, the
workflow removes legacy installer, blockmap, checksum, and obsolete manifest
assets from the mutable `desktop-<channel>` release.

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
AppImage artifacts, and a Windows x64 NSIS `.exe`; prepares all three platform
manifests; generates checksums; and
creates the immutable GitHub release with generated changelog notes. It then
advances the selected `desktop-<channel>` pointer release. Before upload, each macOS
build verifies its Developer ID signature, stapled notarization ticket, and
Gatekeeper assessment; inspects the ASAR for raw workspace TypeScript; mounts
the DMG at its native `/Volumes/...` path; opens the volume in Finder; and fails
unless Finder resolves a non-missing icon-view background file under the DMG's
`.background` directory. The job then closes Finder, copies the app from the
DMG, and launches it in an isolated profile. That packaged app must also
complete a real `electron-updater` check against a deterministic local Generic
feed; module loading, provider configuration, manifest-selection, or branded
DMG background errors fail the build.

The Windows job also checks exact installer/blockmap names, validates both
Authenticode signer subjects, installs silently into the current user's
profile, checks the `matrixos://` and legacy `matrix-os://` protocol
registrations, launches the installed application against the same local
updater fixture, and silently uninstalls it. Any missing artifact, invalid
signature, protocol-registration failure, launch failure, updater failure, or
incomplete uninstall blocks the release.

## Updates

Packaged desktop builds use a channel-scoped Generic feed backed by GitHub
release downloads:

- `desktop-stable` serves `latest-mac.yml` and `latest-linux.yml`.
- `desktop-beta`, `desktop-canary`, and `desktop-dev` serve their matching
  `<channel>-mac.yml` and `<channel>-linux.yml` manifests.
- Windows uses `latest.yml` on stable and `<channel>.yml` on prerelease
  channels from the same channel pointer releases.

The app checks on launch and then hourly; **Matrix OS > Check for Updates…** is
present in installed and development menus. It starts the same check manually
and reports a safe result for unavailable development checks, updates already
being downloaded or ready, newly found updates, up-to-date builds, and failures.
Downloads happen in the background. Once a download is ready, a compact blue
**Update** button appears at the trailing edge of the account/avatar row;
selecting it immediately restarts the app and installs the downloaded version.
Quitting normally also installs a ready update after its release notes have
started persisting and the persistence operation has settled.

Release notes from the downloaded artifact are bounded and persisted in the
desktop's local recreatable state before restart. On the first launch of that
exact version, the signed-in desktop opens **What's New** once and renders those
notes as sanitized Markdown. Remote images are never loaded from release notes,
and external links only open through the trusted HTTPS shell boundary.

Environment overrides:

- `MATRIX_DESKTOP_UPDATE_CHANNEL=dev|canary|beta|stable`
- `OPERATOR_UPDATE_FEED=https://...` for a generic-provider break-glass feed
- `MATRIX_DESKTOP_RELEASE_OWNER` / `MATRIX_DESKTOP_RELEASE_REPO` for forks

Never restart automatically for an update; attached terminal/session work must
survive until the user explicitly selects **Update** or quits the app.

## Verification

For every published run:

```bash
gh release view desktop-v0.1.0 --json tagName,isPrerelease,latestRelease,assets
gh release view desktop-stable --json tagName,isPrerelease,assets
gh release download desktop-v0.1.0 --pattern SHA256SUMS.txt --pattern desktop-release-manifest.json
```

Download the newly published arm64 DMG and open it on a clean macOS user. Confirm
the approved #1255 green branded installer background appears, **Matrix OS** and
**Applications** remain at their intended positions, and dragging Matrix OS to
Applications succeeds. Launch the installed app and confirm Gatekeeper opens it
without an unidentified-developer warning. This manual visual check complements
the automated Finder-background gate; it does not replace it.

On a clean Windows 11 x64 user, download the exact `.exe` and verify its
Properties > Digital Signatures subject matches
`MATRIX_DESKTOP_WINDOWS_PUBLISHER_NAME`. Install it, confirm the Start Menu and
desktop shortcuts, open a `matrixos://auth?status=approved` link, check for
updates from the File menu, and uninstall it from Windows Settings. This manual
SmartScreen/UI check complements the automated Authenticode and silent-install
gate.

## References

- [electron-builder Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [Azure Artifact Signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles)
- [Azure Artifact Signing regional endpoints](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)
- [Azure Artifact Signing GitHub OIDC setup](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md)

For a canary A-to-B acceptance test, install signed Canary A, publish signed
Canary B, and verify `desktop-canary` serves a manifest whose artifact URLs
target B's immutable release. In A, use **Check for Updates…** or wait for the
scheduled check, wait for the blue **Update** button, select it, verify the app
relaunches on B, and confirm **What's New** displays B's generated changelog
exactly once. Repeat the check after relaunch and verify that B is reported up
to date.
