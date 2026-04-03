# Tasks: Desktop App — Native Cloud Client

**Input**: Design documents from `/specs/057-desktop-app/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included (Constitution VIII: TDD is NON-NEGOTIABLE)

**Organization**: Tasks grouped by user story mapped from spec implementation phases.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US7)
- Exact file paths included in all task descriptions

## User Story Map

| Story | Title | Priority | Spec Phase |
|-------|-------|----------|------------|
| US1 | Electron Scaffold + Cloud Shell | P1 (MVP) | Phase 1 |
| US2 | Native Chrome: Sidebar + Tab Bar | P1 | Phase 2 |
| US3 | Native Keybindings + IPC Bridge | P2 | Phase 3 |
| US4 | System Tray + Health Monitoring | P2 | Phase 3 |
| US5 | Container Management | P2 | Phase 4 |
| US6 | Auto-Update + Distribution | P3 | Phase 5 |
| US7 | Offline Mode | P3 | Phase 5 |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize the Electron app package in the monorepo with build tooling

- [ ] T001 Create `apps/desktop/` directory structure per plan.md project structure
- [ ] T002 Initialize `apps/desktop/package.json` with Electron 41.x, electron-vite 5.0.x, electron-builder 26.8.x, electron-updater 6.x, electron-store 10.x, @electron-toolkit/utils 4.x, @electron-toolkit/preload 3.x, vitest
- [ ] T003 [P] Create `apps/desktop/tsconfig.json` and `apps/desktop/tsconfig.node.json` with strict mode, ES modules, node16 module resolution
- [ ] T004 [P] Create `apps/desktop/electron.vite.config.ts` with three-target builds: main (externalizeDepsPlugin), preload (externalizeDepsPlugin), renderer (vanilla TS/CSS)
- [ ] T005 [P] Create `apps/desktop/electron-builder.yml` with macOS universal binary config, GitHub publish, DMG layout, notarize: true per spec Section 6
- [ ] T006 [P] Create `apps/desktop/build/entitlements.mac.plist` with JIT, unsigned-executable-memory, network.client entitlements per spec
- [ ] T007 [P] Create `apps/desktop/vitest.config.ts` configured for unit tests in `tests/unit/`
- [ ] T008 Add `apps/desktop` to root `pnpm-workspace.yaml` and run `pnpm install`

**Checkpoint**: `cd apps/desktop && pnpm exec electron-vite build` succeeds (empty app)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Typed store schema and shared types that all user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T009 Create shared types file `apps/desktop/src/main/types.ts` with Tab, AppEntry, ConnectionStatus, ConnectionState, ContainerStatus interfaces from data-model.md
- [ ] T010 [P] Implement typed electron-store schema in `apps/desktop/src/main/store.ts` with StoreSchema (tabs, activeTabId, sidebarPinned, sidebarExpanded, windowBounds) from data-model.md
- [ ] T011 [P] Create IPC channel constants in `apps/desktop/src/main/ipc-channels.ts` with INVOKE_CHANNELS and SEND_CHANNELS from contracts/ipc-bridge.ts
- [ ] T012 Write unit test `apps/desktop/tests/unit/store.test.ts` — store defaults, get/set tabs, get/set windowBounds, schema validation

**Checkpoint**: Store tests pass. Types importable. Channel constants defined.

---

## Phase 3: User Story 1 — Electron Scaffold + Cloud Shell (Priority: P1) MVP

**Goal**: App launches, user signs in via Clerk at `app.matrix-os.com`, shell loads in a BaseWindow+WebContentsView. Cmd+W closes the app.

**Independent Test**: Launch app -> sign-in page appears -> after auth, shell renders inside a WebContentsView.

### Tests for US1

- [ ] T013 [P] [US1] Write unit test `apps/desktop/tests/unit/tabs.test.ts` — createTab returns Tab with correct URL, closeTab removes from array, switchTab updates activeTabId, max 20 tab limit enforcement, duplicate tab creates new entry with same URL
- [ ] T014 [P] [US1] Write unit test `apps/desktop/tests/unit/platform.test.ts` — authenticatedFetch uses ses.fetch with correct URL, 5s timeout via AbortSignal, error response parsing

### Implementation for US1

- [ ] T015 [P] [US1] Implement tab manager in `apps/desktop/src/main/tabs.ts` — TabManager class with createTab (WebContentsView + load URL), closeTab (removeChildView + webContents.close), switchTab (remove old + add new + setBounds), getTabs, restoreFromStore, saveToStore. Max 20 tabs. URL pattern: `https://app.matrix-os.com/?app={slug}&desktop=1`
- [ ] T016 [P] [US1] Implement platform API client in `apps/desktop/src/main/platform.ts` — authenticatedFetch using ses.fetch with 10s timeout, fetchApps (GET /api/apps), fetchHealth (GET /health with 5s timeout)
- [ ] T017 [US1] Create main entry point `apps/desktop/src/main/index.ts` — BaseWindow (1200x800, titleBarStyle: hiddenInset), WebContentsView for content area, register IPC handlers for tab:create/close/switch/list, load initial URL or restore tabs from store, save window bounds on move/resize, app lifecycle (ready, window-all-closed, activate)
- [ ] T018 [US1] Create preload for WebContentsViews `apps/desktop/src/preload/index.ts` — contextBridge.exposeInMainWorld("matrixDesktop") with isDesktop, version, onShortcut, getConnectionInfo, requestUpgrade per contracts/ipc-bridge.ts MatrixDesktopAPI
- [ ] T019 [US1] Create minimal renderer shell `apps/desktop/src/renderer/index.html` + `apps/desktop/src/renderer/index.ts` — empty app shell HTML that will host sidebar and tab bar (placeholder divs for now)
- [ ] T020 [US1] Add dev and build scripts to `apps/desktop/package.json` — "dev": "electron-vite dev", "build": "electron-vite build", "package": "electron-builder --mac", "test": "vitest run", "test:coverage": "vitest run --coverage"
- [ ] T021 [US1] Handle Clerk auth flow — detect WebContentsView navigation to `/sign-in`, on initial launch load `https://app.matrix-os.com/` (Clerk redirects to sign-in if not authenticated), after auth, restore saved tabs or open default terminal tab

