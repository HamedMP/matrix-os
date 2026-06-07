# Feature Specification: Matrix OS Native macOS App (Kanban-with-Terminals Shell)

**Feature Branch**: `086-macos-native-shell`
**Created**: 2026-06-05
**Status**: Draft
**Input**: Native macOS (Swift/SwiftUI) desktop app for Matrix OS in the SlayZone "kanban-with-terminals" UX. Each kanban card maps to a Matrix zellij session on the user's VPS (card ⇄ session ⇄ task). Card panels: Terminal (attach to the card's zellij session over the gateway shell WebSocket), Matrix Shell (embedded Canvas/Desktop), Matrix App (MatrixOS bridge). Thin remote client — no local persistence DB and no local PTY. Connects to the user's Matrix shell and Symphony orchestrator. Keep a Matrix-targeted CLI/MCP control surface.

## Overview

Matrix OS is headless-core, multi-shell (Constitution Principle 3). Today the primary renderer is the web Canvas/Desktop shell served from the user's VPS. This feature adds a **native macOS desktop app** as a first-class additional shell, presenting the user's Matrix computer as a **kanban board of terminals** (inspired by SlayZone's "Card → Terminal → Agent" UX).

The app is a **thin remote client**: it owns no durable data and spawns no local terminal processes. Every card is backed by a **zellij session on the user's VPS**, every terminal is a live attach to that session over the existing gateway shell WebSocket, and all board metadata lives in the **user's own Postgres** via gateway routes. The app is therefore fully aligned with Constitution Principle 1 (Data Belongs to Its Owner): deleting the app leaves zero user data on the local machine.

A card exposes three interchangeable panels onto the same Matrix computer: a **Terminal** (the card's zellij session), the **Matrix Shell** (the user's Canvas/Desktop, embedded), and a **Matrix App** (loaded through the MatrixOS app bridge). The board also surfaces the **Symphony** orchestrator so multi-agent runs are visible and controllable where the work happens.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect to my Matrix computer and work in a terminal (Priority: P1)

A Matrix OS user installs the macOS app, signs in with their existing Matrix identity, and immediately sees their VPS's live zellij sessions rendered as cards on a board. Opening a card attaches a terminal to that session: prior output replays as scrollback, and keystrokes drive the real session on the VPS (where Claude Code / Codex / shells already run).

**Why this priority**: This is the irreducible MVP. It proves the entire thin-client thesis — native UI, remote zellij, no local PTY, no local DB — in a single working card. Without it nothing else matters; with it the user already has a usable native terminal client for their Matrix computer.

**Independent Test**: Sign in, confirm the board lists the same sessions as `matrix` shell session list on the VPS, open one card, observe scrollback replay, type a command, and verify it executes in the real VPS session (visible from another attach).

**Acceptance Scenarios**:

1. **Given** a signed-in user whose VPS has ≥1 active zellij session, **When** the board loads, **Then** each active session appears as exactly one card with its session name and status.
2. **Given** a card backed by an active session, **When** the user opens it, **Then** recent session output replays as scrollback and the terminal reaches an interactive prompt without the user spawning anything locally.
3. **Given** an attached terminal, **When** the user types a command and presses return, **Then** the command executes in the VPS session and output streams back in order.
4. **Given** an attached terminal, **When** the user resizes the window, **Then** the remote session's dimensions update so output wraps correctly.
5. **Given** no VPS is provisioned for the account yet, **When** the user signs in, **Then** the app shows an onboarding empty state (not an error) explaining how to create a Matrix computer.

---

### User Story 2 - Organize work as a board that persists across my devices (Priority: P2)

The user creates, renames, moves between columns, tags, and archives cards. Each new card provisions a backing zellij session; board layout (column, order, title, tags) is stored in the user's Postgres through the gateway, so the same board appears identically on the web shell and on another Mac, and survives app restarts.

**Why this priority**: Turns a flat session list into an actual task board — the core SlayZone value. Depends on P1's connection but is independently demonstrable and is what makes the app a workspace rather than a terminal multiplexer.

**Independent Test**: Create a card in column "Doing", reload the app, confirm it persists in the same column; open the web shell or a second device and confirm the same card/column/order is present; archive it and confirm it disappears from the active board on both.

**Acceptance Scenarios**:

1. **Given** the board, **When** the user creates a card with a title, **Then** a backing zellij session is created and the card is stored with its column, order, title, and timestamp.
2. **Given** an existing card, **When** the user moves it to another column or reorders it, **Then** the new position persists and is reflected on other connected clients within a short interval.
3. **Given** a card, **When** the user renames or tags it, **Then** the metadata persists without affecting the backing session's identity.
4. **Given** a card, **When** the user archives it, **Then** it leaves the active board, its backing session is detached (not destroyed) unless the user explicitly chooses to terminate it, and the choice is recorded.
5. **Given** two devices editing the same card concurrently, **When** both submit changes, **Then** the system resolves with revision-based concurrency without corrupting the board, and the losing client is refreshed rather than silently overwritten.

---

### User Story 3 - Open my Matrix Shell inside a card (Priority: P3)

From any card the user can switch the panel from Terminal to **Matrix Shell**, embedding their own Canvas/Desktop experience (file browser, apps, chat) authenticated as themselves, without leaving the native board.

**Why this priority**: Gives the native app full Matrix reach (not just terminals) by reusing the existing web shell, with minimal new surface. Valuable but layered on top of the P1/P2 core.

**Independent Test**: Open a card, switch to the Shell panel, confirm the user's real Canvas shell loads already-authenticated and that opening a file or app there works the same as in a browser.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they select the Shell panel on a card, **Then** their Canvas/Desktop shell loads authenticated as them (no second login).
2. **Given** the Shell panel is open, **When** the user interacts with it (open file, switch app), **Then** it behaves identically to the web shell.
3. **Given** an unauthenticated or expired session, **When** the Shell panel attempts to load, **Then** the user is prompted to re-authenticate rather than shown a broken page.

---

### User Story 4 - Run a Matrix App inside a card (Priority: P4)

The user pins a specific Matrix App (e.g. a kanban app, a notes app, a game) as a card's panel. The app runs through the MatrixOS app bridge with the same data access it has in the web shell (owner Postgres, KV, allowlisted external fetch).

**Why this priority**: Lets a card *be* an app, not just a terminal or whole shell — closing the loop on "open apps in the native app." Depends on the shell-embedding plumbing from P3.

**Independent Test**: Pin a known Matrix App to a card, confirm it loads through the bridge and can read/write its owner data exactly as in the browser, and that it cannot make un-bridged network calls.

**Acceptance Scenarios**:

1. **Given** the user selects an installed Matrix App for a card, **When** the App panel loads, **Then** the app renders through the bridge and can use its normal data APIs.
2. **Given** an App panel, **When** the app attempts a direct (un-bridged) network call, **Then** it is blocked exactly as in the sandboxed web shell.
3. **Given** an App panel, **When** the user switches back to Terminal, **Then** the app state is suspended/closed cleanly and the terminal reattaches.

---

### User Story 5 - See and steer Symphony runs from the board (Priority: P5)

When the user runs the Symphony orchestrator on the VPS, related cards show run status and agent activity, and the user can start/observe an orchestrated run from the board.

**Why this priority**: Connects the native app to the multi-agent control plane, making the board the cockpit for agent work. Highest-value once terminals + board exist, but explicitly after them.

**Independent Test**: Trigger a Symphony run on the VPS, confirm the corresponding card(s) reflect run state and agent turns, and that starting a run from the board produces the same result as starting it from the VPS.

**Acceptance Scenarios**:

1. **Given** an active Symphony run, **When** the user views the board, **Then** affected cards display current run status and recent agent activity.
2. **Given** the board, **When** the user starts an orchestrated run from a card, **Then** the run begins on the VPS and the card reflects progress.
3. **Given** a Symphony run finishes or fails, **When** the user views the card, **Then** the terminal/status accurately reflects the terminal state.

---

### User Story 6 - Control the board from any terminal (CLI/MCP) (Priority: P6)

A Matrix-targeted CLI command set and MCP server let agents and power users read board context and create/update/move cards from inside any terminal session — the native analogue of SlayZone's `slay`.

**Why this priority**: Lets agents running in the cards manage the board itself (self-organizing work), and gives scriptable parity. Useful but strictly additive on top of the board's existence.

**Independent Test**: From a terminal, list the board, create a card, move it, and confirm the native app reflects each change live; from an agent via MCP, update a card's status and confirm propagation.

**Acceptance Scenarios**:

1. **Given** a signed-in CLI, **When** the user lists/creates/moves cards, **Then** the same gateway/Postgres state changes and the native app updates live.
2. **Given** an MCP-connected agent, **When** it reads board context, **Then** it receives the current cards/columns/tags for the authorized board only.
3. **Given** an MCP write, **When** an agent moves or updates a card, **Then** the change is authorized against the same principal rules as the UI and is reflected everywhere.

---

### Edge Cases

- **Gateway unreachable / VPS asleep**: board shows a clear reconnecting state; no crash; auto-retry with backoff; last-known board view shown read-only with a staleness indicator (view only — never written locally as durable data).
- **WebSocket drop mid-session**: terminal auto-reconnects, re-attaches, and replays scrollback from the last acknowledged sequence; no duplicated or lost output beyond the documented replay window.
- **Backing zellij session exited/killed externally**: card marks the session as exited, offers re-create or archive; terminal shows the exit cleanly rather than hanging.
- **Token expired / revoked**: any in-flight request or WS surfaces a re-auth prompt; no silent failure; no leaking of raw gateway errors.
- **Concurrent board edits from web shell + native app + CLI**: resolved by revision-based concurrency; the losing client refreshes rather than overwriting.
- **No VPS provisioned**: onboarding empty state, not a 404/error.
- **Very large scrollback / fast output**: terminal buffer is capped; rendering stays responsive; backpressure prevents unbounded memory growth.
- **Multiple Matrix computers (VMs) on one account**: user can select which VPS/board the app targets; switching is explicit and does not mix sessions.
- **Offline launch**: app opens to a clear disconnected state; no destructive assumptions; reconnects when network returns.

## Requirements *(mandatory)*

### Functional Requirements

**Connection & Identity**

- **FR-001**: The app MUST authenticate the user with their existing Matrix identity using the same device-authorization/token flow as the Matrix CLI, with no app-specific account.
- **FR-002**: The app MUST let the user select which of their Matrix computers (VPS endpoints) to connect to when more than one exists, and remember the last selection.
- **FR-003**: The app MUST store credentials only in the macOS secure credential store (Keychain) and MUST NOT persist any board, terminal, or app data to local durable storage.
- **FR-004**: The app MUST function against any user's VPS purely by resolving the user's handle/endpoint — no hardcoded environment assumptions.

**Board ⇄ Sessions**

- **FR-005**: The app MUST render the user's VPS zellij sessions as cards, one card per session, showing name and live status (active/exited).
- **FR-006**: The app MUST let the user create a card, which MUST provision a backing zellij session on the VPS.
- **FR-007**: The app MUST persist board metadata (column, order, title, tags, archived state, session reference) in the user's Postgres via gateway routes, and MUST NOT store it locally as the source of truth.
- **FR-008**: The app MUST let the user move, reorder, rename, tag, and archive cards, with changes persisted and propagated to other connected clients.
- **FR-008a**: Board changes MUST be propagated to other connected clients via a server-pushed update channel (not client polling) so SC-005's propagation target is met. The server-side subscriber registry MUST be bounded with TTL/stale-connection eviction, isolate per-subscriber send failures, and evict dead senders — per the Matrix realtime-subscriber rules. *(Plan obligation W1/C1: define this channel; it is net-new alongside the board-metadata routes.)*
- **FR-009**: Archiving a card MUST default to detaching (not destroying) its backing session, and MUST require explicit confirmation to terminate a session.
- **FR-010**: Concurrent edits to the same card MUST be resolved with revision-based optimistic concurrency; a client whose write is stale MUST be refreshed rather than overwrite newer state.

**Terminal Panel**

- **FR-011**: A card's Terminal panel MUST attach to that card's zellij session over the gateway shell WebSocket using the existing input/resize/output/scrollback protocol.
- **FR-012**: On attach, the terminal MUST replay available recent scrollback before live output.
- **FR-013**: The terminal MUST forward keystrokes as input and window size changes as resize events to the remote session.
- **FR-014**: On WebSocket disconnect, the terminal MUST automatically reconnect with bounded backoff and restore continuity of output. If the gateway supports resuming from a client-supplied sequence number, reconnect MUST resume from the last acknowledged sequence; if it does not, the client MUST de-duplicate the fixed replay window so no committed output is duplicated or dropped. *(Plan obligation F1: confirm exact resume semantics of the gateway shell WS — `SHELL_ATTACH_LIVE_TAIL_FROM_SEQ` and the recent-replay window — before relying on resume-from-seq.)*
- **FR-015**: The terminal MUST NOT spawn any local PTY/process.
- **FR-015a**: WebSocket authentication MUST use an `Authorization` header or a token-bearing WebSocket subprotocol — NOT a token in the URL/query string — so credentials are never written to gateway/proxy access logs. *(Native clients can set upgrade headers; the browser-only query-token path MUST NOT be reused here.)*

**Shell & App Panels**

- **FR-016**: A card MUST be switchable between Terminal, Matrix Shell, and Matrix App panels.
- **FR-017**: The Matrix Shell panel MUST embed the user's Canvas/Desktop shell authenticated as the same user (no second sign-in).
- **FR-018**: The Matrix App panel MUST load a selected Matrix App through the MatrixOS app bridge with the same data-access and sandbox guarantees as the web shell, and MUST block un-bridged network calls.

**Symphony**

- **FR-019**: The app MUST surface Symphony run status and recent agent activity on related cards.
- **FR-020**: The app MUST let the user start/observe a Symphony orchestrated run from the board, reflecting progress and terminal state.

**CLI / MCP Control Surface**

- **FR-021**: The system MUST provide a Matrix-targeted command set and MCP server to list/create/update/move cards against the same gateway/Postgres state and authorization rules as the app.
- **FR-022**: Board changes made via CLI/MCP MUST propagate live to the native app and web shell.

**Cross-cutting**

- **FR-023**: All client-facing errors MUST be generic and safe; the app MUST NOT display raw gateway, database, provider, or filesystem error text.
- **FR-024**: The app MUST present clear connection/empty/error states (reconnecting, no VPS, session exited, re-auth) rather than blank or broken screens.
- **FR-025**: The app MUST request only the authorized user's board/sessions; it MUST NOT be able to access another principal's data.

### Key Entities *(include if feature involves data)*

- **Connection Profile**: A target Matrix computer — user handle, resolved gateway endpoint, selected VPS, and a reference to credentials in the Keychain. No durable board data.
- **Board**: The set of cards for a given VPS/project, owned by the user. Source of truth in the user's Postgres.
- **Card**: A unit of work that references exactly one backing zellij **Session**, plus kanban metadata: title, column, order, tags, archived state, revision, timestamps.
- **Session (zellij)**: A live remote terminal session on the VPS — name, status (active/exited), working directory, layout, and tabs. Runtime truth lives on the VPS; the card holds only a reference.
- **Panel**: The current view of a card — Terminal, Matrix Shell, or Matrix App — including which app is pinned when in App mode.
- **Symphony Run (read model)**: Orchestrator run status and agent activity associated with a card, sourced from the VPS.

## Security & Privacy Architecture *(mandatory per Spec Quality Gates)*

- **Auth source of truth**: Gateway-issued principal (JWT/device token), identical to CLI and request-principal model. The app holds no independent identity.
- **WebSocket auth transport (S1)**: WebSocket attaches authenticate via an `Authorization` header or token-bearing subprotocol on the upgrade request — the native app is NOT a browser and MUST NOT use the query-token path (which leaks tokens into access logs). Existing principal validation is reused; only the token-carrying channel differs. The gateway's query-token allowlist is browser-only and out of scope for this client.
- **Auth matrix (S2 — plan obligation)**: `/speckit.plan` MUST emit an explicit table listing every new/used HTTP route and WS endpoint (board CRUD, session list/create, terminal attach, board-update subscription, Symphony status) with its method, principal requirement, and scope. Prose here is not a substitute for that table.
- **Authorization matrix**: Every board read/write, session list/create/attach, shell embed, app load, and Symphony action is authorized against the request principal and scoped to the user's own VPS. No cross-principal access. CLI/MCP writes pass the same authorization as UI writes.
- **Input validation**: All board mutations validate IDs, column names, tags, ordering, and session names at the route boundary with bounded schemas before touching Postgres. Session names are validated against the safe-name rules already enforced by the shell registry. WebSocket frames are schema-validated after parse.
- **Secret handling**: Tokens live only in Keychain; never written to logs, board metadata, or local files. No provider names or raw upstream errors are surfaced to the UI.
- **Sandbox guarantees**: The App panel preserves the web shell's sandbox contract (bridge-only data access, blocked direct fetch). The Shell panel runs the user's own origin authenticated as the user; it does not bypass shell-side authorization.
- **Data ownership**: Zero durable local persistence of user content. Uninstalling the app removes no board/terminal/app data because none is stored locally.

## Integration Wiring *(mandatory per Spec Quality Gates)*

- **Startup sequence**: Resolve stored profile → load token from Keychain → resolve gateway endpoint for the selected VPS → fetch board (cards + sessions) → render → lazily attach terminal WS only when a card's Terminal panel is opened.
- **Cross-surface communication**: Native app ⇄ gateway over HTTPS (board CRUD, session list/create) and WSS (terminal attach, live board updates / Symphony status). The web Shell/App panels load the user's existing shell origin. The CLI/MCP surface targets the same gateway routes.
- **Gateway dependencies (existing, to be confirmed/extended in plan)**: shell WebSocket attach protocol, zellij session list/create/tabs, request-principal auth, Symphony status. New gateway routes are required for board metadata CRUD (cards/columns/tags) backed by the user's Postgres, plus a board-update subscription channel (FR-008a).
- **VPS endpoint resolution (W2 — plan obligation)**: The plan MUST specify how the app discovers a user's per-VPS gateway URL (via the platform/`app.matrix-os.com` runtime routing) and how multi-VM selection/switching works, including the pre-VPS (no computer yet) onboarding path.
- **Symphony source (W3 — plan obligation)**: The plan MUST pin the concrete Symphony run/agent-activity read-model source (gateway route vs. Symphony service) and its authorization.
- **No new shared global state**: board state is server-authoritative; the app is a renderer.
- **Integration test checkpoint (T1)**: Each implemented user story MUST ship with an end-to-end check exercising the client↔gateway chain — gateway contract tests for the new board routes/subscription, and a native integration test that attaches a terminal to a real test zellij session and round-trips input/output. Unit tests alone do not satisfy a phase checkpoint.

## Failure Modes & Resource Management *(mandatory per Spec Quality Gates)*

- **Timeouts**: All HTTP calls to the gateway use bounded timeouts; no request hangs indefinitely. WS attach and reconnect use bounded backoff with a cap.
- **Concurrent access**: Revision-based optimistic concurrency for board edits; losing writers refresh. Session create is idempotent server-side so double-taps do not create duplicate sessions.
- **Crash/disconnect recovery**: Terminal reconnects and replays from last acknowledged sequence. Board refetches on reconnect. Stale live-session references are reconciled on the main read path (mark exited sessions recoverable), not only via explicit recovery.
- **Resource limits**: Terminal scrollback buffers are capped with eviction; rendering applies backpressure under fast output. Any in-memory caches (board view, session map) are bounded. Embedded web views are released when panels close. **(R1)** There is also an *aggregate* cap across the whole board: the number of simultaneously live terminal attaches and embedded web views is bounded, and offscreen/background cards are suspended (WS detached, web view released) and reattached on focus, so a large board cannot exhaust sockets or memory.
- **Error policy**: No silent failures; every failed create/attach/load sets a visible, generic error state and offers a recovery action. Misconfiguration (no VPS, missing endpoint) is distinguished from "not found" and from transient connectivity.

## Constitution Alignment

- **P1 Data Belongs to Its Owner**: No local durable user data; board in user's Postgres; sessions on user's VPS.
- **P3 Headless Core, Multi-Shell**: The macOS app is one more renderer over the same gateway; it adds no core logic the web shell lacks.
- **P4 Defense in Depth**: Principal-scoped authz, input validation, bounded resources/timeouts, sandbox preservation.
- **P5 TDD**: All new gateway routes and client logic are specified test-first (see plan/tasks).

## Out of Scope (Deferred)

- Windows/Linux native clients (the web shell and/or an Electron SlayZone fork cover those).
- Offline-first/local-first mode or any local database. *(Note A1: Constitution Principle III lists offline support as a goal for first-class desktop shells. This spec deliberately defers it to a later phase to keep the thin-client/no-local-data invariant clean for v1; a future read-only offline cache may be revisited without violating data-ownership. This is a phased deferral, not a permanent exclusion.)*
- Replacing or re-implementing the web Canvas/Desktop shell or Matrix Apps natively (they are embedded, not rewritten).
- Mobile clients (covered by spec 075-mobile-shell).
- Running terminals/PTY locally on the Mac.
- App Store distribution mechanics (addressed in plan only if/when packaging is in scope).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After signing in, a user with an active VPS sees their session board within 5 seconds on a typical broadband connection.
- **SC-002**: Opening a card's terminal reaches an interactive, scrollback-populated prompt within 3 seconds, with no local process spawned.
- **SC-003**: Terminal input feels native: 95th-percentile keystroke-to-echo round trip stays under typical interactive thresholds (≤150 ms on broadband) and the UI never blocks during fast output.
- **SC-004**: After a network drop, the terminal reconnects and restores scrollback within 5 seconds without losing committed output.
- **SC-005**: A board edit made on one device (or via CLI) appears on another connected client within 2 seconds.
- **SC-006**: 100% of user content is server-side: an audit of the uninstalled app's local footprint finds zero board, terminal, or app data (only Keychain credentials, which clear on sign-out).
- **SC-007**: 90% of first-time users can connect and open a working terminal on their Matrix computer without external help.
- **SC-008**: The same board (cards, columns, order, tags) is identical across the native app, the web shell, and the CLI for the same user.
- **SC-009**: No client-visible error message exposes raw gateway, database, provider, or filesystem internals (verified by error-path review).
