# Feature Specification: Install Matrix Apps as Desktop Apps

**Created**: 2026-11-27
**Status**: Draft, awaiting owner review
**Tracking**: [ENG-603](https://linear.app/matrix-os/issue/ENG-603/featdesktop-install-matrix-apps-as-native-desktop-apps)
**Input**: "How can we do this in our Matrix desktop app? Let's ship this asap": https://claude.com/resources/articles/install-as-app

## Goal

From Electron Desktop, the owner can install any Matrix app (default or
owner-built, under `~/apps/`) as a desktop app. An installed app:

- opens in its own window, under its own name and icon in the Dock or taskbar,
  the app switcher, Mission Control and Stage Manager;
- launches from Finder, Launchpad, Spotlight or the Start Menu;
- always runs the app's current files, so edits show up with no reinstall;
- uses the Matrix session of the running desktop app and needs no other login.

## Owner Decisions (2026-11-27)

1. **Fidelity**: real per-app desktop apps like Claude's "Install as app". A
   pop-out window under the Matrix Dock icon is not enough on its own.
2. **macOS mechanism**: Electron 45's upstream app shims. Electron 41 has no
   way to do this; the spike below shows why a copy-and-re-sign approach fails.
3. **Delivery**: one GitHub native stack under ENG-603, Electron upgrade first.

## How Claude Does It (checked against Claude 6.28899.6, Electron 45.3.3)

- "Install as App…" writes a bundle with its own `CFBundleIdentifier`
  (`com.anthropic.claudefordesktop.artifact-app.<installId>`), name and icon.
  Its executable is Electron's `app_shim_loader`. The Info.plist points back at
  Claude through `ElectronAppShimHostPath`, `ElectronAppShimHostBundleIdentifier`,
  `ElectronAppShimServerName` and `ElectronAppShimHostArguments`.
- A native module seals the bundle and stores its code-directory hashes. Claude
  rejects any connecting shim unless `shim.satisfiesCodeRequirement('cdhash H"…"')`
  matches a recorded hash.
- Claude's main process owns every window (`new BrowserWindow({ appShim })`);
  the shim process only hosts the native window, Dock icon and menu bar.
- Names that look like Claude, Anthropic, Apple, iCloud or macOS get
  " (Artifact)" added to stop spoofing. Apps open at quit are reopened after a restart.
- On Windows: a `.lnk` shortcut with its own AppUserModelID.

## Spike Results (2026-11-27, macOS arm64, Matrix OS 0.1.31 on Electron 41)

| Attempt | Result |
| --- | --- |
| Copy of the Matrix stub, original signature, symlinked `Frameworks` and `Resources` | Runs |
| Changed `CFBundleName` | Electron aborts: "Unable to find helper app" (helper lookup uses `CFBundleName`) |
| Changed Info.plist, original signature | Killed by the kernel (exit 137) |
| Ad-hoc re-sign: original entitlements, hardened runtime, re-signed helpers, or peer-requirement features disabled | Main process and helpers crash (SIGTRAP) |
| Editing a bundle after its first launch | Denied by macOS App Management |

Conclusion: on stock Electron 41 a per-app process can't get its own
identity. Electron 45's `app_shim_loader` is signed by our team and has no
Info.plist binding, so a copy of it can sit in a generated bundle without
re-signing. Shims must be written in full before their first launch, and
replaced as a whole, never edited in place.

## Surfaces

| Surface | Scope |
| --- | --- |
| Electron Desktop (macOS 13+) | Full: install, shim windows, Dock identity, menu, badge |
| Electron Desktop (Windows) | Full: Start Menu shortcut, per-app AppUserModelID taskbar identity |
| Electron Desktop (Linux) | Own window plus a `.desktop` launcher; a separate taskbar entry only where `StartupWMClass` is honored |
| Web Desktop, Web Canvas | "Open in Matrix Desktop" action when the desktop app is installed; no browser install (the sandboxed `srcdoc` app runtime cannot register a service worker) |
| Web Mobile, Native Mobile | N/A: no desktop install target |

## User Journey

1. In Electron Desktop the owner opens an app's window menu or its launcher
   context menu and picks **Install as App…**. A sheet shows the name, the icon
   and what the app may use (see Permissions), with **Install** and **Cancel**.
2. Matrix writes the app, opens it in its own window, and shows it in Finder
   (macOS) or confirms it in the Start Menu (Windows).
3. Later the owner launches it from the Dock, Finder, Spotlight or the Start
   Menu. If Matrix isn't running, the shim starts it in the background first.
4. The app's own menu bar (macOS) has Reload, Open in Matrix, Show in Finder
   and Uninstall… items.
5. **Uninstall…** (from the app menu or Matrix's Apps menu) removes the bundle
   or shortcut and its saved window state, but never the app's files or data.

States: signed out shows a "Sign in to Matrix to open <App>" window that
focuses Matrix. If the app was deleted or the runtime is unreachable, the
window shows an empty state with Retry and Uninstall. A version mismatch after
a Matrix update shows "Restart Matrix to finish updating".

## Architecture

### Layers (one native stack, about 5 PRs)

1. `chore(desktop)`: Electron 41 → 45.4.1 (no feature code).
2. `feat(desktop)`: app window host. A main-process `InstalledAppWindows`
   controller, one window per installed app, keyed by `installId`, reusing the
   embed launch path (`/api/apps/:slug/session-token`, the native app bridge
   and capability gating) and the Terminal-window bounds persistence. Adds the
   `matrixos://app/<installId>` deep link.
3. `feat(desktop)`: macOS installer and shim host: bundle writer, shim server,
   trust check, shim menu, version-mismatch prompt, reopen after restart.
4. `feat(desktop)`: Windows and Linux launchers, plus the Install and Uninstall UI
   (shared `packages/ui` sheet).
5. `feat(shell)`: "Open in Matrix Desktop" in Web Desktop and Web Canvas.
- Public docs: an install/launch/uninstall guide in FinnaAI/matrix-os-site `content/docs/`, as a separate PR after this stack lands.

### Install record (source of truth)

`<userData>/installed-apps.json`, written atomically (temp file + rename):
`{ installId, appIdentity, slug, runtimeSlot, name, iconSha256, bundlePath, cdHashes[], createdAt }`.
The cap is 64 installs, and the installer refuses past it. `installId` is a
random UUID: it is never derived from the app's folder name, because folder
names are owner-controlled. The record is local to the device; installs are not
synced.

### macOS bundle

`~/Applications/Matrix Apps/<Name>.app`, built in a temp directory next to it,
then moved into place with `rename` (`flag: 'wx'` semantics: never overwrite an
existing path; add " 2" and so on).

- `Contents/MacOS/app-shim`: copy of `Electron Framework.framework/Helpers/app_shim_loader`.
- `Contents/Info.plist`: `CFBundleIdentifier = com.matrix-os.app.<installId>`,
  display name, `CFBundleIconFile`, and the four `ElectronAppShim*` keys. The
  server name is per channel (`matrix-stable`, `matrix-canary`, `matrix-dev`,
  `matrix-preview-<slot>`) so channels never adopt each other's shims.
- `Contents/Resources/app.icns`: built from the app's shipped icon
  (`/icons/{slug}.png`), with the Matrix icon as fallback.
- Signing, like Claude's: in the temp directory, before the move and before
  any launch, the whole bundle is signed ad hoc with the hardened runtime and
  one entitlement, `com.apple.security.cs.disable-library-validation` (so the
  ad-hoc shim can load Matrix's Electron Framework):
  `codesign --force --sign - --options runtime --entitlements <plist> <bundle>`,
  then `codesign --verify --strict`. This binds the Info.plist, seals the
  resources and gives each bundle its own cdhash, read with `codesign -dvvv`
  and stored in the install record. A signing or verify failure aborts the
  install and removes the temp directory.

### Trust check on `app-shim-connected`

1. `shim.bundlePath` must match an install record (recorded as the real path,
   which is what a launched shim reports), and `shim.bundleId` must be that
   install's `com.matrix-os.app.<installId>`.
2. `shim.satisfiesCodeRequirement('cdhash H"<recorded>"')` with that bundle's own
   recorded cdhash. Shims are signed ad hoc, so there is no team anchor; another
   bundle's code, or this bundle after an edit, fails the check.
3. Otherwise call `shim.quit()` and log a coarse reason. No window is created
   before the check passes.

## Permissions

v1 keeps the app's existing capability policy (the browser level: the same
bridge and capabilities it has inside Matrix today). App-level capabilities
(notifications through `shim.setBadge`/`bounce`, global shortcuts,
always-on-top) and full computer access are later layers. Each needs per-version
approval, like Claude's re-prompt after every update, and is out of scope here.

## Security Architecture

- **Auth matrix**: only the signed-in owner of the running Matrix session can
  install, open or uninstall. An installed window uses the same launch-token
  path as embedded apps; no new credential is stored in the bundle, and the
  bundle holds no token.
- **Input validation**: `installId` is a UUID and is checked with Zod at the
  deep link, the shim connect and IPC. Bundle names come from catalog metadata,
  sanitized (path separators, leading dots, `.app`), capped at 64 characters,
  and get " (Matrix App)" added when they look like Matrix, Apple, macOS,
  iCloud or Finder. Every file path is resolved within
  `~/Applications/Matrix Apps/`.
- **Error policy**: renderer and app errors are generic ("App can't open
  right now"); real errors are logged in the main process only.

## Integration Wiring

Startup: after `app.whenReady()` and auth restore, load install records →
`app.startAppShimServer({ name })` (macOS) → handle a pending
`matrixos://app/` deep link → reopen apps that were open at quit (at most 15
minutes old, concurrency 4). Shutdown: save open apps, `stopAppShimServer()`,
close app windows, flush records.

## Failure Modes

- Matrix not running: the shim launches it with `ElectronAppShimHostArguments`
  and waits up to 60 seconds (Electron's own limit).
- Matrix updated while running: `app-shim-version-mismatch` → restart prompt.
- Sign-out or runtime switch: close app windows; reopening needs the new session.
- Partial install (crash mid-write): the temp directory is swept on start-up
  (`lstat`, skip symlinks, only directories with our prefix).
- Bundle moved or deleted by the user: the record is pruned on start-up; a
  connect from an unknown path is rejected.

## Resource Management

- At most 64 install records and 16 open app windows; past either, refuse with a message.
- Window-state saves are debounced (500 ms); the deep-link queue holds one pending link.
- The icon conversion runs once per install, with a 10 s timeout.

## Acceptance Checks

1. On a signed macOS build, install an app; its Dock icon, name and app
   switcher entry are separate from Matrix's; Cmd+Q quits only that app.
2. Edit the app's files in Matrix; reopening the installed app shows the change.
3. A hand-made shim bundle pointing at Matrix's server name is rejected (no window).
4. Windows: the Start Menu shortcut opens the app with its own taskbar group and icon.
5. Uninstall removes the bundle or shortcut and the record, but not `~/apps/<app>`.
6. Each of Web Desktop and Web Canvas shows "Open in Matrix Desktop" and opens
   the installed app through the deep link.

## Risks

- App shims are marked experimental in Electron 45; the API may change in 46+.
  Mitigation: one adapter module (`main/installed-apps/shim-host.ts`).
- Shim windows lack `titleBarOverlay`, `setProgressBar` and modal or parent
  windows; app windows must not rely on them.
- UNNotification needs a signed app, so dev builds can't show app notifications.
