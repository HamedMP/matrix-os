# Implementation Plan: Mobile Shell

**Branch**: `075-mobile-shell` | **Date**: 2026-05-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/075-mobile-shell/spec.md`

## Summary

Build the phone-first Matrix shell on top of PR #99 (`feat(mobile): add app runtime experience`). PR #99 is now merged into this branch and provides the first mobile app launcher, app inventory client, app detail/runtime screens, WebView app frame, mobile app session-token bootstrap, and tests around app discovery helpers. The remaining 075 work should turn that baseline into the product-level mobile shell from the spec: launcher-first phone home, full-screen active app surfaces, explicit Canvas access, first-party mobile terminal sessions with resume/detach/end controls, safe error states, and mobile-specific validation.

## Technical Context

**Language/Version**: TypeScript strict, ES modules, Node.js 24+ for gateway; React 19, React Native 0.83, Expo Router 55 for mobile shell
**Primary Dependencies**: Hono gateway, Zod 4 via `zod/v4`, existing terminal stack (`node-pty`, `@xterm/xterm` on web), Expo Router, React Native WebView, Clerk Expo, AsyncStorage/SecureStore
**Storage**: Owner-controlled Matrix home files for shell/terminal session metadata (`~/system/terminal-sessions.json`, terminal layout files) plus existing owner Postgres where current workspace/app data already lives. No new embedded database or ORM.
**Testing**: Vitest for gateway/shell integration, Jest Expo for `apps/mobile`, existing pattern scanner, targeted mobile component/client tests
**Target Platform**: Phone-sized browser shell, native/Expo mobile app, and existing VPS-native gateway/runtime services
**Project Type**: Shell frontend plus mobile app plus gateway/runtime integration
**Performance Goals**: Launcher usable within 20 seconds after sign-in; app open transition under 1 second after inventory/session-token resolution on a healthy gateway; terminal reconnect state visible within 2 seconds of WebSocket close; terminal input submitted immediately to the open WebSocket without UI blocking
**Constraints**: No SSH keys for users; phone launcher is default on phone-sized surfaces; Canvas remains explicit access; all mutating endpoints need `bodyLimit`; external calls and mobile client fetches need finite timeouts; WebSocket messages require schema validation and ownership checks; no raw provider/internal errors in user-visible mobile states
**Scale/Scope**: One authenticated owner session per mobile client, up to the existing gateway cap of 10 live terminal sessions per owner runtime, up to 10 subscribers per terminal session, and cleanup through existing terminal TTL/eviction policy

## Existing Baseline From PR #99

PR #99 was incorporated by fast-forwarding this branch to `522e031c`.

Included baseline:

- `apps/mobile/app/(tabs)/apps.tsx` lists native and remote Matrix apps.
- `apps/mobile/app/runtime/[...slug].tsx` opens remote apps through a mobile session token.
- `apps/mobile/components/AppRuntimeFrame.tsx` embeds runtime apps in a full-screen WebView.
- `apps/mobile/lib/apps.ts` merges native app entries with gateway inventory and resolves native/runtime routes.
- `apps/mobile/lib/gateway-client.ts` calls `/api/apps`, `/api/apps/:slug/manifest`, and `/api/apps/:slug/session-token`.
- Gateway app runtime session endpoints and tests already exist around `/api/apps/:slug/session-token`.

Known gaps to close in 075 tasks:

- Mobile app launcher exists as a tab, but the spec needs it to be the phone default home and active-app surface in both `apps/mobile` and phone-sized `shell/` sessions.
- Runtime app state is not yet a durable mobile shell state model with last-active-app resume and safe unavailable-app fallback.
- Mobile Terminal is not yet a first-party phone experience with list/create-via-attach/resume/detach/end and special-key controls over the existing gateway terminal protocol.
- Mobile gateway client calls currently need hardening against 075 safety rules: timeouts, safe user-facing errors, bounded payload handling, and no silent catch paths.
- Canvas access is not yet specified as an explicit mobile shell surface with a reliable return-to-launcher path.
- PR #99's current CI baseline is not fully green: unit shards 1/4 and 2/4 fail in Symphony/workspace tests unrelated to the mobile runtime. Clear those before treating the merged baseline as review-ready.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Mobile shell state and terminal metadata stay in owner-controlled Matrix runtime state/files; app/workspace data remains in the existing owner data stores.
- **AI Is the Kernel**: PASS. This feature exposes shell and terminal surfaces; it does not bypass kernel routing for AI workflows.
- **Headless Core, Multi-Shell**: PASS. Mobile becomes a first-class renderer over existing gateway/app/terminal capabilities instead of moving core logic into the UI.
- **Defense in Depth**: PASS WITH REQUIRED TASKS. Auth, route validation, body limits, WebSocket schemas, finite timeouts, bounded registries, and safe errors must be explicit task outputs.
- **TDD**: PASS WITH REQUIRED TASKS. Remaining work starts with focused Jest/Vitest coverage for launcher defaulting, mobile app resume, terminal session lifecycle, WebSocket frame validation, and safe error behavior.
- **Quality Over Shortcuts**: PASS. The plan builds on the existing Expo/React Native app and Matrix gateway; no bare HTML or throwaway mobile shell.
- **Postgres/Kysely only for new persistence**: PASS. No new persistence engine is introduced.

## Project Structure

### Documentation (this feature)

```text
specs/075-mobile-shell/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── mobile-shell-api.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/mobile/
├── app/
│   ├── (tabs)/apps.tsx
│   ├── apps/[...slug].tsx
│   ├── runtime/[...slug].tsx
│   └── terminal/
├── components/
├── lib/
│   ├── apps.ts
│   ├── gateway-client.ts
│   └── mobile-shell-state.ts
└── __tests__/

