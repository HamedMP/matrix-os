# Tasks: Electron macOS Shell ("Operator")

**Input**: Design documents from `/specs/094-electron-macos-shell/`
**Prerequisites**: plan.md, research.md, data-model.md, contracts/, quickstart.md
**Convention**: TDD is mandatory (Constitution IX) — every logic module's test task precedes its
implementation task. Unit tests live in `tests/desktop/`; e2e in `tests/e2e/desktop/`. All paths
relative to repo root. `[P]` = parallelizable with neighbors.

## Phase 1: Setup

- [ ] T001 Scaffold `desktop/` workspace member: `desktop/package.json` (electron, electron-vite, electron-builder, react 19, zustand, tailwind v4, xterm + addons, monaco-editor, dnd-kit, cmdk, lucide-react, zod), `desktop/electron.vite.config.ts` (main/preload/renderer targets), `desktop/tsconfig.json` (strict ESM react-jsx), `desktop/src/main/index.ts` + `desktop/src/preload/index.ts` + `desktop/src/renderer/index.html` + `desktop/src/renderer/src/main.tsx` minimal boot; add `"desktop"` to `pnpm-workspace.yaml`; add `dev:desktop`/`build:desktop` scripts to root `package.json`; run `pnpm install` at root
- [ ] T002 [P] Design tokens and base styles in `desktop/src/renderer/src/design/tokens.css` + Tailwind v4 wiring (`desktop/src/renderer/src/design/index.css`): dark-first palette, 13px UI type ramp, 8px spacing grid, radius/border/elevation/focus-ring variables, titlebar drag-region utilities (research R12)
- [ ] T003 [P] Test wiring: add `@desktop` alias → `desktop/src` in root `vitest.config.ts`; create `tests/desktop/.gitkeep`; verify `npx vitest run tests/desktop` passes empty
- [ ] T004 [P] Copy attributed framework-free modules from shell: `desktop/src/renderer/src/lib/terminal/terminal-themes.ts`, `terminal-fonts.ts` (source headers pointing at `shell/src/components/terminal/*`)

## Phase 2: Foundational (blocking prerequisites)

- [ ] T010 [P] Tests for error mapper in `tests/desktop/errors.test.ts`: HTTP status→category mapping (401/404/5xx/timeout/network/misconfigured), display-boundary allowlist (300-char cap, path/db/provider marker rejection, generic copy per category)
- [ ] T011 [P] Implement error mapper in `desktop/src/renderer/src/lib/errors.ts` (single `AppError` enum + `toUserMessage()` display boundary; FR-080)
- [ ] T012 [P] Tests for IPC contract schemas in `tests/desktop/ipc-contract.test.ts`: every channel schema from contracts/ipc-contract.md accepts valid + rejects oversized/malformed/unknown payloads
- [ ] T013 [P] Implement IPC contract in `desktop/src/main/ipc/contract.ts` (zod schemas, channel name constants, request/response/event types — single source imported by main + preload)
- [ ] T014 [P] Tests for atomic local store in `tests/desktop/local-store.test.ts`: tmp+rename writes, schema-validated keys, bounded values, panel-layout pruning (90d), corrupt-file recovery
- [ ] T015 [P] Implement local store in `desktop/src/main/persistence/local-store.ts` (atomic JSON, typed keys: profile, windowBounds, lastProjectSlug, panelLayouts, appearance)
- [ ] T016 [P] Tests for device auth in `tests/desktop/device-auth.test.ts`: code request `{clientId:"matrix-os-desktop"}`, poll cadence (interval, +5s on 429), 428 pending, 410 expired, 200 token capture, expiresAt ms handling (injected fetch, fake timers)
- [ ] T017 [P] Implement device auth in `desktop/src/main/auth/device-auth.ts` (pure logic, injected fetch + clock) and credential store in `desktop/src/main/auth/credential-store.ts` (safeStorage encrypt/decrypt behind interface, expiry check trusts server 401s)
- [ ] T018 [P] Tests for trusted main-process network helpers: `tests/desktop/header-injection.test.ts` covers injection only for exact gateway origin (http+ws upgrades), never for embed partitions/foreign origins/subdomain confusion (`evil-app.matrix-os.com.attacker.tld`); `tests/desktop/gateway-request.test.ts` covers `desktop/src/main/net/gateway-request.ts` timeout (`AbortSignal.timeout` 10s), JSON parsing, auth/header forwarding, transport/HTTP error categorisation, and rejection of raw provider/path details
- [ ] T019 Implement header injection in `desktop/src/main/auth/header-injection.ts` (`webRequest.onBeforeSendHeaders` on renderer session only, origin-scoped; FR-002/003) and gateway HTTP helper in `desktop/src/main/net/gateway-request.ts` (AbortSignal.timeout 10s, error mapping)
- [ ] T020 Main boot in `desktop/src/main/index.ts`: single-instance lock (FR-092), BrowserWindow with `titleBarStyle:"hiddenInset"` + `contextIsolation:true, sandbox:true, nodeIntegration:false`, window-bounds restore/persist, IPC handler registration (`desktop/src/main/ipc/handlers.ts`), renderer CSP; preload bridge in `desktop/src/preload/index.ts` exposing exactly the typed contract as `window.operator`
- [ ] T021 [P] Tests for renderer API client in `tests/desktop/api-client.test.ts`: URL building with runtime slot (`?runtime=` only when ≠ primary), timeouts, JSON parsing, error category mapping
- [ ] T022 [P] Implement typed gateway client in `desktop/src/renderer/src/lib/api.ts` (projects/tasks/sessions/files/apps/git/system endpoints per contracts/gateway-contract.md)
- [ ] T023 App shell in `desktop/src/renderer/src/App.tsx`: auth-status routing (signin ↔ mission control), custom titlebar with drag region + connection/runtime status, `desktop/src/renderer/src/stores/connection.ts` (profile/runtime/auth status — no token), base layout (sidebar + content)

