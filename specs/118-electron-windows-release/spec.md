# Electron Windows Release

## Goal

Ship the existing Matrix OS Electron desktop as a signed Windows 11 x64 NSIS
installer through the same immutable release and OTA channel system used by
macOS and Linux.

## Decisions

- Package `win32-x64` as a per-user, one-click NSIS installer. It requests
  `asInvoker`, registers `matrixos://` plus the narrowed legacy `matrix-os://`
  scheme, and does not require administrator access for a normal install.
- Use Azure Artifact Signing with GitHub OIDC as the primary signer. Scope the
  service principal to `Artifact Signing Certificate Profile Signer` on one
  certificate profile. Keep an explicit exportable-PFX fallback for outages.
- Keep local `electron-builder.yml` usable without signing. The release-only
  `electron-builder.windows.mjs` config requires a valid signing mode and sets
  `forceCodeSigning`, so release CI cannot emit unsigned Windows artifacts.
- Publish stable Windows metadata as `latest.yml` and prerelease metadata as
  `<channel>.yml`. Mutable channel releases hold only the macOS, Linux, and
  Windows manifests; all installer bytes remain on immutable version releases.
- Use Windows window-controls overlay and Windows menu/accelerator conventions.
  Linux keeps its native title bar; macOS retains traffic lights.

## Security and failure boundaries

No application endpoint changes are introduced, so the endpoint auth matrix is
not applicable. Signing input is the relevant trust boundary:

- Signing mode, publisher subject, Azure endpoint, account, and profile are
  validated before packaging.
- Azure endpoints must be credential-free HTTPS origins under
  `*.codesigning.azure.net`; resource names are bounded safe identifiers.
- Certificate bytes, passwords, and OIDC tokens never enter generated config,
  logs, artifacts, or source control.
- Release packaging fails closed if configuration is absent or if either the
  installed executable or installer lacks a valid signature from the configured
  publisher.
- GitHub OIDC access is bound to the protected `desktop-release` environment;
  Azure RBAC is scoped to one certificate profile.

## Wiring verification

The reusable desktop workflow must build on `windows-latest`, authenticate,
package, verify exact artifacts, verify Authenticode, silently install, verify
both protocol registrations, launch the installed app against a bounded local
updater fixture, then uninstall. Unit/contract tests cover signing config,
builder config, manifest names, channel pruning, menu conventions, and window
chrome. Desktop typecheck/build and YAML parsing run before review.

## Delivery

- Matrix OS implementation PR with tests, workflow, runbook, and this spec.
- Separate PR in private `FinnaAI/matrix-os-site` updating the public desktop
  installation/release documentation with Windows availability and signed
  installer expectations.