shell/src/
├── components/
│   ├── Desktop.tsx
│   ├── AppViewer.tsx
│   ├── canvas/CanvasWindow.tsx
│   └── terminal/
├── hooks/
└── stores/

packages/gateway/src/
├── server.ts
├── auth.ts
├── session-registry.ts
└── app-runtime/

tests/gateway/
├── terminal-ws.test.ts
├── terminal-zellij-ws.test.ts
└── app-runtime-phase1.test.ts
```

**Structure Decision**: Keep native mobile-specific screens in `apps/mobile`, add phone-sized browser shell behavior in `shell/src`, reuse existing gateway app-runtime and terminal session registries, and avoid adding new terminal endpoints unless the existing `GET/DELETE /api/terminal/sessions` plus `/ws/terminal` attach protocol cannot satisfy the mobile UX.

## Phase 0: Research

See [research.md](./research.md).

## Phase 1: Design And Contracts

See [data-model.md](./data-model.md), [quickstart.md](./quickstart.md), and [contracts/mobile-shell-api.md](./contracts/mobile-shell-api.md).

## Phase 2: Task Generation Notes

Tasks should be generated as test-first vertical slices:

1. Clear the PR #99 CI regressions in the Symphony/workspace tests so the branch has a trustworthy baseline.
2. Harden PR #99 app discovery/runtime baseline with mobile client timeouts, safe errors, and tests.
3. Make the launcher the phone default home in both `apps/mobile` and phone-sized `shell/` sessions, then model active app/resume state.
4. Add explicit Canvas entry/exit behavior for mobile browser shell and native mobile entry points where available.
5. Add mobile terminal lifecycle client state and tests around the existing terminal REST list/delete endpoints and WebSocket attach/input/resize/detach/destroy protocol.
6. Add the terminal UI: session picker, full-screen terminal, special-key bar, reconnect/resume states.
7. Run review gates: `bun run check:patterns`, focused mobile Jest tests, focused gateway Vitest tests, and then broader typecheck/test gates when dependencies are installed.

## Complexity Tracking

No constitution violations are currently justified.