**Checkpoint**: app launches, shows sign-in, trusted core owns credential, all foundational suites green.

## Phase 3: User Story 1 — Connect and operate from mission control (P1) 🎯 MVP

- [ ] T030 [P] [US1] Sign-in feature in `desktop/src/renderer/src/features/signin/SignIn.tsx`: start device flow via `window.operator`, show user code + "open browser", poll states (pending/expired/authorized), error states; wire `auth:changed`
- [ ] T031 [P] [US1] Tests for board store in `tests/desktop/board-store.test.ts`: SWR (cached cards render, background refresh, skeleton only on first load — L11), column order [todo,running,waiting,blocked,complete], sort by order then id, archived hidden, serial per-task mutations, optimistic move with refetch-on-conflict, create/rename/archive/delete
- [ ] T032 [US1] Implement board store in `desktop/src/renderer/src/stores/board.ts` (projects + tasks SWR, optimistic mutations per FR-011/013)
- [ ] T033 [P] [US1] Tests for session merge in `tests/desktop/session-merge.test.ts`: zellij names attachable, workspace records only with `runtime.zellijSession`, orchestrator UUIDs excluded, alias map resolves `linkedSessionId` (L6 verbatim)
- [ ] T034 [P] [US1] Implement session merge in `desktop/src/renderer/src/lib/session-merge.ts` + sessions store in `desktop/src/renderer/src/stores/sessions.ts`
- [ ] T035 [P] [US1] Tests for terminal socket client in `tests/desktop/shell-socket.test.ts` (fake WS): attach URL with session/fromSeq/runtime, live-tail sentinel, seq tracking + resume lastSeq+1, backoff 0.5×2^n cap 30s jitter 0.5, fatal codes stop retries (L5), replay-evicted → clear+tail+gap marker (L8), resize coalescing 90/220/300/900ms (L7), input chunking ≤65536, ping/pong, generation guard (L9)
- [ ] T036 [US1] Implement terminal socket client in `desktop/src/renderer/src/lib/shell-socket.ts` (protocol constants from research R3; injectable WebSocket + timers)
- [ ] T037 [P] [US1] Tests for attach manager in `tests/desktop/attach-manager.test.ts`: single live socket per session app-wide (L4), detach snapshots buffer, LRU cap 8 cached buffers, focus restore without reload, scrollback ring 5000
- [ ] T038 [US1] Implement attach manager in `desktop/src/renderer/src/features/terminal/attach-manager.ts` + TerminalView in `desktop/src/renderer/src/features/terminal/TerminalView.tsx` (xterm host: themes/fonts from T004, fit/webgl/search/serialize addons, ended/fatal states with recreate CTA, gap marker UI)
- [ ] T039 [US1] Board UI in `desktop/src/renderer/src/features/board/`: `Board.tsx` (kanban columns, dnd-kit drag between statuses, card chips for priority/tags/linked session), `CreateTaskDialog.tsx` ("Create" ⌘⏎ / "Create + open" ⌘⇧⏎ per FR-012), `CardContextMenu.tsx` (status/priority/archive/delete), project switcher in sidebar
- [ ] T040 [US1] Task→terminal wiring: clicking a card with linked session opens its workspace view hosting TerminalView (attach via alias map); session list surface for standalone sessions; "start new session" recreate flow via `/ws/terminal?cwd=` auto-create
- [ ] T041 [US1] Stub gateway fixture in `tests/e2e/desktop/fixtures/stub-gateway.ts` (Hono: instant device approval, one project + tasks, fake zellij echo session implementing attach/output/seq/replay, kernel stream script) + Playwright e2e `tests/e2e/desktop/us1-signin-board-terminal.spec.ts`: sign-in → board renders → open task → terminal echo → kill socket → reconnect without duplicates; screenshots saved