- [ ] T021b [US1] Implement auto-wake on launch in `apps/desktop/src/main/index.ts` — on app ready, check container status via platform.getContainerStatus(). If stopped, call platform.startContainer() and show "Waking up your instance..." in offline overlay until health returns connected

**Checkpoint**: `bun run dev` in apps/desktop launches Electron, Clerk sign-in works, shell renders in a WebContentsView. Tab unit tests pass. Stopped container auto-wakes on launch.

---

## Phase 4: User Story 2 — Native Chrome: Sidebar + Tab Bar (Priority: P1)

**Goal**: App launcher sidebar with app icons, tab bar above content area, drag-to-reorder, tab persistence across restarts.

**Independent Test**: Sidebar shows apps from /api/apps, click opens tab, tab bar shows open tabs, Cmd+1-9 switches, quit+relaunch restores tabs.

### Tests for US2

- [ ] T022 [P] [US2] Write unit test `apps/desktop/tests/unit/sidebar.test.ts` — renders app list from AppEntry[], click dispatches tab:create IPC, pin/unpin persists to store, drag reorder updates order

### Implementation for US2

- [ ] T023 [US2] Create native chrome preload `apps/desktop/src/preload/chrome-preload.ts` — contextBridge.exposeInMainWorld("electronAPI") with tab:create/close/switch/list, sidebar:getApps/setPinned/setExpanded, plus event listeners (onConnectionChanged, onTabsChanged, onAppsChanged) per contracts/ipc-bridge.ts ElectronAPI
- [ ] T024 [US2] Implement sidebar in `apps/desktop/src/renderer/sidebar.ts` — vertical icon list from electronAPI.sidebar:getApps(), click opens tab via electronAPI.tab:create(slug), divider between pinned/unpinned, bottom section (settings gear, upgrade arrow, connection dot), 64px collapsed / 200px expanded, drag-to-reorder with electronAPI.sidebar:setPinned()
- [ ] T025 [US2] Implement tab bar in `apps/desktop/src/renderer/tab-bar.ts` — horizontal tab strip from electronAPI.tab:list(), click switches via electronAPI.tab:switch(id), close button calls electronAPI.tab:close(id), "+" button shows app picker, drag to reorder, right-click context menu (Close, Close Others, Duplicate, Reload), active tab highlighted
- [ ] T026 [US2] Update `apps/desktop/src/renderer/index.html` and `apps/desktop/src/renderer/index.ts` — layout: sidebar (left) + tab bar (top) + content area, CSS for sidebar width transitions (64px/200px), load sidebar.ts and tab-bar.ts
- [ ] T027 [US2] Update `apps/desktop/src/main/index.ts` — add sidebar WebContentsView (left panel, loads local renderer), content WebContentsView area (right, managed by tab manager), resize handler to update setBounds for sidebar + active tab, register sidebar IPC handlers (sidebar:getApps calls platform.fetchApps, sidebar:setPinned/setExpanded updates store)
- [ ] T028 [US2] Add periodic app list refresh (60s interval) in `apps/desktop/src/main/index.ts` — fetch /api/apps, send apps-changed event to sidebar renderer, cache in memory
- [ ] T029 [US2] Add shell embedded mode detection — create `shell/src/hooks/use-desktop-mode.ts` (reads `desktop=1` query param + checks `window.matrixDesktop`), modify `shell/src/components/Desktop.tsx` to hide sidebar/dock/tab-bar when in desktop embedded mode

