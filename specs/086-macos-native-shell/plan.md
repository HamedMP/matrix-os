# Implementation Plan: Matrix OS Native macOS App (Kanban-with-Terminals Shell)

**Branch**: `086-macos-native-shell` | **Date**: 2026-06-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/086-macos-native-shell/spec.md`

## Summary

Build a **native macOS (Swift 6 / SwiftUI) app** that renders the user's Matrix computer as a **Conductor-style, high-performance kanban board of terminals**. Each card is a Matrix **task** whose `linkedSessionId` binds it to a **zellij session** on the user's VPS. The card's Terminal panel attaches to that session over the existing gateway **shell WebSocket** (resume-from-seq capable); Shell and App panels embed the user's Canvas/Desktop and Matrix Apps via `WKWebView`.

**Critical finding from research**: the backend already exists. The gateway's `/api/projects/:slug/tasks` model is a full kanban (`status` = columns `todo|running|waiting|blocked|complete|archived`, plus `order`, `priority`, `parentTaskId`, `linkedSessionId`, `linkedWorktreeId`, `previewIds`), `/api/sessions*` manages session lifecycle (`startSession`, `observe`, `takeover`, `send`, `listSessions({taskId})`), `workspace-event-publisher.ts` already broadcasts `task.created/updated`, the shell WS supports scrollback + resume, Symphony is reachable via `symphony/proxy.ts`, and platform `customer-vps-routes` resolves per-VPS endpoints. **This feature is therefore backend-light and client-heavy** — the bulk of the work is the native Swift app plus a thin gateway delta (tags, terminal-tab plumbing, native WS header-auth, board-update subprotocol if not already covered) and the CLI/MCP surface.

## Technical Context

**Language/Version**: Swift 6.3 (strict concurrency), SwiftUI; gateway delta in TypeScript 5.5+ strict / Node 24 (existing stack).
**Primary Dependencies**: SwiftUI, `WKWebView`, `URLSessionWebSocketTask` (native WS), Swift Concurrency (`async`/`await`, actors), `SwiftTerm` (battle-tested VT100/xterm emulator for Swift) for terminal rendering, Keychain Services. No third-party kanban/DB libraries.
**Storage**: **None local-durable.** Board = user's Postgres via gateway. Credentials = macOS Keychain only. In-memory only: bounded board view + bounded scrollback buffers.
**Testing**: XCTest (unit + UI), Swift integration tests against a disposable test gateway/zellij; Vitest contract tests for any gateway delta (TDD, existing convention).
**Target Platform**: macOS 14+ (built with Xcode 26 / Swift 6.3); Apple Silicon primary.
**Project Type**: Native desktop client + thin server delta (the macOS app is a new top-level target; gateway changes live in `packages/gateway`).
**Performance Goals**: 60 fps board scroll/drag with 200+ cards; terminal keystroke-to-echo p95 ≤150 ms on broadband; board first-paint ≤5 s; smooth output rendering under high-throughput PTY streams via backpressure.
**Constraints**: Zero local durable user data (Constitution P1); thin client (no local PTY, no local DB); native WS auth via header (no token-in-URL); bounded memory across many open cards.
**Scale/Scope**: One user, one selected VPS at a time; boards up to a few hundred cards; up to a bounded number of simultaneously-live terminals/web views (offscreen cards suspended).

## Constitution Check

*GATE: passes.*

- **P1 Data Belongs to Its Owner**: PASS — no local durable user data; board in user's Postgres; sessions on VPS; only Keychain creds locally.
- **P3 Headless Core, Multi-Shell**: PASS — app is a renderer over existing gateway routes; adds no core logic the web shell lacks. (Elevates desktop to first-class shell per Principle III; offline support is a documented phased deferral, not a violation.)
- **P4 / VIII Defense in Depth (NON-NEGOTIABLE)**: PASS by design — principal-scoped authz on every call, input validation at route boundary, bounded resources/timeouts, sandbox preservation for embedded apps, no raw error leakage.
- **P5 / IX TDD (NON-NEGOTIABLE)**: PASS — every gateway delta and client networking/state component is specified test-first; integration checkpoints per story (T1).
- **P10 / X Worktree + PR + Greptile 5/5 (NON-NEGOTIABLE)**: in progress — work is on manual worktree `086-macos-native-shell`; ships via PR(s) with Greptile 5/5.

No violations → Complexity Tracking empty.

## Architecture: reuse map (spec → existing gateway)

| Spec capability | Existing gateway surface (reuse) | Net-new |
|---|---|---|
| Board columns + cards (FR-005/6/7/8) | `GET/POST/PATCH/DELETE /api/projects/:slug/tasks`; `status` enum = columns; `order`, `priority`, `parentTaskId` | **Tags** (not in `CreateTaskSchema`) — add optional `tags: string[]` to task schema + migration, or model as labels; confirm in data-model |
| Card ⇄ session link (FR-005/6) | task `linkedSessionId`; `/api/sessions` (`startSession`), `listSessions({taskId})`, `getSession` | none (already present) |
| Session lifecycle (FR-009) | `/api/sessions/:id/observe|takeover|send`; session orchestrator detach vs terminate | confirm "detach not destroy" semantics on archive |
| Terminal attach + scrollback + resume (FR-011/12/14) | shell WS via `createShellWsHandler` (`fromSeq`, `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ`, `SHELL_ATTACH_RECENT_REPLAY_EVENTS=50`, `ShellReplayBuffer.replayFromSeq`, `replay-evicted`) | **Native WS header auth** path (S1) + per-card **zellij tabs** (`listTabs`/`createTab`) UI |
| Live board updates (FR-008a) | `workspace-event-publisher.ts` (`task.created`, `task.updated`) + workspace events store; canvas WS shows the subscriber-hub pattern | **board-update subscription** for the native client if a task-events WS isn't already exposed; reuse bounded subscriber-hub pattern |
| Matrix Shell panel (FR-017) | user's Canvas/Desktop origin (`SHELL_ORIGIN`); existing Clerk/principal session | `WKWebView` host loading ONLY the user's own shell origin; auth handoff via a scoped session cookie for that origin — the principal **bearer token is never injected into web content** or exposed to any non-Matrix origin. Re-auth prompt on expiry. |
| Matrix App panel (FR-018) | `AppViewer` bridge contract (`window.MatrixOS`: `db.*`, `readData/writeData`, `proxyFetch`), sandboxed `srcdoc` | `WKWebView` that **loads the app through the user's shell-origin `AppViewer` URL** so the existing server-side bridge + sandbox serve it — do NOT re-implement `window.MatrixOS` or the sandbox in Swift (that would duplicate scope and risk a sandbox escape). Native side only hosts the web view and the panel chrome. |
| Symphony (FR-019/20) | `symphony/proxy.ts` gateway routes | read-model client + start/observe action wiring |
| CLI/MCP (FR-021/22) | existing `matrix` CLI + gateway routes above | `matrix board` command group + MCP server exposing board read/write under same principal |
| Endpoint resolution (W2) | platform `customer-vps-routes.ts`, `ws-upgrade.ts`, `/runtime` routing | native profile/endpoint resolver + multi-VM picker |

**Net-new backend is small.** Most server capability already exists; confirm each row during implementation before adding anything.

## Auth Matrix (resolves S2)

Native app authenticates to the **platform** (device-authorization flow, same as CLI) → obtains principal token → resolves the selected VPS gateway → all calls carry the principal.

| Surface | Method | Auth | Scope |
|---|---|---|---|
| Platform device auth / VPS resolution | HTTPS | Device-authorization → JWT | user account |
| `GET/POST/PATCH/DELETE /api/projects[...]/tasks` | HTTPS | `requireRequestPrincipal` (Authorization header) | `ownerScopeFromPrincipal` |
| `/api/sessions*` | HTTPS | `requireRequestPrincipal` | owner scope |
| Shell terminal WS (`createShellWsHandler` route) | WSS upgrade | **Authorization header / WS subprotocol** (S1 — NOT query token) → `requireRequestPrincipal(c)` (same pattern as canvas WS) | owner scope, session-name validated |
| Board-update subscription WS | WSS upgrade | Authorization header → principal | owner scope; bounded subscriber registry, TTL eviction, per-send isolation, dead-sender eviction |
| Symphony proxy routes | HTTPS/WSS | `requireRequestPrincipal` | owner scope |
| CLI/MCP board ops | HTTPS | same principal token (Keychain/CLI creds) | owner scope |

Every client-facing error returns a generic message; raw gateway/DB/provider/path text is never surfaced (FR-023).

## Data Model (delta only)

Source of truth = user's Postgres (existing `task-manager` tables). Card view model (client-side, in-memory, bounded):

- **Card** ← Task: `id, projectSlug, title, description?, status (column), priority, order, parentTaskId?, linkedSessionId?, linkedWorktreeId?, previewIds[], tags[]?, revision, updatedAt`.
- **Session** ← zellij/session orchestrator: `name/id, status (active|exited), cwd, layout, tabs[]`.
- **Panel** (client-only): `.terminal | .shell | .app(appSlug)`.
- **ConnectionProfile** (client-only, Keychain-backed): `handle, gatewayEndpoint, selectedVpsId, credentialRef`.

Net-new persistence: at most an optional `tags` column on tasks (migration via Kysely, owner Postgres) if labels are in scope for v1; otherwise deferred. **No new embedded DB.** Optimistic concurrency uses the task `revision`/`updatedAt` already present; writes enforce concurrency in the UPDATE (per CLAUDE.md atomicity rules).

## UI/UX & Performance Design (Conductor-style, zellij-native)

The board is the product. Targets a **Conductor AI** feel — parallel agent lanes, each card a live worktree/agent — fused with Matrix's zellij sessions.

- **Native performance**: SwiftUI `LazyVGrid`/`LazyHStack` columns with view recycling; cards are lightweight value-type view models; drag-and-drop via native `Transferable`/drop delegates (no web DnD jank); diffable updates from workspace events; off-main-thread decoding of terminal output with coalesced UI flushes (target 60 fps with 200+ cards).
- **Zellij integration depth**: card surfaces session status (active/exited), tabs map to zellij tabs (`listTabs`/`createTab`), layout awareness; "new terminal" on a card = new zellij tab; detach vs terminate is explicit; live session badges driven by workspace events.
- **Conductor-like flows**: columns reflect agent lifecycle (`todo → running → waiting → blocked → complete`), per-card live activity/diff/PR affordances (reuse `linkedWorktreeId`, `previewIds`), quick "start agent in worktree" from a card.
- **Suspension model (R1)**: only focused/visible cards hold a live WS + web view; offscreen cards render a static last-frame snapshot and reattach on focus — bounded aggregate sockets/memory.
- **Design language**: produced via the **frontend-design skill** (see `design.md`): distinctive, non-generic macOS aesthetic — depth, materials/vibrancy, typography, motion, dark-first to match the shell. Honors `specs/ux-guide.md` (toggle consistency, no layout shift, spatial memory across reloads, empty-states-as-onboarding).

## Project Structure

### Documentation (this feature)

```text
specs/086-macos-native-shell/
├── plan.md            # this file
├── spec.md
├── research.md        # gateway-reuse findings, SwiftTerm/WS decisions
├── data-model.md      # task/session/panel view models + tags delta
├── design.md          # frontend-design output: macOS UI system
├── contracts/         # auth-matrix.md, gateway endpoints used, WS protocols
└── tasks.md           # /speckit.tasks output
```

### Source Code (repository root)

```text
macos/                         # new top-level native app target
├── MatrixOS.xcodeproj / Package.swift
├── Sources/
│   ├── App/                   # @main, window/scene, profile/onboarding
│   ├── Board/                 # kanban: columns, cards, DnD, virtualization
│   ├── Terminal/              # SwiftTerm view + shell WS client (resume-from-seq)
│   ├── Panels/                # Shell (WKWebView) + App (bridge) hosts
│   ├── Symphony/              # run read-model + controls
│   ├── Net/                   # gateway HTTP client, WS client, principal/Keychain
│   └── Model/                 # Card/Session/Panel/Profile view models
└── Tests/                     # XCTest unit + UI + integration