**Checkpoint**: US1 fully functional — parity bar with SwiftUI prototype on auth/board/terminal.

## Phase 4: User Story 2 — Parallel agent threads (P2)

- [ ] T050 [P] [US2] Tests for chat reducer in `tests/desktop/chat-reducer.test.ts`: delta accumulation, tool-split bubbles, tool_start/tool_end transitions, abort marks running tools stopped, requestId isolation (port shell semantics + 092 cases)
- [ ] T051 [P] [US2] Implement chat reducer in `desktop/src/renderer/src/lib/chat.ts` (attributed port of `shell/src/lib/chat.ts`)
- [ ] T052 [P] [US2] Tests for kernel socket in `tests/desktop/kernel-socket.test.ts` (fake WS): connect with backoff, requestId→thread routing, session binding via kernel:init/session:switched, abort{requestId}, send queue while reconnecting, task:created/task:updated event fan-out, approval:request surfacing
- [ ] T053 [US2] Implement kernel socket in `desktop/src/renderer/src/lib/kernel-socket.ts` (one multiplexed `/ws` connection; subscriber registry with cleanup)
- [ ] T054 [P] [US2] Tests for threads store in `tests/desktop/threads-store.test.ts`: thread lifecycle statuses (running/needs-attention/done/failed/aborted), transcript cap 500, unread tracking, concurrent threads isolation, board refresh trigger on task events
- [ ] T055 [US2] Implement threads store in `desktop/src/renderer/src/stores/threads.ts`
- [ ] T056 [US2] Threads UI in `desktop/src/renderer/src/features/threads/`: `ThreadList.tsx` (sidebar with live status dots), `ThreadView.tsx` (transcript: markdown text bubbles, distinct tool activity entries, streaming indicator, abort button), `Composer.tsx` (global ⌘J overlay; optional task/session binding; submit creates thread visibly streaming ≤2s)
- [ ] T057 [P] [US2] Tests for notification coalescing in `tests/desktop/notifications.test.ts`: per-thread coalescing, bounded pending queue, focus suppression, badge count from needs-attention threads
- [ ] T058 [US2] Implement notifications in `desktop/src/main/notifications.ts` + renderer wiring: native Notification on done/failed/needs-attention while unfocused, click deep-links to thread (`notification:clicked`), dock badge (FR-070/071)
- [ ] T059 [US2] Playwright e2e `tests/e2e/desktop/us2-threads.spec.ts`: two scripted threads stream concurrently, switch between them, abort one, transcript integrity; screenshots

**Checkpoint**: agent cockpit works — parallel threads, notifications, abort.

## Phase 5: User Story 3 — Task workspace with resizable panels (P3)

