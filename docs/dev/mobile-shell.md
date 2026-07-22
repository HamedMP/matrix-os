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

## Workspace Gotchas (read before debugging tooling)

`pnpm-workspace.yaml` sets `enableGlobalVirtualStore: true`, so packages are
linked from `~/Library/pnpm/store/v10/links/...` — **outside the repo**. Any
package that `require()`s a dependency it never declared cannot resolve it.
Three separate failures come from this, and all of them look like broken code
until you recognise the pattern.

**`packageExtensions` only work in the root `package.json`.** pnpm silently
ignores the `packageExtensions:` block in `pnpm-workspace.yaml` in this
configuration. An entry there has no effect on the installed tree. Add
extensions under `pnpm.packageExtensions` in the root `package.json` instead;
`apps/mobile/__tests__/mobile-app-config.test.ts` asserts the workspace file
stays free of them. This is what broke `eas build` (see below).

**`eas build` fails at `expo config --json`** if a config plugin cannot load its
own dependencies. EAS resolves the project config by shelling out to the expo
CLI *from the store*, not from `apps/mobile/node_modules`. The symptom:

```
expo/bin/cli config --json exited with non-zero code: 1
  PluginError: Cannot find module '@expo/config-plugins'
```

Fix by declaring the missing edge in root `package.json` `pnpm.packageExtensions`,
keyed with `@*` so a later upgrade of the plugin package does not silently
un-match and reintroduce the failure.

**Metro's dev server cannot bundle** — it rejects modules whose realpath sits
outside `projectRoot`/`watchFolders`, so the app shows
`Unable to resolve module ./apps/mobile/node_modules/expo-router/entry`. For
local device work only, add the store to `watchFolders` in
`apps/mobile/metro.config.js`; **do not commit it**. Production bundling
(`expo export`, and therefore EAS builds) is unaffected, so a green EAS build
does not prove the dev server works, and vice versa.

**Jest needs the `modulePaths` fallback.** `apps/mobile/jest.config.js` adds the
hoisted root `node_modules` as a resolution root, and the root `package.json`
carries `packageExtensions` for `@react-native/jest-preset` and
`react-native-worklets`. Without these the suite cannot start at all — it fails
during config load, before any test runs.

Other environment notes:

- Run everything through `flox activate -d <repo root> --` so you get Node 24.
- `pnpm install` fails building `sharp` from source on macOS; use
  `--ignore-scripts`. Native mobile builds do not need it.
- Start Metro and EAS commands with cwd `apps/mobile`. From the repo root Metro
  picks the wrong project root and every bundle request 404s.
- `pnpm --filter matrix-os-mobile exec tsc --noEmit` reports **31 pre-existing**
  `'X' cannot be used as a JSX component` errors on `main`. Compare against base
  dependencies before attributing them to your change.

## Sign-In and Auth

Which sign-in factors an account can use is decided **per account**, not per
instance. Read the live truth instead of guessing — this endpoint is public:

```bash
curl -s "https://clerk.matrix-os.com/v1/environment?__clerk_api_version=2025-04-10&_clerk_js_version=5.90.0"
```

To see what a *specific* account can use, create a sign-in attempt (harmless —
nothing is sent until you call prepare):

```bash
curl -s -X POST "https://clerk.matrix-os.com/v1/client/sign_ins?__clerk_api_version=2025-04-10&_clerk_js_version=5.90.0" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Origin: https://app.matrix-os.com" \
  --data-urlencode "identifier=someone@example.com"
```

`supported_first_factors` is the answer. An account with a password returns
`['password', 'email_code', 'reset_password_email_code']`; an OAuth-only signup
returns `['email_code', 'oauth_google', 'reset_password_email_code']` with **no**
`password` entry. Attempting `strategy=password` against the latter fails with
`strategy_for_user_invalid` — "not valid for this account", which is an account
fact, not an instance misconfiguration.

The mobile sign-in therefore tries the typed password first and falls back to an
email code when Clerk reports the account has none. Apple App Review requires
demo credentials that work, so the review account **must have a password set**;
an OAuth-only account cannot log in with a username and password.

Sign-**up** by email is deliberately not implemented on mobile: the instance
requires a username and legal consent at signup. New users go through OAuth or
the web.

## Over-the-Air Updates (EAS Update)

OTA landed in v0.2.1. Builds published before it shipped without `expo-updates`
and can **never** receive an update.

- `expo-updates` is a dependency; `app.json` sets `updates.url` to the project's
  EAS endpoint and `runtimeVersion.policy` to `appVersion`.
- Every `eas.json` build profile declares a `channel`. A build with no channel
  can never receive an update.
