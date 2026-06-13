# Implementation Plan: Electron macOS Shell ("Operator")

**Branch**: `094-electron-macos-shell` | **Date**: 2026-06-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/094-electron-macos-shell/spec.md`

## Summary

Build the Matrix OS desktop app as an Electron thin client over the per-user VPS gateway:
device-auth sign-in, kanban board, zellij terminal attach with sequence replay, parallel Hermes
agent threads, a SlayZone-style resizable panel workspace with instant stateful task switching,
embedded hosted shell + bridged Matrix apps, and keyboard-first polish. Architecture is
three-tier (trusted main process / bundled renderer / isolated remote embeds) with bearer-header
auth injected at the network layer so the renderer never holds the credential. Every
hard-won prototype behavior (auth-loop prevention, single-attach terminals, fatal
`session_not_found`, replay-gap acceptance, stale-while-revalidate board) is encoded as code +
tests, not lore. Full decisions: [research.md](./research.md).

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+ (Electron main), Chromium renderer
**Primary Dependencies**: Electron (stable), electron-vite, electron-builder, React 19, Tailwind v4, Zustand 5, @xterm/xterm + fit/search/webgl/serialize addons, monaco-editor, dnd-kit, cmdk, Radix primitives, lucide-react, zod/v4, electron-updater
**Storage**: None new server-side (owner Postgres via existing gateway routes is the source of truth). Local: `safeStorage`-encrypted credential + one atomic-write JSON store for profile/window/layout state (recreatable; FR-084)
**Testing**: Vitest (root `tests/desktop/`, pure-TS protocol/store/reducer units with fake sockets), Playwright `_electron` e2e against a stub gateway, react-doctor on renderer
**Target Platform**: macOS 14+ (Apple Silicon + Intel); core kept platform-clean behind a small platform layer (FR-093)
**Project Type**: Desktop client (new top-level `desktop/` workspace member)
**Performance Goals**: SC-001..SC-012 — board interactive ≤5s, terminal prompt ≤3s, keystroke echo ≤150ms p95, task switch ≤200ms perceived-instant, cold launch ≤3s, ≤1.5GB with 5 workspaces
**Constraints**: thin client only (no local PTY/DB of record); single live terminal socket per session; all caches bounded (LRU/TTL); no raw upstream errors in UI; bearer header auth on HTTP + WS
**Scale/Scope**: 6 user stories; ~15 renderer feature modules + trusted-core services; parity bar = 092 prototype (229 tests)

## Constitution Check

*GATE evaluated against Constitution v2.2.0 — PASS (re-checked post-design: PASS)*

| Principle | Verdict | Notes |
|---|---|---|
| I. Data belongs to owner | PASS | Zero new persistence; all reads/writes via existing gateway routes to owner Postgres/files. Local store holds only recreatable UI state; deleting the app loses no work (SC-008). |
| II. AI is the kernel | PASS | Hermes surfaces speak the existing `/ws` kernel protocol; no client-side AI logic. |
| III. Headless core, multi-shell | PASS | Operator is another shell over the same gateway; no app-private write paths (CLI/web parity is an explicit requirement, FR-015). |
| IV. Self-healing | N/A (client) | Crash recovery = relaunch restores from layout state + server data (spec failure modes). |
| V. Quality over shortcuts | PASS | Design-system bar defined (research R12); no throwaway UI. |
| VI. App ecosystem | PASS | Bridged apps load only through the existing session-token runtime (FR-062). |
| VII. Multi-tenancy | PASS | Runtime-slot selection respected on every surface (FR-005). |
| VIII. Defense in depth | PASS | Auth matrix in spec; zod-validated IPC boundary; origin-allowlisted embeds; bounded buffers; timeouts on all calls; generic errors. |
| IX. TDD | PASS | Protocol clients, reducers, stores all built test-first as pure TS; e2e via Playwright. Coverage target applies to `desktop/` logic modules. |
| X. Worktree/PR/Greptile | PASS | Work in manual worktree `094-electron-macos-shell`; PR split strategy below; macOS-track work stays local until owner approves push (standing instruction). |
| Tech constraints | PASS w/ note | Electron is a new runtime dependency — mandated by the spec ("user decision, not open question"). No SQLite/Drizzle anywhere. Docs deliverable included (Phase D). |

## Project Structure

### Documentation (this feature)

```text
specs/094-electron-macos-shell/
├── spec.md
├── research-prior-art.md   # lineage, lessons ledger, inspiration inventory
├── research.md             # Phase 0 decisions (this plan)
├── plan.md                 # this file
├── data-model.md           # Phase 1
├── contracts/
│   ├── gateway-contract.md # verified HTTP/WS contract the client consumes
│   └── ipc-contract.md     # renderer ↔ trusted-core message contract
├── quickstart.md           # Phase 1
└── tasks.md                # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)