packages/gateway/              # thin delta only (TDD-first)
├── src/...                    # tags on task schema (if in scope), native WS header-auth confirm, board-update sub if needed
└── (tests under repo-root tests/gateway per convention)

packages/cli (or existing matrix CLI) + MCP server   # `matrix board` commands + MCP board tools
```

**Structure Decision**: New top-level `macos/` Swift package/Xcode target (keeps GPL/native concerns isolated from the TS monorepo build; not part of pnpm/turbo). Gateway delta stays in `packages/gateway`. CLI/MCP extends the existing `matrix` surface.

## Phasing (mapped to prioritized user stories)

- **Phase 0 — Research** (`research.md`): confirm shell WS route path + header-auth acceptance; confirm session detach-vs-terminate; confirm task-events WS exposure; SwiftTerm vs hand-rolled VT decision; platform endpoint-resolution contract. *(De-risks F1/W1/W2/W3/S1.)*
- **Phase 1 — P1 MVP (terminal)**: profile/device-auth + Keychain; VPS resolve; board renders from `/api/projects/:slug/tasks` (read); open card → SwiftTerm attaches to `linkedSessionId` via shell WS with scrollback + resume; input/resize. Integration test: attach to a real test zellij session, round-trip I/O.
- **Phase 2 — P2 board CRUD + live**: create/move/reorder/rename/tag/archive via task routes (write, revision-guarded); subscribe to workspace events for <2 s propagation; session create on new card; detach-on-archive. Integration test: two clients converge.
- **Phase 3 — P3 Shell panel**: `WKWebView` host loading the user's Canvas authenticated (cookie/token handoff), re-auth on expiry.
- **Phase 4 — P4 App panel**: bridge-injecting `WKWebView` reproducing `window.MatrixOS` + sandbox; block un-bridged fetch.
- **Phase 5 — P5 Symphony**: run read-model on cards + start/observe via symphony proxy.
- **Phase 6 — P6 CLI/MCP**: `matrix board` commands + MCP board tools under the same principal.

Each phase = its own PR (size-limited per CLAUDE.md), each with an integration-test checkpoint (T1), each gated on Greptile 5/5.

## Failure Modes & Resource Management (design)

- **Timeouts**: every gateway HTTP call uses a bounded `URLSession` timeout; WS connect/reconnect uses capped exponential backoff.
- **Reconnect (F1)**: terminal tracks last applied `seq`; on reconnect attaches with `fromSeq = lastSeq + 1`; on `replay-evicted` it clears and refetches a live tail (no silent gap/dup).
- **Concurrency**: task writes are revision/`updatedAt`-guarded in the UPDATE; session create idempotent; losing client refreshes.
- **Subscriber registry (W1/C1)**: bounded, TTL/stale eviction, per-subscriber send isolation, dead-sender eviction (mirror canvas hub).
- **Resource caps (R1)**: scrollback buffers capped + evicted; aggregate live-attach/web-view cap with offscreen suspension; web views released on panel close; all timers cleared on teardown.
- **Error policy**: no silent catches; failed create/attach/load sets a visible generic error + recovery; misconfiguration (no VPS) distinguished from not-found and from transient connectivity.

## Plan obligations from review-spec (status)

| ID | Obligation | Resolution in plan |
|---|---|---|
| S1 | Native WS header auth | Auth matrix mandates Authorization header/subprotocol on WS; canvas WS confirms pattern. |
| S2 | Explicit auth matrix | Provided above. |
| W1/C1 | Board-update channel + bounded subscriber registry | Reuse workspace events + subscriber-hub pattern; add native sub only if not exposed. |
| W2 | VPS endpoint resolution | Platform `customer-vps-routes`/`/runtime`; native resolver + multi-VM picker. |
| W3 | Symphony source | `symphony/proxy.ts` gateway routes. |
| F1 | Reconnect resume semantics | Confirmed shell WS `fromSeq` support; client tracks last seq, handles `replay-evicted`. |
| T1 | Integration-test checkpoints | One per phase exercising client↔gateway↔zellij. |
| R1 | Aggregate resource cap | Offscreen suspension + bounded live attaches/web views. |
| A1 | Offline deferral vs Principle III | Documented phased deferral; v1 keeps thin-client invariant. |

## Complexity Tracking

*No constitution violations; section intentionally empty.*