- [ ] T070 [P] [US3] Tests for workspace store in `tests/desktop/workspace-store.test.ts`: open-task registry, LRU cap (8) releases sockets but keeps restorable state, panel layout persistence round-trip via state IPC, per-panel visibility/order/size updates, generation guard on rapid open A→B
- [ ] T071 [US3] Implement workspace store in `desktop/src/renderer/src/stores/workspace.ts`
- [ ] T072 [US3] Panel strip in `desktop/src/renderer/src/features/workspace/PanelStrip.tsx` + `PanelDivider.tsx`: percent sizing with per-panel minimums, drag-resize (pause heavy content during drag), toggle shortcuts (⌘1..⌘6), suspend-not-overlay keep-alive (L14), layout persists per task across restarts
- [ ] T073 [P] [US3] Tests for editor conflict guard in `tests/desktop/editor-save.test.ts`: stat-before-save compares mtime-at-load, conflict → warn (no silent overwrite), clean save updates baseline, dirty tracking
- [ ] T074 [US3] Implement editor in `desktop/src/renderer/src/features/editor/`: `EditorPanel.tsx` (Monaco bundled via vite workers, model per open file, tabs with dirty dots, find/replace, ⌘S save through conflict guard `editor-save.ts`)
- [ ] T075 [P] [US3] File browser + quick-open in `desktop/src/renderer/src/features/files/`: `FileTree.tsx` (lazy `/api/files/tree`), `QuickOpen.tsx` (⌘P, `/api/files/search`), open-in-editor wiring; paths only ever echoed from server responses (FR-042)
- [ ] T076 [US3] Instant task switching: buffer snapshot/restore integration across workspace store + attach manager; switch ≤200ms perceived (no remount of strip; terminals restore from serialized buffer; editors keep models)
- [ ] T077 [US3] Artifacts panel in `desktop/src/renderer/src/features/workspace/ArtifactsPanel.tsx` (previews via `/api/projects/{slug}/previews`, safe rendering, no arbitrary origins; processes panel deferred — no gateway endpoint, show explanatory empty state)
- [ ] T078 [US3] Playwright e2e `tests/e2e/desktop/us3-workspace.spec.ts`: open task A (run output, open file), open task B, A→B→A retains both terminal buffers + editor files, panel resize persists; screenshots

**Checkpoint**: the SlayZone-shaped workspace crux — instant stateful switching — is real.

## Phase 6: User Story 4 — Review and ship changes (P4)

- [ ] T085 [P] [US4] Tests for git store in `tests/desktop/git-store.test.ts`: branches/PRs/worktrees list parsing, refreshedAt staleness, worktree create (branch XOR pr), error mapping
- [ ] T086 [US4] Implement git store in `desktop/src/renderer/src/stores/git.ts` + git panel in `desktop/src/renderer/src/features/git/GitPanel.tsx`: branches/worktrees/PRs lists with status; diff pane placeholder gated on gateway delta (clear "coming with server support" state); worktree create flow scoping task terminal/editor cwd (FR-052)
- [ ] T087 [US4] "Ask agent to fix" in `desktop/src/renderer/src/features/git/ask-agent.ts`: from file/branch context → composer pre-filled with file path + instruction template (FR-053); PR-open action launches existing gateway/GitHub flow where available, else deep-link to repo compare URL via system browser

**Checkpoint**: review surfaces present; diff bodies + kill-by-name wait on gateway deltas per contract.

## Phase 7: User Story 5 — Full Matrix OS surfaces (P5)

- [ ] T090 [P] [US5] Tests for origin policy in `tests/desktop/origin-policy.test.ts`: launchUrl must be relative + resolve to gateway origin (reject `//`, absolute, traversal to foreign origin), embed navigation allowlist, window.open denial → system browser for https
- [ ] T091 [P] [US5] Tests for app-session handoff in `tests/desktop/app-session.test.ts`: BOTH cookies required (single-cookie response = failure — L2), multi-Set-Cookie parsing, stale Clerk cookie cleanup list (L3), one retry then auth-required state, native principal untouched on failure (L1)
- [ ] T092 [US5] Implement embeds in `desktop/src/main/embeds/`: `origin-policy.ts`, `app-session.ts` (net.request handoff + cookie install + cleanup), `embed-manager.ts` (WebContentsView per embed, `persist:hosted-shell` / `persist:app-<slug>` partitions, bounds sync from renderer, bounded live count with LRU suspension, no preload/IPC exposure)
- [ ] T093 [P] [US5] Tests for launch-token cache in `tests/desktop/launch-token.test.ts`: TTL `expiresAt-30s`, bounded LRU, transparent refresh
- [ ] T094 [US5] Renderer embed surfaces in `desktop/src/renderer/src/features/embeds/`: hosted-shell tab (Canvas) with inline re-auth prompt on `embed:state=auth-required`, app launcher grid from `/api/apps` with token-cached launch, bounds-reporting host panel
- [ ] T095 [US5] Native settings in `desktop/src/renderer/src/features/settings/`: sections account/runtime/appearance/system (native) + channels/integrations/billing/cron (gateway reads at web parity, FR-065); runtime switching drains+rebuilds sockets via `runtime:changed` (Integration Wiring rule)
- [ ] T096 [US5] Playwright e2e `tests/e2e/desktop/us5-embeds.spec.ts`: hosted-shell handoff against stub (both cookies set → ready; one cookie → auth-required, native session intact); app launch URL policy; screenshots