- Publish with `eas update --branch production --message "..."`.

**The `appVersion` policy has a sharp edge**: the runtime version tracks
`version` in `app.json`, so a release that changes native code (new native
module, plugin, or SDK bump) **must** bump `version`. Otherwise the update is
delivered to builds whose native code no longer matches the JS, which crashes at
runtime. If that guarantee needs to be automatic, switch the policy to
`fingerprint` — at the cost that any dependency change stops OTA from reaching
existing builds.

## iOS TestFlight Release

From a clean manual worktree on the latest `origin/main`, with cwd `apps/mobile`:

```bash
eas build --platform ios --profile production --auto-submit --non-interactive
```

`appVersionSource: remote` means EAS owns the build number and increments it;
`version` in `app.json` is still the marketing version and is yours to bump.
Bump it whenever the release changes native code (see the OTA note above) or
when you want the TestFlight build to be distinguishable from the previous one.

Auto-submit uploads to App Store Connect using the stored API key; Apple then
takes about 5-10 minutes to process before the build appears in TestFlight.
Verify at https://appstoreconnect.apple.com/apps/6785629815/testflight/ios.

## Android Store Release

Use a clean manual worktree based on the latest `origin/main`. From the mobile
app directory, validate the production config and create the Play Store bundle:

```bash
cd apps/mobile
eas project:info
eas build --platform android --profile production
```

The production profile emits an Android App Bundle (`.aab`), increments the
remote Android version code, and uses package name `com.matrixos.mobile`.
Download the finished artifact from the EAS build page.

Google Play requires the first bundle for a new app to be uploaded manually in
Play Console. Create the app with the exact package name, enable Play App
Signing, and upload the `.aab` to Internal testing before configuring API-based
submissions. Add testers and complete the store listing, privacy policy, data
safety, content rating, target audience, ads, and distribution declarations in
Play Console.

After the first manual upload, create a least-privilege Google Play service
account with permission to release to testing tracks and attach its JSON key to
the EAS project through `eas credentials`. Never commit the key. Subsequent
internal-track submissions use:

```bash
eas submit --platform android --profile production --latest
```

Promote a verified internal release through Play Console rather than changing
the default automated submission track directly to production.

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

### Native Computer Selection

Cloud-authenticated users can switch between their main and preview Matrix computers from
**Settings → Switch computer**. The platform-owned `GET /api/auth/computers` projection returns a
bounded list of safe labels, statuses, versions, and same-origin `/vm/:handle` paths. The mobile app
validates that response and persists only the selected `GatewayConnection`; it never persists the
computer inventory or platform metadata.

A Basic Auth connection has no Clerk identity and therefore cannot list Cloud computers. The
chooser must offer the Cloud sign-in route in that state. After Cloud sign-in, switching computers
reuses the existing Clerk token provider and does not require another sign-out.

Focused validation:

```bash
pnpm exec vitest run tests/platform/proxy-routing.test.ts -t 'Matrix computers|native computer'
pnpm --filter matrix-os-mobile run test --runInBand --runTestsByPath __tests__/computer-picker-screen.test.tsx __tests__/settings-screen.test.tsx __tests__/storage.test.ts __tests__/mobile-computers.test.ts
```

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
projects come from the current validated runtime summary. If none is available,
including when the list contains only stale or missing rows,
the phone-first empty state can create a scratch project or import a GitHub
repository through `POST /api/coding-agents/projects`, then refreshes the runtime
summary and selects the returned canonical project id. The project form,
repository URL, runtime summary, and mutation response are transient and must not be written to
AsyncStorage. An explicit stale project route stays unselected rather than
falling back to an unrelated project.

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

## Coding-Agent Project Workspace Validation

Automated mobile checks cover the gateway-projected project/task/conversation model and both project views:

```bash
pnpm --dir apps/mobile exec jest --runInBand __tests__/agent-workspace-state.test.ts __tests__/agent-project-workspace-screen.test.tsx __tests__/agent-project-route.test.tsx __tests__/agent-project-board-route.test.tsx __tests__/agent-thread-screen.test.tsx
pnpm --dir apps/mobile exec tsc --noEmit
pnpm --dir apps/mobile run lint
```

Manual checks in the SDK 57 dev client:

1. Open Agents, select a project, and confirm its project-level chats and task groups come from the live gateway projection.
2. Open two different conversations attached to one task and confirm each route retains its exact project, task, and thread identity.
3. Send a follow-up and confirm it stays in the current conversation; retry a busy response without creating a replacement thread.
4. Switch between Conversation and Kanban and confirm the selected project/task/thread stays stable.
5. Confirm Kanban uses To do, Running, Waiting, Blocked, and Complete sections; archived tasks stay hidden and mixed thread states do not move a task.
6. Check the phone layout in portrait and landscape, then verify the wrapped board at tablet width.
7. Background and reopen the app, reconnect the gateway, and confirm stale references reconcile to the live project workspace.

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

