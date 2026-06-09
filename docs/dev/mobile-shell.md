# Mobile Shell

The 075 mobile shell work makes the phone experience launcher-first while keeping Canvas explicit and recoverable.

## Runtime Shape

- Browser phone viewport: `Desktop.tsx` switches to the mobile launcher after client-side viewport detection.
- Native Expo app: `apps/mobile/app/(tabs)/apps.tsx` is the primary launcher.
- Apps open full screen through `MobileAppSurface` in the browser shell and native runtime routes in Expo.
- Canvas is reachable through an explicit launcher action, not as the default phone home.
- Terminal uses Matrix-authenticated gateway sessions and WebSockets; users do not need SSH keys.

## State

Mobile resume state is intentionally small and validated before use.

- Browser shell state: `shell/src/stores/mobile-shell-store.ts`
- Native mobile state: `apps/mobile/lib/mobile-shell-state.ts`
- Current fields: mode, last active app slug, last active terminal session id, Canvas entry timestamp, update timestamp.

Do not persist raw paths, user-controlled URLs, or unvalidated terminal identifiers in mobile shell state.

## Terminal Validation

The mobile terminal path should be checked at three layers:

```bash
bun run test tests/gateway/terminal-ws.test.ts
pnpm --dir apps/mobile exec jest --runInBand __tests__/terminal-client.test.ts __tests__/terminal-state.test.ts __tests__/terminal-screen.test.tsx __tests__/TerminalControlBar.test.tsx
bun run test tests/shell/terminal-app-component.test.tsx
```

Manual terminal checks on a phone:

1. Open Terminal from Apps.
2. Create a new mobile Zellij session and confirm it opens with one borderless primary pane plus the compact Zellij bar.
3. Confirm the mobile action strip does not show pane splitting as a primary action.
4. Run `pwd`.
5. Use Tab, Escape, arrows, Control, paste, and font size controls.
6. Leave and reopen Terminal, then continue the running session.
7. End the session and confirm the resume card disappears or shows the safe recovery message.

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