**Checkpoint**: one window for all of Matrix OS.

## Phase 8: User Story 6 — Keyboard-first command flow (P6)

- [ ] T100 [P] [US6] Command palette in `desktop/src/renderer/src/features/palette/CommandPalette.tsx` (cmdk ⌘K): tasks, projects, apps, files (via search), actions (new task, new thread, toggle panels, switch runtime, settings); recents ranking
- [ ] T101 [P] [US6] Native menu + shortcuts in `desktop/src/main/platform/menu.ts`: standard mac menus (App/File/Edit/View/Window), accelerators mirrored to renderer actions, full-screen/window conventions
- [ ] T102 [US6] Keyboard audit pass: focus rings everywhere, escape/light-dismiss consistency (UX guide), create+open shortcut, panel toggle chords, no-mouse US6 acceptance flow verified in e2e `tests/e2e/desktop/us6-keyboard.spec.ts`
- [ ] T103 [P] [US6] Deep-link/input validation tests in `tests/desktop/deep-link-validation.test.ts`: notification payloads, protocol URLs, file-drop paths, and command-palette external actions must accept only strict zod schemas, reject foreign origins/traversal/oversized payloads, and never focus a thread/task unless the validated id exists (FR-071/082)

## Phase 9: Polish & cross-cutting

- [ ] T109 [P] Updater tests in `tests/desktop/updater.test.ts`: no-op cleanly without feed, check/download/apply state transitions, download error recovery, listener cleanup across repeated checks, never force-restarts while attached work exists, and manifest/feed errors map to safe categories
- [ ] T110 [P] Updater in `desktop/src/main/updates.ts`: electron-updater generic provider behind feed-URL config, background download, apply-on-relaunch, never force-restarts attached work; no-op cleanly without feed (FR-091)
- [ ] T111 [P] Resource audit: verify every Map/Set/cache in desktop has cap+eviction (attach buffers 8, transcripts 500, token LRU, embed count, notification queue, layout pruning); add `tests/desktop/resource-caps.test.ts` asserting the constants module
- [ ] T112 [P] electron-builder config `desktop/electron-builder.yml`: mac dmg+zip targets, hardenedRuntime, entitlements file, notarize-when-credentialed, appId `com.matrix-os.operator`; local unsigned build verified
- [ ] T113 Run full gates: `bun run typecheck`, `bun run check:patterns`, `bun run test`, `npx react-doctor@latest desktop`, fix all findings
- [ ] T114 [P] Docs page `www/content/docs/desktop.mdx` (install, sign-in, board/terminal/threads/workspace, shortcuts) per documentation-driven development rule
- [ ] T115 Parity checklist vs SwiftUI prototype in `specs/094-electron-macos-shell/parity-checklist.md` (SC-013 items with verification evidence; prototype retires only when 100%)

## Dependencies

- Phase 1 → Phase 2 → US1 (Phase 3) → US2/US3 can interleave (US2 needs kernel socket only; US3 needs attach manager from US1) → US4 (needs US2 composer + US3 panels) → US5 (independent of US2-4, needs Phase 2) → US6 (needs all surfaces) → Polish.
- Parallel opportunities: within every phase, `[P]` test tasks fan out; US2 and US3 are independent after US1; US5 main-process work (T090-T093) can proceed parallel to US3/US4 renderer work.

## Implementation strategy

MVP = Phase 1-3 (US1). Ship value at every checkpoint; commit after each task or coherent task
pair (swarm rule: agents commit progress). PR split when pushing: A=Phases 1-3, B=Phase 4,
C=Phase 5, D=Phases 6-9 (Graphite stack; local-only until owner approves push).