## Coding-Agent SDK 57 Device Smoke

Use this checklist before broad rollout of mobile coding-agent shell changes, and
whenever a release touches Agents workspace routing, terminal handoff, review
details, previews, approvals, user input, push routing, or mobile persistence.
Keep all evidence public-safe: do not paste bearer tokens, provider credentials,
private hostnames, VPS IPs, raw provider output, terminal output, transcripts,
file contents, diffs, approval payloads, launch tokens, or customer identifiers.

### Automated Preflight

Run the focused mobile coding-agent checks first:

```bash
pnpm --dir apps/mobile exec jest --runInBand __tests__/agents-screen.test.tsx __tests__/agent-thread-screen.test.tsx __tests__/agents-preview-screen.test.tsx __tests__/agent-workspace-state.test.ts __tests__/gateway-client.test.ts __tests__/push.test.ts
pnpm --dir apps/mobile exec tsc --noEmit
pnpm --dir apps/mobile run lint
```

If the slice touches terminal routing or terminal persistence, also run:

```bash
pnpm --dir apps/mobile exec jest --runInBand __tests__/terminal-client.test.ts __tests__/terminal-state.test.ts __tests__/terminal-screen.test.tsx __tests__/TerminalControlBar.test.tsx
```

If the slice touches shared contracts, gateway read models, or shell runtime
summary behavior, run the matching gateway or contract tests listed in
`docs/dev/coding-agent-shells.md` before moving to a phone.

### Runtime Preflight

1. Start a Matrix runtime that has coding-agent shell capabilities enabled.
2. Validate the authenticated `/api/coding-agents/summary` runtime summary
   using the runtime smoke command documented by the stack under test. Require
   the mobile workspace capability and any capability changed by the slice.
3. If the validation requires a running thread, create it from a disposable test
   workspace first, then run the helper with the thread-snapshot assertion.
4. Confirm failures are generic and recovery-oriented. Do not capture provider
   raw errors, internal paths, private hostnames, or terminal output as evidence.

### Phone Flow

1. Launch the Expo SDK 57 dev client using the instructions above, then sign in
   and select the intended Matrix computer.
2. Confirm Chat, Mission Control, Terminal, Apps, and Settings still open from
   the mobile shell.
3. Open Apps, then open Agents. Confirm provider status, recent work, attention
   threads, terminal summaries, and preview summaries hydrate from the gateway
   without raw errors.
4. Open a thread detail from Recent Work. Confirm the bounded timeline, newest
   approval or input request, review links, and terminal references render from
   the gateway snapshot.
5. If using a disposable run, submit one approval decision or user-input answer
   and confirm duplicate taps stay disabled while the request is in flight.
   Confirm failure copy remains generic.
6. Use a bound terminal action from Agents or thread detail. Confirm it opens the
   existing Terminal tab and attaches to the canonical Matrix terminal session;
   leaving Terminal must not end the underlying process.
7. Open review, file, and preview routes from the thread or summary. Confirm
   large or unavailable review data shows partial/recoverable UI, file content
   reloads from the gateway, and preview failures stay generic.
8. If push credentials are available on the test device, tap an attention
   notification and confirm it opens the matching Agents route. If a live push
   is not practical, rely on the mobile push tests and record that manual push
   tap routing was deferred.
9. Toggle the phone offline, keep the Agents workspace visible, and confirm the
   shell shows a reconnecting or offline state while preserving the last
   hydrated bounded summary. Reconnect and refresh the thread.
10. Fully close and reopen the app. Confirm only bounded UI references restore,
    such as selected thread, review, preview, or terminal IDs. Thread snapshots,
    transcripts, terminal output, file contents, diffs, approval payloads,
    credentials, and launch tokens must reload from the gateway or remain absent.
11. Recheck Chat, Mission Control, Terminal, Apps, and Settings after the Agents
    pass.

### Evidence To Record

- Branch name, commit, device OS version, and whether the dev client was rebuilt
  or only Metro was reloaded.
- Exact automated commands and pass/fail results.
- Runtime preflight result with sanitized capability names and counts only.
- Manual phone-flow pass/fail notes with screenshots only when they do not show
  secrets, raw terminal output, file contents, diffs, or private infrastructure
  details.
- Any deferred manual step with the reason and the automated test that still
  covers the behavior.