```text
desktop/
├── package.json                 # workspace member; electron-vite scripts
├── electron.vite.config.ts     # main/preload/renderer builds
├── electron-builder.yml         # mac dmg/zip, hardened runtime, notarize, publish feed
├── tsconfig.json
└── src/
    ├── main/                    # TRUSTED CORE (Node)
    │   ├── index.ts             # boot: single-instance, window, services wiring
    │   ├── auth/
    │   │   ├── device-auth.ts   # device code+poll flow (pure logic, injected fetch)
    │   │   ├── credential-store.ts  # safeStorage blob, expiry
    │   │   └── header-injection.ts  # origin-scoped Authorization injection
    │   ├── net/gateway-request.ts   # main-side HTTP helper (timeouts, error mapping)
    │   ├── embeds/
    │   │   ├── embed-manager.ts     # WebContentsView lifecycle, bounds, LRU
    │   │   ├── app-session.ts       # cookie-pair handoff + Clerk cookie cleanup
    │   │   └── origin-policy.ts     # allowlist, window.open denial
    │   ├── ipc/
    │   │   ├── contract.ts          # zod schemas for every channel (shared w/ preload)
    │   │   └── handlers.ts          # ipcMain.handle registrations
    │   ├── persistence/local-store.ts   # atomic JSON store (profile/window/layouts)
    │   ├── notifications.ts         # native notifications + badge, coalescing
    │   ├── updates.ts               # electron-updater (no-op without feed)
    │   └── platform/               # mac-only bits isolated here (FR-093)
    ├── preload/index.ts             # contextBridge: typed, validated API only
    └── renderer/
        ├── index.html
        └── src/
            ├── App.tsx              # route: signin | mission-control
            ├── design/              # tokens.css, primitives (Button, Panel, …)
            ├── lib/
            │   ├── api.ts           # typed gateway client (fetch, timeouts, errors)
            │   ├── errors.ts        # one error mapper + display allowlist
            │   ├── chat.ts          # reducer (ported semantics from shell)
            │   ├── shell-socket.ts  # terminal WS client (protocol constants R3)
            │   ├── kernel-socket.ts # /ws multiplexed client + thread routing
            │   ├── session-merge.ts # L6 attachable merge rule
            │   └── terminal/        # themes, fonts (copied from shell, attributed)
            ├── stores/              # zustand per domain (L13)
            │   ├── connection.ts    # profile, runtime slot, auth status (no token)
            │   ├── board.ts         # projects/tasks SWR + optimistic mutations
            │   ├── sessions.ts      # merged attachable sessions
            │   ├── threads.ts       # agent threads, transcripts, statuses
            │   ├── workspace.ts     # open tasks, panel layouts, LRU
            │   └── settings.ts
            ├── features/
            │   ├── signin/          # device-flow UI
            │   ├── board/           # kanban, create-task dialog, context menu
            │   ├── terminal/        # TerminalView (xterm host), attach manager
            │   ├── threads/         # thread list, transcript, composer
            │   ├── workspace/       # panel strip, dividers, panel registry
            │   ├── editor/          # Monaco host, file tabs, conflict guard
            │   ├── git/             # branches/PRs/worktrees (read), diff later
            │   ├── files/           # file browser / quick-open
            │   ├── embeds/          # hosted-shell + app surfaces (bounds host)
            │   ├── settings/        # native settings sections
            │   └── palette/         # cmdk command palette
            └── main.tsx

tests/desktop/                       # root-convention vitest suites
├── device-auth.test.ts  shell-socket.test.ts  kernel-socket.test.ts
├── session-merge.test.ts  chat-reducer.test.ts  board-store.test.ts
├── errors.test.ts  ipc-contract.test.ts  layout-store.test.ts
├── app-session.test.ts  origin-policy.test.ts  …
tests/e2e/desktop/                   # Playwright _electron + stub gateway fixture
```

**Structure Decision**: new first-class `desktop/` workspace member (mirrors `shell/`),
electron-vite three-target layout; tests at root per repo convention with a `@desktop` vitest
alias. Trusted-core modules are framework-free where possible so Vitest covers them without an
Electron host.

## Delivery Phases (maps to user stories)

- **Phase A — Foundation + P1 (US1)**: scaffold, design tokens, trusted core (auth, store,
  header injection), sign-in, board (SWR + mutations + dnd), sessions merge, terminal
  (attach/replay/backoff/fatal/resize/ring), window chrome. Parity bar vs prototype.
- **Phase B — P2 (US2)**: kernel socket multiplexing, threads store + UI, composer,
  notifications + badge, abort.
- **Phase C — P3 (US3)**: panel strip + persistence, workspace LRU, editor (Monaco +
  conflict guard), file browser/quick-open, instant task switching (buffer cache).
- **Phase D — P4-P6 + polish**: git panel (read surfaces now; diff behind gateway delta),
  embeds (hosted shell + apps), settings, palette + shortcuts, updater wiring, docs page
  (`www/content/docs/`), e2e + screenshots, parity checklist (SC-013).

**PR strategy**: this exceeds the 3000-line limit by an order of magnitude. Split along phases
(A/B/C/D) as a Graphite-style stack when the owner approves pushing; until then, work stays
local on this branch with per-phase conventional commits (standing macOS-track instruction:
never push without explicit OK).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| New runtime dependency (Electron) | Spec-mandated rebuild target; needs Chromium cookie partitions, Playwright drivability, web-stack reuse | SwiftUI prototype already disproved platform fit (see research-prior-art §2); Tauri loses partition/CDP guarantees |
| Copy (not extract) of ~500 lines of shell lib code | Sharing now would couple web-shell releases to desktop churn mid-build | A shared package is a planned follow-up once the desktop surface stabilizes; copies carry source attribution headers |