**Checkpoint**: Sidebar shows apps, clicking opens tabs in tab bar, Cmd+1-9 switches, quit+relaunch restores open tabs. Shell hides its own chrome when `?desktop=1`.

---

## Phase 5: User Story 3 — Native Keybindings + IPC Bridge (Priority: P2)

**Goal**: All keyboard shortcuts from spec Section 3 work natively. Cmd+K and Cmd+Shift+F forward to the active WebContentsView via IPC.

**Independent Test**: Cmd+T opens new tab, Cmd+W closes tab, Cmd+K opens command palette in shell, Cmd+1-9 switches tabs.

### Implementation for US3

- [ ] T030 [US3] Implement Electron Menu with accelerators in `apps/desktop/src/main/index.ts` — Cmd+T (new tab), Cmd+W (close tab), Cmd+1-9 (switch tab), Cmd+Shift+]/[ (next/prev tab), Cmd+, (settings), Cmd+R (reload active tab), Cmd+Q (quit), standard Edit menu (undo/redo/cut/copy/paste/select-all)
- [ ] T031 [US3] Implement shortcut forwarding in `apps/desktop/src/main/tabs.ts` — add forwardShortcut(action: string) method that sends "shortcut" event to active WebContentsView's webContents. Wire Cmd+K → "cmd-k", Cmd+Shift+F → "cmd-shift-f" via before-input-event on the BaseWindow (per SlayZone pattern)
- [ ] T032 [US3] Verify shell receives forwarded shortcuts — update shell's `use-desktop-mode.ts` hook to listen for `window.matrixDesktop.onShortcut()` and dispatch to command palette (cmd-k) and terminal search (cmd-shift-f)

**Checkpoint**: All keybindings from spec Section 3 table work. Cmd+K opens command palette inside the active WebContentsView.

---

## Phase 6: User Story 4 — System Tray + Health Monitoring (Priority: P2)

**Goal**: macOS menu bar tray icon with connection status (green/yellow/red), container info, quick actions. Health check polling every 30s with flap prevention.

**Independent Test**: Tray shows green dot when connected. Disconnect wifi -> tray goes red after 2 failures + notification. Reconnect -> green + notification.

### Tests for US4

- [ ] T033 [P] [US4] Write unit test `apps/desktop/tests/unit/health.test.ts` — state machine transitions: connected->unreachable after 2 failures, unreachable->connected on success, starting state on 503, consecutiveFailures counter, lastConnected timestamp updates, no notification on single failure (flap prevention)
- [ ] T034 [P] [US4] Write unit test `apps/desktop/tests/unit/tray.test.ts` — menu items reflect connection status text, menu rebuild on state change, container actions visible/hidden based on state

### Implementation for US4

- [ ] T035 [US4] Implement health check state machine in `apps/desktop/src/main/health.ts` — HealthMonitor class: 30s polling interval, 5s fetch timeout, 3-state machine (connected/starting/unreachable) per data-model.md, 2 consecutive failures before unreachable transition, emits state-change events, tracks lastConnected timestamp
- [ ] T036 [US4] Implement system tray in `apps/desktop/src/main/tray.ts` — Tray with template icon (monochrome), menu structure per spec Section 4 (Matrix OS header, handle, status, Open/New Terminal, Start/Stop/Upgrade Container, Check for Updates, About, Quit), updateMenu() method that rebuilds menu on connection state change. About item opens dialog with app version, container handle, and link to matrix-os.com
- [ ] T037 [US4] Wire health monitor to tray and renderer in `apps/desktop/src/main/index.ts` — start HealthMonitor on app ready, on state change: update tray menu, send connection-changed to native chrome renderer, show macOS Notification on transitions (connected->unreachable, unreachable->connected)
- [ ] T038 [US4] Create tray icon assets in `apps/desktop/build/` — Template.png (monochrome, 16x16 and 32x32 @2x) for macOS menu bar

**Checkpoint**: Tray shows in menu bar with correct status. Health polling works. Disconnect wifi -> red dot + notification after 2 failures.

---

## Phase 7: User Story 5 — Container Management (Priority: P2)

**Goal**: Start/stop/upgrade container from desktop app. New gateway endpoints proxy to platform API.

**Independent Test**: Tray -> Stop Container -> container stops. Start -> container wakes. Upgrade -> container restarts with new image.

### Tests for US5

- [ ] T039 [P] [US5] Write unit test for gateway container routes — test `tests/gateway/container-routes.test.ts`: POST /api/container/start returns 200 on success, POST /api/container/stop returns 200, POST /api/container/upgrade returns 200 with version info, GET /api/container/status returns ContainerStatus, 502 on platform unreachable, auth required (401 without cookie), never expose internal platform errors to client
- [ ] T040 [P] [US5] Write unit test `apps/desktop/tests/unit/platform.test.ts` (extend) — startContainer, stopContainer, upgradeContainer, getContainerStatus call correct endpoints, handle error responses, timeout handling

### Implementation for US5

- [ ] T041 [US5] Implement gateway container proxy routes in `packages/gateway/src/container-routes.ts` — Hono router with POST /api/container/start, POST /api/container/stop, POST /api/container/upgrade, GET /api/container/status. Each proxies to platform API using self-upgrade HMAC token (read CONTAINER_HANDLE + PLATFORM_URL + PLATFORM_SECRET from env). Auth via existing gateway auth middleware. 10s fetch timeout to platform. Per contracts/gateway-container.yaml
- [ ] T042 [US5] Mount container routes in `packages/gateway/src/server.ts` — import containerRoutes from container-routes.ts, app.route("/api/container", containerRoutes)
- [ ] T043 [US5] Extend platform client in `apps/desktop/src/main/platform.ts` — add startContainer(), stopContainer(), upgradeContainer(), getContainerStatus() methods using authenticatedFetch to /api/container/* endpoints
- [ ] T044 [US5] Wire container actions to tray menu in `apps/desktop/src/main/tray.ts` — Start/Stop/Upgrade menu items call platform client methods, show progress in tray menu text ("Upgrading..."), update status after completion
- [ ] T045 [US5] Wire container actions to sidebar in `apps/desktop/src/main/index.ts` — register IPC handlers for container:start/stop/upgrade/status, sidebar upgrade arrow visibility based on ContainerStatus.latestVersion !== imageVersion
- [ ] T046 [US5] Implement upgrade flow UX — on upgrade: show "Upgrading your instance..." in sidebar + tray, after container restart (health check returns connected), send notification "Upgrade complete", reload all WebContentsViews

**Checkpoint**: Stop/Start/Upgrade from tray and sidebar work. Gateway proxies to platform correctly. Upgrade reloads all tabs.

---

## Phase 8: User Story 6 — Auto-Update + Distribution (Priority: P3)

**Goal**: electron-updater checks GitHub Releases for app updates. CI pipeline builds, signs, notarizes, and publishes DMG.

**Independent Test**: Tag a release -> CI builds DMG -> download -> install -> app auto-checks for next update.

### Tests for US6

- [ ] T047 [P] [US6] Write unit test `apps/desktop/tests/unit/updater.test.ts` — dev mode skips update check, check interval is 4 hours, update-available triggers tray menu update, update-downloaded triggers notification, quitAndInstall called on install request

### Implementation for US6

- [ ] T048 [US6] Implement auto-updater in `apps/desktop/src/main/updater.ts` — initAutoUpdater(tray, nativeChromeView): skip in dev, autoInstallOnAppQuit=true, check on launch + every 4h, events: update-available (update tray + send to renderer), download-progress (send to renderer), update-downloaded (notification + tray + send to renderer). installUpdate() calls quitAndInstall. Per spec Section 6
- [ ] T049 [US6] Wire updater to main process in `apps/desktop/src/main/index.ts` — call initAutoUpdater after tray creation, register update:check and update:install IPC handlers
- [ ] T050 [US6] Create GitHub Actions CI workflow `.github/workflows/desktop-release.yml` — trigger on tag push `desktop-v*`, checkout, pnpm install, electron-vite build, electron-builder --mac --publish always. Secrets: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, CSC_LINK, CSC_KEY_PASSWORD, GH_TOKEN
- [ ] T051 [US6] Create `apps/desktop/dev-app-update.yml` for local update testing (provider: github, owner: HamedMP, repo: matrix-os)
- [ ] T051b [US6] Create download page at `www/content/docs/download/page.mdx` (or `www/src/app/download/page.tsx`) — detect OS via user-agent, show macOS DMG download button linking to latest GitHub Release, "coming soon" for Windows/Linux

**Checkpoint**: `electron-builder --mac` produces unsigned DMG locally. CI config ready (secrets need manual setup). Download page live at matrix-os.com/download.

---

## Phase 9: User Story 7 — Offline Mode (Priority: P3)

**Goal**: When cloud is unreachable, native overlay shows offline screen. Auto-recovers when connection restores.

**Independent Test**: Disconnect wifi -> offline overlay appears over WebContentsViews with "Your instance is unreachable" + Retry button. Reconnect -> overlay dismissed, tabs reload.

### Implementation for US7

- [ ] T052 [US7] Implement offline screen in `apps/desktop/src/renderer/offline.ts` — overlay div (positioned absolute over content area): Matrix OS logo, "Your instance is unreachable", "Last connected: {time ago}", Retry button (calls health check), Open Status Page button. Show/hide controlled by connection-changed event from main process
- [ ] T053 [US7] Wire offline overlay to health monitor in `apps/desktop/src/main/index.ts` — on connection-changed to unreachable: send event to native chrome renderer to show offline overlay. On connected: dismiss overlay, reload all WebContentsViews that failed to load
- [ ] T054 [US7] Handle session expiration in `apps/desktop/src/main/tabs.ts` — monitor WebContentsView navigation via webContents.on("did-navigate"), if URL matches /sign-in pattern, emit session-expired event, show sign-in view, after re-auth restore tabs

**Checkpoint**: Offline overlay shows/hides based on connection state. Session expiration detected and handled.

---

## Phase 10: Integration Tests

**Purpose**: End-to-end verification of cross-component flows. Constitution VIII mandates test coverage for integration paths.

- [ ] T062 [P] Write integration test `apps/desktop/tests/integration/auth.integration.test.ts` — fresh launch navigates to sign-in page, after Clerk auth WebContentsView loads shell with session cookie, session persists across app restart (mock Electron session)
- [ ] T063 [P] Write integration test `apps/desktop/tests/integration/tabs.integration.test.ts` — open app from sidebar creates WebContentsView with correct URL (`?app={slug}&desktop=1`), switch tabs shows/hides correct views, close tab destroys WebContentsView (webContents.close called), relaunch restores tabs from electron-store
- [ ] T064 Write integration test `apps/desktop/tests/integration/container.integration.test.ts` — start container via IPC calls gateway POST /api/container/start, stop transitions status, upgrade triggers reload of all WebContentsViews, health monitor state machine drives tray + offline overlay updates

**Checkpoint**: All integration tests pass. Full auth -> tabs -> container lifecycle verified.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Final quality, security, and documentation

- [ ] T055 [P] Validate URL construction security in `apps/desktop/src/main/tabs.ts` — app slugs validated against `/^[a-z0-9-]+$/`, URLs always constructed as `https://app.matrix-os.com/?app={slug}&desktop=1`, reject any slug that fails regex
- [ ] T056 [P] Add WebContentsView navigation restriction in `apps/desktop/src/main/tabs.ts` — webContents.on("will-navigate") blocks navigation outside `*.matrix-os.com`, webContents.setWindowOpenHandler blocks new-window requests to non-allowed origins
- [ ] T057 [P] Add window bounds persistence in `apps/desktop/src/main/index.ts` — save bounds to store on move/resize (debounced 500ms), restore on launch, handle maximized state
- [ ] T058 [P] Add splash screen in `apps/desktop/src/main/index.ts` — show branded splash (inline HTML) while initial WebContentsView loads, dismiss on readiness or 5s timeout (per SlayZone pattern)
- [ ] T059 Run all unit tests with coverage: `cd apps/desktop && bun run test:coverage`
- [ ] T060 Run quickstart.md validation: follow every step in `specs/057-desktop-app/quickstart.md` on a clean checkout
- [ ] T061 Manual verification: execute all 9 manual test scenarios from spec Section "Manual Verification"

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — MVP, do first
- **US2 (Phase 4)**: Depends on US1 (needs tab manager, main window)
- **US3 (Phase 5)**: Depends on US2 (needs sidebar + tab bar for shortcut targets)
- **US4 (Phase 6)**: Depends on US1 only (tray is independent of sidebar/keybindings)
- **US5 (Phase 7)**: Depends on US4 (needs health monitor + tray for container actions)
- **US6 (Phase 8)**: Depends on US1 only (updater is independent)
- **US7 (Phase 9)**: Depends on US4 (needs health monitor for offline detection)
- **Integration Tests (Phase 10)**: Depends on US1-US5 (all features under test)
- **Polish (Phase 11)**: Depends on all user stories + integration tests

### Parallel Opportunities

```
Phase 1 (Setup) ──► Phase 2 (Foundational) ──► Phase 3 (US1 MVP)
                                                    │
                                                    ├──► Phase 4 (US2) ──► Phase 5 (US3)
                                                    │
                                                    ├──► Phase 6 (US4) ──► Phase 7 (US5)
                                                    │                  └──► Phase 9 (US7)
                                                    │
                                                    └──► Phase 8 (US6)
```

After US1 completes, three independent tracks can run in parallel:
- **Track A**: US2 → US3 (sidebar/tabs → keybindings)
- **Track B**: US4 → US5, US7 (health/tray → container mgmt, offline)
- **Track C**: US6 (auto-update, fully independent)

### Within Each User Story

- Tests written FIRST, verified to FAIL
- Types/models before services
- Services before UI
- Core implementation before integration
- Story complete before moving to next priority

---

## Parallel Example: After US1 Completes

```bash
# Track A (native chrome):
Agent A: "Phase 4 US2 — sidebar + tab bar + shell embedded mode"

# Track B (system integration):
Agent B: "Phase 6 US4 — health monitor + system tray"

# Track C (distribution):
Agent C: "Phase 8 US6 — auto-updater + CI pipeline"
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US1 — Electron scaffold + cloud shell
4. **STOP and VALIDATE**: App launches, sign-in works, shell loads in WebContentsView
5. Demo-ready: basic cloud desktop client

### Incremental Delivery

1. Setup + Foundational → skeleton ready
2. US1 → App launches, shell loads (MVP)
3. US2 → Sidebar + tabs (native chrome, feels like a real app)
4. US3 → Keybindings (power user features)
5. US4 → Tray + health (system integration)
6. US5 → Container management (admin features)
7. US6 → Auto-update + CI (distribution)
8. US7 → Offline mode (resilience)
9. Polish → Security hardening, splash screen, manual verification

---

## Summary

- **Total tasks**: 67
- **US1 (MVP)**: 10 tasks (T013-T021b)
- **US2 (Sidebar/Tabs)**: 8 tasks (T022-T029)
- **US3 (Keybindings)**: 3 tasks (T030-T032)
- **US4 (Tray/Health)**: 6 tasks (T033-T038)
- **US5 (Container Mgmt)**: 8 tasks (T039-T046)
- **US6 (Auto-Update)**: 6 tasks (T047-T051b)
- **US7 (Offline)**: 3 tasks (T052-T054)
- **Setup + Foundational**: 12 tasks (T001-T012)
- **Integration Tests**: 3 tasks (T062-T064)
- **Polish**: 7 tasks (T055-T061)
- **Parallel tracks after MVP**: 3 independent tracks
- **Gateway changes**: 2 tasks (T041-T042) — new container proxy routes
- **Shell changes**: 1 task (T029) — embedded mode detection
