# 652: Side-by-side Desktop Canary

Ticket: [ENG-443](https://linear.app/matrix-os/issue/ENG-443/electron-desktop-terminal-window-local-and-all-matrix-computers)

## Goal

Run **Matrix OS** (stable) and **Matrix OS Canary** as two separate installed Electron Desktop
apps on one machine, both signed in to the same Matrix computer. Canary rebuilds automatically
whenever a merge to `main` changes desktop code. The computer may run either the stable or the
dev host bundle.

## Problem

- `desktop-release-canary.yml` has failed at startup since #3086. The reusable
  `desktop-build.yml` needs `actions: read`, and #3159 granted it only to the stable caller.
- Canary runs on a 12-hour cron, not on merge.
- Canary and stable share one identity: `appId com.matrix-os.operator`, product name
  `Matrix OS`, one icon, `~/Library/Application Support/Matrix OS`, one Safe Storage keychain
  entry, and the `matrixos://` scheme. Installing canary replaces stable.
- A canary build comes from `main` HEAD, so its commit almost never matches the computer's
  host bundle. The advisory "Update Matrix OS" dialog would open on every new canary build.

## Affected surfaces

Electron Desktop only (macOS, Windows, Linux packaging). Web Canvas, Web Desktop, Web Mobile and
Native Mobile are N/A: they have no installed channel identity. The platform device-auth route
gains one accepted redirect scheme.

## Behavior

### Channel identity (build-time)

| Build channel | App name | appId | URL schemes | Icon |
| --- | --- | --- | --- | --- |
| stable, beta, dev | Matrix OS | `com.matrix-os.operator` | `matrixos`, `matrix-os` | `build/icon.*` |
| canary | Matrix OS Canary | `com.matrix-os.operator.canary` | `matrixos-canary` | `build/icon-canary.*` (black, white rabbit) |

- The identity comes from the channel baked in at build time (`__MATRIX_DESKTOP_UPDATE_CHANNEL__`).
  The runtime `MATRIX_DESKTOP_UPDATE_CHANNEL` override still changes the update feed only. It never
  changes identity, because the bundle identifier is fixed at packaging time.
- `desktop/src/shared/channel-identity.ts` is the runtime source of truth.
  `desktop/electron-builder.canary.mjs` loads the stable config and replaces the identity fields,
  and a parity test keeps the two in step. It does not use `extends`: electron-builder concatenates
  arrays when extending, so Canary would also claim `matrixos://`.
- Canary uses its own user data directory (`Matrix OS Canary`), Safe Storage service, single-instance
  lock, Windows NSIS registration (derived from appId), and updater download cache
  (`desktop-canary-updater`, from `extraMetadata.name`).
- Canary registers only `matrixos-canary`, so it never takes stable's `matrixos://` links.

### Sign-in to one computer from both apps

- Both apps use device auth with client `matrix-os-desktop`. Platform tokens are stateless sync
  JWTs scoped to the user's handle. A second sign-in does not revoke the first, so both apps
  can stay signed in to the same computer.
- Canary sends `redirectUri: matrixos-canary://auth?status=approved`. The platform accepts the
  `matrixos-canary:` scheme with host `auth` for trusted native desktop clients, under the same
  HMAC signing as the existing schemes.
- Until the platform deploys, it drops the unknown redirect, and sign-in still completes by
  polling. The deep link only focuses the window, so canary sign-in never depends on the
  platform deploy.

### Stable or dev host bundle

- Protocol compatibility (`RuntimeCompatibilitySchema`) stays authoritative for every channel. If
  the computer's protocol range excludes the desktop, the update dialog opens as it does today.
- Prerelease desktop builds (canary, beta, dev) suppress the advisory **release-alignment** notice
  (`runtime-update-required` by ancestry, `different-releases`) when the protocol is compatible or
  legacy. Stable keeps today's behavior.
- The desktop never changes the computer's update channel. Cloud repair keeps following the
  computer's subscribed channel (`/api/system/update`).

### Release pipeline

- `desktop-release-canary.yml` runs on `push` to `main` when desktop inputs change (`desktop/**`,
  `packages/{brand,ui,contracts,sync-client}/**`, the shell and home files the renderer compiles in
  (`shell/public/**`, `shell/src/components/app-sites/**`, `shell/src/lib/site-client*`,
  `home/system/icons/**`), `scripts/release/**`, desktop workflows and release actions, and root
  workspace manifests), plus `workflow_dispatch`. The cron is removed. A test fails when the renderer
  imports a shell or home path that the filter does not cover.
- `concurrency: desktop-release-canary` with `cancel-in-progress: false` keeps one running and
  one pending build, so a burst of merges collapses into the next build.
- The canary caller grants `actions: read`.
- `desktop-build.yml` selects the canary builder config for `channel == canary` and resolves the
  packaged app and executable names from the channel in every mac, Windows and Linux check.

## Acceptance checks

1. A canary dispatch on this branch's merge commit publishes `desktop-v<base>-canary.<ts>` and
   advances `desktop-canary`. Its mac DMG contains `Matrix OS Canary.app` with
   `CFBundleIdentifier = com.matrix-os.operator.canary` and the URL scheme `matrixos-canary`.
2. `Matrix OS.app` (stable 0.1.23+) and `Matrix OS Canary.app` run at the same time with separate
   user data directories. Both are signed in to the same computer, and signing out of one leaves
   the other signed in.
3. Against a computer on the stable bundle, and against one on the dev bundle, canary opens no
   release-alignment dialog while protocols are compatible.
4. A merge that touches only shell files the desktop app does not import does not start a canary
   build. A merge that touches `desktop/` or an imported shell file does.

## Documentation

- Public docs: [FinnaAI/matrix-os-site#352](https://github.com/FinnaAI/matrix-os-site/pull/352) adds
  a **Matrix OS Canary** section to `content/docs/desktop.mdx`. It covers the separate identity,
  side-by-side sign-in, update-dialog behavior and the one-time reinstall.

## Migration

- Windows: an old canary-channel install with the stable app id keeps its own feed and is not
  replaced. Uninstall it by hand if one exists.

- The current `/Applications/Matrix OS.app` is a canary-channel build with the stable identity.
  Squirrel.Mac rejects an update whose designated requirement (bundle identifier) differs, so it
  will not silently turn into the canary app. Reinstall stable from `desktop-stable`, then install
  canary from `desktop-canary` once.

## Risks

- **Identity drift between the builder config and the runtime table.** Covered by the parity test.
- **Windows canary install collides with stable.** A distinct appId gives a distinct NSIS GUID. The
  workflow's silent-install check asserts the canary display name and scheme.
- **Prerelease builds hide a real mismatch.** Only the advisory alignment notice is suppressed;
  protocol incompatibility still opens the dialog.

## Security

- No new endpoints. The platform change widens an allowlist by one exact scheme plus host
  (`matrixos-canary://auth`), behind the same trusted-client check and HMAC-signed redirect.
- No new secrets, persistence or network calls. Canary credentials stay under its own Safe Storage
  service.
