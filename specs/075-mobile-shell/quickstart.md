# Quickstart: Mobile Shell

## Baseline

PR #99 is merged into `075-mobile-shell`; the current mobile app already has app discovery and runtime routes.

PR #99 baseline cleanup for 075:

- CI Unit Tests (1/4) failed in `tests/shell/workspace-app.test.tsx` because the duplicate-session test compared a JSON request body as an order-sensitive string after the request payload gained `worktreeId`/`pr` preservation.
- CI Unit Tests (2/4) failed in `tests/shell/symphony-app-source.test.ts` because the guard expected the old `saveConfig` callback signature without the explicit `Promise<boolean>` return type.
- Fixed locally on 2026-05-12 and validated with:

```bash
bun run test tests/shell/workspace-app.test.tsx tests/shell/symphony-app-source.test.ts
```

Result: 2 test files passed, 10 tests passed.

## Local Setup

```bash
pnpm install
bun run dev:gateway
bun run dev:shell
pnpm --dir apps/mobile start
```

Use an authenticated Matrix session in both a phone-sized browser viewport and a mobile simulator/device. Production customer runtime remains VPS-native; do not use Docker as the production deployment path for this feature.

## Focused Validation

Run the mobile app tests that cover PR #99 helpers and the new 075 mobile shell behavior:

```bash
pnpm --dir apps/mobile test -- apps.test.ts gateway-client.test.ts
```

Run focused gateway terminal/app-runtime tests:

```bash
bun run test tests/gateway/app-runtime-phase1.test.ts tests/gateway/terminal-ws.test.ts tests/gateway/terminal-zellij-ws.test.ts
```

Foundation and US1 MVP validation on 2026-05-12:

```bash
pnpm --dir apps/mobile exec jest --runInBand __tests__/apps.test.ts __tests__/gateway-client.test.ts __tests__/mobile-shell-state.test.ts
bun run test tests/shell/mobile-shell.test.tsx tests/shell/mobile-shell-state.test.ts
bun run test tests/gateway/app-runtime-phase1.test.ts
```

Result: mobile Jest slice passed 3 suites / 39 tests; browser shell Vitest slice passed 2 files / 9 tests; gateway app-runtime contract passed 1 file / 12 tests.

Additional validation:

```bash
bun run typecheck
pnpm --dir shell exec tsc --noEmit
pnpm --dir apps/mobile exec tsc --noEmit
bun run check:patterns
git diff --check
```

Result: typecheck commands passed; pattern scanner reported 0 violations and existing warnings requiring manual review; diff whitespace check passed.

Live browser-shell hardening validation on 2026-05-13:

```bash
bun run test tests/shell/terminal-app-component.test.tsx tests/shell/mobile-shell.test.tsx tests/shell/user-button-hydration.test.tsx tests/shell/app-launch.test.ts tests/shell/app-viewer-slug.test.ts
pnpm --dir shell exec tsc --noEmit
bun run check:patterns
```

Result: browser shell Vitest slice passed 5 files / 21 tests; shell TypeScript check passed; pattern scanner reported 0 violations and existing warnings requiring manual review.

Live terminal and app-route smoke checks on 2026-05-13:

```bash
# Terminal WebSocket via shell preview
node -e '/* connect ws://127.0.0.1:4121/ws/terminal?cwd=projects, send attach, assert prompt includes ~/projects */'

# Runtime app route after app session minting
curl -sS -c /tmp/backgammon.cookies -b /tmp/backgammon.cookies -X POST http://127.0.0.1:4121/api/apps/backgammon/session
curl -sS -b /tmp/backgammon.cookies http://127.0.0.1:4121/apps/backgammon/
```

Result: terminal WebSocket connected, attached, and emitted `deploy@ubuntu-16gb-matrix-1:~/projects$`; Backgammon served built `assets/...` HTML. Detached preview terminal sessions were cleared when the gateway session cap was reached during smoke testing.

Native mobile terminal and Expo 54 validation on 2026-05-13:

```bash
pnpm --dir apps/mobile exec jest --runInBand
pnpm --dir apps/mobile exec tsc --noEmit
pnpm --dir apps/mobile install --lockfile-only
```

Result: native mobile Jest passed 19 suites / 145 tests; mobile TypeScript check passed; package manifest and root lockfile now resolve the mobile app on Expo SDK 54, React Native 0.81, and React 19.1. The first offline lockfile refresh lacked cached package metadata, so the lockfile-only refresh was rerun with registry access.

Terminal and browser-shell regression validation on 2026-05-13:

```bash
bun run test tests/gateway/terminal-ws.test.ts
bun run test tests/shell/terminal-app-component.test.tsx tests/shell/mobile-shell.test.tsx tests/shell/user-button-hydration.test.tsx tests/shell/app-launch.test.ts tests/shell/app-viewer-slug.test.ts
pnpm --dir shell exec tsc --noEmit
pnpm --dir apps/mobile exec tsc --noEmit
bun run typecheck
bun run check:patterns
git diff --check
```

Result: gateway terminal contract passed 1 file / 33 tests; browser shell slice passed 5 files / 21 tests; shell and mobile TypeScript checks passed; root typecheck passed; pattern scanner reported 0 violations with existing warnings requiring manual review; diff whitespace check passed.

Real mobile resume and Canvas validation on 2026-05-14:

```bash
pnpm --dir apps/mobile exec jest --runInBand __tests__/apps.test.ts __tests__/apps-screen.test.tsx __tests__/terminal-screen.test.tsx __tests__/canvas-entry.test.tsx __tests__/mobile-shell-state.test.ts
bun run test tests/shell/mobile-shell.test.tsx tests/shell/mobile-canvas.test.tsx tests/shell/mobile-shell-state.test.ts
```

Result: native mobile focused slice passed 5 suites / 27 tests; browser mobile shell and Canvas slice passed 3 files / 15 tests. These cover rendered launcher resume, terminal resume/recovery, native Canvas unavailable entry, explicit browser Canvas entry/return, stale Canvas pan/zoom reset, and persisted mobile state validation.

Final focused readiness validation on 2026-05-14:

```bash
pnpm --dir apps/mobile exec jest --runInBand
bun run test tests/shell/terminal-app-component.test.tsx tests/shell/mobile-shell.test.tsx tests/shell/mobile-canvas.test.tsx tests/shell/user-button-hydration.test.tsx tests/shell/app-launch.test.ts tests/shell/app-viewer-slug.test.ts
bun run test tests/gateway/terminal-ws.test.ts
pnpm --dir apps/mobile exec tsc --noEmit
pnpm --dir shell exec tsc --noEmit
bun run typecheck
bun run check:patterns
git diff --check
```

Result: native mobile Jest passed 21 suites / 151 tests; browser shell slice passed 6 files / 26 tests; gateway terminal contract passed 1 file / 33 tests; mobile, shell, and root TypeScript checks passed; pattern scanner reported 0 violations with 5 existing warning groups requiring manual review; diff whitespace check passed.

Full root suite status on 2026-05-13:

```bash
bun run test
```

Result: not green. Vitest completed with 396 files passed, 11 failed, 3 skipped; 4488 tests passed, 36 failed, 20 skipped. Failures were outside the focused 075 mobile-shell path:

- `tests/gateway/voice/tts/fallback.test.ts`: edge-tts mock expectations were not reached.
- `tests/platform/orchestrator.test.ts`: `getaddrinfo EAI_AGAIN db` while exercising platform database orchestration.
- `tests/gateway/sync/r2-client.test.ts`: AWS presigner mock path did not intercept `getSignedUrl`.
- `tests/integrations/actions.test.ts` and `tests/integrations/pipedream.test.ts`: live Pipedream SDK returned 401 `invalid_client`.
- `tests/mcp-browser/server.test.ts`: Playwright persistent-context mock expectations were not reached.
- Existing shell Canvas/Menu/Preferences/Workspace Canvas suites still hit a shared Zustand/React hook-dispatch test-runner issue when rendered directly in root Vitest.
- `tests/gateway/auth-jwt-cache.test.ts`: jose key-import error text/fixture behavior differs from the test expectation.

Run review gates before PR review:

```bash
bun run check:patterns
bun run typecheck
bun run test
```

## Manual Mobile Checks

1. Open Matrix on a phone-sized viewport after sign-in.
2. Confirm the launcher is the first usable phone shell surface.
3. Repeat the same entry check in the native mobile app when testing the Expo surface.
4. Open a native mobile screen from the launcher and return home.
5. Open a runtime app and confirm it fills the usable screen.
6. Refresh/background the mobile shell and confirm the last app is recoverable.
7. Open Terminal, create a session, send commands, detach, reload, resume, and intentionally end the session.
8. Send Escape, Tab, arrows, Control combinations, paste, and resize/font actions from the phone controls.
9. Enter Canvas explicitly and return to the launcher.
10. Force app/session failures and confirm only safe, generic recovery messages are shown.
