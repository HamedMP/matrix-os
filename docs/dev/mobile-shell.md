# Mobile Shell

The 075 mobile shell work makes the phone experience launcher-first while keeping Canvas explicit and recoverable.

## Runtime Shape

- Browser phone viewport: `Desktop.tsx` switches to the mobile launcher after client-side viewport detection.
- Native Expo app: `apps/mobile/app/(tabs)/apps.tsx` is the primary launcher.
- Apps open full screen through `MobileAppSurface` in the browser shell and native runtime routes in Expo.
- Canvas is reachable through an explicit launcher action, not as the default phone home.
- Terminal uses Matrix-authenticated gateway sessions and WebSockets; users do not need SSH keys.

## Local Dev Build

Use the Expo development client for physical-device testing. Expo Go is not the
supported local runtime for the Matrix OS mobile app because the app uses
native modules and `expo-dev-client`; Expo Go can report SDK/runtime
incompatibility even when the project is otherwise healthy.

### Prerequisites

- Run commands from the repository root unless noted otherwise.
- `apps/mobile/.env` must define `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- The installed Xcode must include the iOS platform matching the test phone.
  Check with `xcodebuild -showsdks`. If Xcode says an iOS version is not
  installed, install it from Xcode Settings > Components or run
  `xcodebuild -downloadPlatform iOS`.
- The phone must appear under `== Devices ==`, not `== Devices Offline ==`:

```bash
xcrun xctrace list devices
```

If the phone is offline, unlock it, keep it on USB, accept Trust prompts, and
confirm iOS Developer Mode is enabled.

### Build and Install the Dev Client

Only rebuild the native dev client when native dependencies, Expo plugins,
`app.json`, iOS entitlements, bundle identifiers, or pods change. Normal JS and
React Native changes only need Metro reload.

```bash
pnpm --filter matrix-os-mobile exec expo run:ios --device <device-udid-or-name>
```

Example for the current Matrix OS iPhone:

```bash
pnpm --filter matrix-os-mobile exec expo run:ios --device 00008120-00121C41119B401E
```

The app's iOS bundle identifier is `com.matrixos.mobile`, the Expo slug is
`matrix-os-mobile`, and the custom URL scheme is `matrixos`.

### Run Metro for the Installed Dev Client

Start Metro over LAN:

```bash
pnpm --filter matrix-os-mobile exec expo start --dev-client --host lan --clear
```

Find the Mac's LAN IP:

```bash
ipconfig getifaddr en0
```

Open the installed Matrix OS dev build on the phone and connect to:

```text
http://<mac-lan-ip>:8081
```

The equivalent dev-client deep link is:

```text
exp+matrix-os-mobile://expo-development-client/?url=http%3A%2F%2F<mac-lan-ip>%3A8081
```

In normal terminals Expo prints a QR code. In non-interactive coding-agent
terminals the QR may not render; use the URL above, or generate a QR for the
deep link and scan it from the dev-client launcher. If the phone cannot reach
the Mac on LAN, retry Metro with `--host tunnel`.

### Clerk Redirects

Google SSO depends on Clerk allowing the mobile redirect URI used by
`apps/mobile/app/sign-in.tsx`:

```text
matrixos://sso-callback
```

In the Clerk dashboard for the same instance as `apps/mobile/.env`, enable the
Native API and allowlist `matrixos://sso-callback` for the native application.
Use Team ID `PX4JL74Y2K` and bundle ID `com.matrixos.mobile`.

### Common Failures

- `Project is incompatible with this version of Expo Go`: use the installed
  dev client, not Expo Go.
- `No device UDID or name matching ...`: Xcode does not currently see the
  phone as an available device. Check `xcrun xctrace list devices`.
- `iOS <version> is not installed`: install the matching iOS platform in Xcode
  Settings > Components or run `xcodebuild -downloadPlatform iOS`.
- `No apps connected` after pressing reload: Metro is running but the dev
  client has not connected yet. Open the installed app and connect to the Metro
  URL.
- `redirect url ... does not match an authorized redirect URI`: add
  `matrixos://sso-callback` to Clerk's native redirect allowlist.

## State

Mobile resume state is intentionally small and validated before use.

- Browser shell state: `shell/src/stores/mobile-shell-store.ts`
- Native mobile state: `apps/mobile/lib/mobile-shell-state.ts`
- Current fields: mode, last active app slug, last active terminal session id, Canvas entry timestamp, update timestamp.

Do not persist raw paths, user-controlled URLs, or unvalidated terminal identifiers in mobile shell state.

The Agents route relies on its root scroll view's automatic iOS content inset.
Keep top and bottom content padding independent of safe-area values so the
notch and home-indicator insets are not applied twice. Its attention-first
cockpit renders static Working status marks and reconciles the bounded gateway
summary on pull-to-refresh; completed and recoverable stale threads stay
reachable through the contract-bounded Recent group without an additional UI
cap that could hide older summary rows.

The new-agent composer asks for a project before it can submit. Available
projects come from the current validated runtime summary. If the list is empty,
the phone-first empty state can create a scratch project or import a GitHub
repository through `POST /api/projects`, then refreshes the runtime summary and
selects the returned canonical slug. The project form, repository URL, runtime
summary, and mutation response are transient and must not be written to
AsyncStorage.

## Terminal Validation

The mobile terminal path should be checked at three layers:

```bash
bun run test tests/gateway/terminal-ws.test.ts
pnpm --dir apps/mobile exec jest --runInBand __tests__/terminal-client.test.ts __tests__/terminal-state.test.ts __tests__/terminal-screen.test.tsx __tests__/TerminalControlBar.test.tsx
bun run test tests/shell/terminal-app-component.test.tsx
```

Manual terminal checks on a phone:

1. Open Terminal from Apps.
2. Create a new session and confirm the current folder is visible.
3. Run `pwd`.
4. Use Tab, Escape, arrows, Control, paste, and font size controls.
5. Leave and reopen Terminal, then continue the running session.
6. End the session and confirm the resume card disappears or shows the safe recovery message.

## Full Mobile Readiness Gates

Use these before handing the branch to a real-device tester:

```bash
pnpm --dir apps/mobile exec jest --runInBand
pnpm --dir apps/mobile exec tsc --noEmit
bun run test tests/shell/terminal-app-component.test.tsx tests/shell/mobile-shell.test.tsx tests/shell/mobile-canvas.test.tsx tests/shell/user-button-hydration.test.tsx tests/shell/app-launch.test.ts tests/shell/app-viewer-slug.test.ts
pnpm --dir shell exec tsc --noEmit
bun run test tests/gateway/terminal-ws.test.ts
bun run typecheck
bun run check:patterns
git diff --check
```

`bun run test` is still the broad root gate, but unrelated platform/integration flakes are recorded in `specs/075-mobile-shell/quickstart.md` when they block a clean root run.

## Real Device Checklist

- Hard refresh/reopen after onboarding and confirm Apps, not Minesweeper or Canvas, is first.
- Open built-ins from Apps: Terminal, Chat, Files, Whiteboard/Canvas, Notes, Tasks, and at least one game.
- Confirm each app is full screen and Home returns to Apps.
- Confirm Continue restores the last app where possible.
- Confirm unavailable apps show a generic fallback, not raw gateway or filesystem errors.
- Confirm Terminal path, prompt/cursor, command input, and touch controls are visible in portrait and landscape.
