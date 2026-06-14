# Feature Specification: Electron macOS Shell ("Operator")

**Feature Branch**: `094-electron-macos-shell`
**Created**: 2026-06-13
**Status**: Draft
**Input**: User description: "Electron-based native macOS app for Matrix OS (successor to the SwiftUI native shell prototype from specs 086/091/092), inspired by the OpenAI Codex app and SlayZone: Linear-style kanban + sessions/terminals + native Hermes chat + bridged Matrix OS apps, as a thin client over the per-user VPS gateway"

## Overview

Operator is the Matrix OS desktop app for macOS: a keyboard-first mission control where the user's projects, tasks, agent runs, terminals, and Matrix OS apps live in one window, connected as a thin client to their personal VPS. It succeeds the SwiftUI prototype (specs 086, 088, and the 090/091/092 branches), which proved the thin-client thesis end to end but accumulated platform friction that an Electron rebuild removes (see `research-prior-art.md` for the decision record and lessons ledger).

The product model blends two proven desktop apps:

- **From the OpenAI Codex app**: agent-first workflow — a list of parallel agent threads, a composer that launches agent work from anywhere, live run status, diff review before shipping, and notifications when an agent needs attention.
- **From SlayZone**: task-centric workspace — kanban projects and tasks where each task owns its terminal, editor, browser, git, and artifact panels in a resizable panel strip, with templates, tags, and per-project statuses.

What Matrix OS adds on top of both: everything runs on the user's own VPS (no local PTY, no local database of record), Hermes (the AI kernel) is a first-class conversation surface, and the user's Matrix OS apps and hosted Canvas shell are embeddable inside the same window.

All prior learnings from the SwiftUI prototype are treated as requirements here, not suggestions — they were paid for with real debugging time (auth loops, terminal client pileups, session merge bugs).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect and operate from mission control (Priority: P1)

A Matrix OS user installs the app, signs in once with their existing account, and sees their projects and task board. Clicking a task opens its live terminal session running on their VPS with scrollback intact. They can type, run commands, resize, and detach — exactly as if the terminal were local.

**Why this priority**: This is the thin-client core. Everything else layers on a working board + terminal connected to the user's VPS. It is also the parity bar against the SwiftUI prototype: until this works, the prototype cannot be retired.

**Independent Test**: Fresh machine, install app, sign in via device flow, open the board for a project, click a task with a linked session, run `ls`, see output. Kill the network for 10 seconds, restore it, confirm the terminal reconnects and replays missed output.

**Acceptance Scenarios**:

1. **Given** a signed-out app, **When** the user starts sign-in, **Then** a browser opens for approval and the app completes sign-in without the user copying tokens manually.
2. **Given** a signed-in user with projects, **When** the app launches, **Then** the board for the last-used project renders with tasks grouped by status within 5 seconds.
3. **Given** a task with a linked workspace session, **When** the user opens it, **Then** the terminal attaches with recent scrollback and accepts keystrokes within 3 seconds.
4. **Given** an attached terminal, **When** the network drops and recovers, **Then** the terminal reconnects automatically and resumes from the last received output without duplicate lines.
5. **Given** a task whose linked session no longer exists on the VPS, **When** the user opens it, **Then** the app shows a clear "session ended" state with a one-click "start new session" action — it must not retry forever.

---

### User Story 2 - Run AI work as parallel agent threads (Priority: P2)

The user composes a prompt ("fix the failing auth tests") from anywhere in the app. It becomes an agent thread: Hermes runs on the VPS, output streams live into the thread, and the thread shows status (running, needs attention, done, failed). The user starts three more threads on other tasks and switches freely between them. When a thread finishes or needs input, the app raises a native notification; clicking it focuses that thread.

**Why this priority**: This is the Codex-app-shaped value: the desktop app as a cockpit for parallel AI work rather than a single chat window. It builds directly on the Hermes chat protocol already proven in the prototype.

**Independent Test**: Start two agent threads on two tasks, lock the screen until one finishes, confirm a notification arrived, click it, and land on the finished thread with full transcript.

**Acceptance Scenarios**:

1. **Given** any screen in the app, **When** the user invokes the composer and submits a prompt, **Then** an agent thread is created and visibly streaming within 2 seconds.
2. **Given** multiple running threads, **When** the user switches between them, **Then** each shows its own live transcript and status without interfering with the others.
3. **Given** a running thread, **When** the user aborts it, **Then** streaming stops, the thread is marked aborted, and the underlying session remains usable.
4. **Given** a thread that completes while the app is in the background, **When** completion occurs, **Then** a native notification appears within 2 seconds and clicking it focuses the thread.
5. **Given** a streaming transcript, **When** tool calls occur, **Then** they render as distinct activity entries (not interleaved raw text).

---

### User Story 3 - Task workspace with resizable panels (Priority: P3)

Opening a task reveals its workspace: a horizontal strip of panels — terminal, code editor, git/diff, browser/preview, artifacts, processes — that the user can toggle, reorder, and resize. Layout persists per task. Switching between open tasks is instant: terminals keep their buffers, editors keep their open files, nothing visibly reloads.

**Why this priority**: This is the SlayZone-shaped value and the prototype's "Wave 2 crux" that was never completed in SwiftUI. Instant stateful switching was the user's single strongest demand on the prototype.

**Independent Test**: Open task A, run a command producing output, open a file in the editor; open task B, do the same; switch A→B→A and confirm both terminals retain output and both editors retain open files, with switches feeling instant.

**Acceptance Scenarios**:

1. **Given** an open task, **When** the user toggles panels, **Then** each panel opens/closes in the strip with its own keyboard shortcut and the layout persists for that task across app restarts.
2. **Given** two open tasks with active terminals, **When** the user switches between them, **Then** the previously viewed terminal retains its buffer and the switch completes without visible reload.
3. **Given** an open editor panel, **When** the user opens, edits, and saves a file, **Then** the save goes to the VPS and a conflicting external change triggers a warning instead of a silent overwrite.
4. **Given** a panel resize, **When** the user drags a divider, **Then** sizes respect per-panel minimums and persist per task.
5. **Given** many open tasks, **When** resource limits are reached, **Then** least-recently-used task workspaces release live connections but keep restorable state (buffers cached, reattach on focus).

---

### User Story 4 - Review and ship changes (Priority: P4)

After an agent thread (or the user's own terminal work) modifies a project, the user opens the git panel: working-tree diff, branches, worktrees, and PRs. They review the diff file by file, send follow-up instructions to the agent for fixes, and open a PR — all without leaving the app.

**Why this priority**: Diff review is the Codex app's signature loop (agent works → human reviews → ship). It depends on US2/US3 surfaces and partially on new gateway capabilities, so it lands after them.

**Independent Test**: With a project that has uncommitted changes on the VPS, open the git panel, see the diff, and open a PR from a worktree branch; verify the PR exists on GitHub.

**Acceptance Scenarios**:

1. **Given** a project with uncommitted changes, **When** the user opens the git panel, **Then** changed files are listed with per-file diffs rendered in the app.
2. **Given** a diff under review, **When** the user invokes "ask agent to fix" on a file or hunk, **Then** a pre-filled prompt referencing that context opens in the composer.
3. **Given** a task, **When** the user creates a worktree for it, **Then** the worktree is created on the VPS and the task's terminal/editor scope to it.
4. **Given** a reviewed branch, **When** the user opens a PR, **Then** the PR is created via the user's connected GitHub identity and linked on the task.

---

### User Story 5 - Full Matrix OS surfaces in one window (Priority: P5)

The user opens their hosted Matrix OS shell (Canvas) as a tab without a second login. They launch Matrix OS apps (notes, games, dashboards) as tabs or panels — the same apps, data, and bridge they get on the web. Native settings expose account, runtime/VM selection, appearance, channels, integrations, billing, and cron with parity to the web shell.

**Why this priority**: This makes the app the one window for all of Matrix OS rather than a developer tool. It reuses the hardest-won prototype learnings (session handoff, bridged app tokens) but is not on the critical path of the agent/terminal loop.

**Independent Test**: Sign in natively, open the Canvas tab and confirm no login prompt appears; launch a Matrix app that reads its own data and confirm it loads and persists data; expire the hosted web session server-side and confirm the app recovers with at most one inline re-auth prompt and without signing the native session out.

**Acceptance Scenarios**:

1. **Given** a valid native sign-in, **When** the user opens the hosted shell tab, **Then** it authenticates via session handoff with no manual login.
2. **Given** an expired hosted web session, **When** the embedded shell hits an auth wall, **Then** the app retries the handoff once, shows an inline sign-in prompt if that fails, and never signs out the native session.
3. **Given** the app catalog, **When** the user launches a Matrix app, **Then** it loads through the app bridge with its data access intact (same contract as web/mobile), and foreign-origin launch URLs are rejected.
4. **Given** native settings, **When** the user switches runtime/VM, **Then** subsequent board, terminal, and chat traffic targets the selected runtime.

---

### User Story 6 - Keyboard-first command flow (Priority: P6)

The user drives the app with the keyboard: a command palette opens tasks, projects, files, and actions; a quick-open jumps to files; panel shortcuts toggle workspace panels; task creation supports "create" and "create + open" in one motion. Menus, shortcuts, and notifications behave like a first-class Mac app.

**Why this priority**: Polish that compounds daily use. Depends on all prior surfaces existing.

**Independent Test**: Complete the flow "create task → open → start agent → toggle terminal and editor panels → open a file by name → close task" entirely without the mouse.

**Acceptance Scenarios**:

1. **Given** any screen, **When** the user opens the command palette, **Then** tasks, projects, apps, files, and actions are searchable and actionable from one input.
2. **Given** the create-task dialog, **When** the user confirms with the "create + open" shortcut, **Then** the task is created and its workspace opens immediately.
3. **Given** standard macOS conventions, **When** the user uses system menus, shortcuts, window controls, and full-screen, **Then** behavior matches platform expectations (no web-page feel).

---

### Edge Cases

- **Sleep/wake**: all sockets are dead on wake; every connection (terminals, chat, events) must resume from its last sequence/state without duplicate output or stuck "connecting" states.
- **Token expiry mid-session**: HTTP/WS calls start failing auth; the app prompts re-auth while preserving all open workspace state; after re-auth, connections resume. Native principal expiry never destroys local UI state.
- **Hosted-shell session expiry**: handoff retried at most once; failure shows inline sign-in; never cascades into native sign-out (the 091 auth-loop class of bug must be structurally impossible).
- **Server session vanished** (`session_not_found`): terminal enters a terminal "ended" state with a recreate action; no infinite retry loop.
- **Scrollback replay gap** (server evicted requested sequence): client accepts the gap, clears stale buffer, attaches at live tail, and shows a subtle "output gap" marker; never duplicates output.
- **Concurrent open requests**: rapidly clicking task A then task B must cancel A's in-flight attach (generation guard); the slower response must never win.
- **VPS offline / proxy 5xx**: coarse offline state with retry; no raw upstream errors or status codes surface to the UI.
- **Huge paste into terminal**: input is chunked and bounded; the app never sends a single multi-megabyte frame.
- **Large session/task lists** (100+): lists paginate or cap with explicit "show more"; no unbounded render or memory growth.
- **App update while work is attached**: update downloads in the background and applies on relaunch; it never force-restarts attached terminals.
- **Second app instance**: launching again focuses the existing window (single instance).
- **Clock skew**: token expiry decisions tolerate client clock error (rely on server 401s, not local clock alone).

## Requirements *(mandatory)*

### Functional Requirements

#### Connection & Identity

- **FR-001**: Users MUST sign in via the existing platform device-authorization flow (same as CLI and SwiftUI prototype); no separate account system.
- **FR-002**: The native credential MUST be stored OS-encrypted, accessible only to the app's trusted core process, and MUST never be readable by any surface that renders remote content.
- **FR-003**: All gateway HTTP and WebSocket calls MUST authenticate with the bearer credential in the Authorization header (the app controls its network layer, so the header-auth contract from spec 086 FR-015a is preserved; query-token auth is not used by this client).
- **FR-004**: The app MUST route all traffic through the platform proxy domain and selected runtime slot; it MUST never connect to VPS IPs directly.
- **FR-005**: Users with multiple runtimes/VMs MUST be able to select the active runtime, and all surfaces (board, terminals, chat, apps) MUST follow the selection.
- **FR-006**: Sign-out MUST clear the local credential and derived sessions (including embedded web sessions) but MUST NOT delete any server-side data.

#### Projects & Board

- **FR-010**: The app MUST list the user's projects and render each project's tasks as a kanban board using the project's status columns.
- **FR-011**: Users MUST be able to create, rename, move (status/order), archive, and delete tasks; mutations go to the gateway (owner Postgres is the source of truth) with optimistic concurrency — stale writes refresh, never silently overwrite.
- **FR-012**: Task creation MUST offer both "create" and "create + open" completion actions.
- **FR-013**: Board reads MUST be stale-while-revalidate: cached cards render immediately, refresh happens in the background; full-screen skeletons appear only on first load.
- **FR-014**: Board changes made elsewhere (web shell, CLI, agents) MUST appear in the app within 2 seconds. Event push is the target mechanism; bounded REST polling/SWR refresh is acceptable only while the full task-event push dependency remains outstanding.
- **FR-015**: Tasks MUST support tags, priority, and per-project statuses; the board MUST be identical in content across native app, web shell, and CLI.

#### Terminals (thin client)

- **FR-020**: Terminals MUST attach to VPS workspace sessions over the gateway terminal WebSocket with sequence-numbered output and resume-from-sequence replay; the app MUST NOT run local PTYs.
- **FR-021**: Only sessions that are actually attachable MUST be offered for attach (the prototype's session-merge rule: terminal-multiplexer sessions plus workspace records that carry a real session reference); orchestrator-only records must not enter the attach path.
- **FR-022**: At most one live attachment per session per app instance: the focused terminal holds the socket; backgrounded terminals detach but retain their rendered buffer for instant restore (no client pileup on the VPS).
- **FR-023**: Reconnects MUST use bounded exponential backoff with jitter; `session_not_found` and equivalent fatal results MUST stop retrying and surface the recreate flow.
- **FR-024**: Resize events MUST be coalesced (settle-style debounce) so window drags do not flood the session host.
- **FR-025**: Scrollback MUST be ring-buffered with a fixed cap; replay eviction is handled by accepting the gap (no duplicate output, visible gap marker).
- **FR-026**: Users MUST be able to create a new session (for a task or standalone), detach, and terminate a session by name with explicit confirmation (termination requires the gateway kill-by-name capability — see Dependencies).
- **FR-027**: Terminal rendering MUST support interactive full-screen programs, ANSI color, and a Nerd-Font-capable font stack.

#### Agent Threads (Hermes)

- **FR-030**: The app MUST provide a native Hermes conversation surface speaking the existing gateway kernel protocol (message/abort out; init, streaming text deltas, tool start/end, result, error, aborted in), with transcripts reduced exactly per the shared protocol contract (delta accumulation, tool-split bubbles).
- **FR-031**: A global composer MUST let the user start an agent run from anywhere, optionally bound to a task and its session; each run is a thread with visible status: running, needs-attention, done, failed, aborted.
- **FR-032**: Multiple threads MUST run concurrently with independent transcripts; switching threads never tears down other threads' streams.
- **FR-033**: Users MUST be able to abort a running thread; the abort targets the specific request, and the session remains usable.
- **FR-034**: Thread transcripts MUST be capped in memory (bounded message count) with the canonical history remaining on the VPS.
- **FR-035**: When a thread completes, fails, or needs attention while unfocused, the app MUST raise a native notification that deep-links to the thread; notification volume MUST be bounded (coalesce repeats).

#### Workspace Panels

- **FR-040**: Each open task MUST present a panel strip — terminal, editor, git, browser/preview, artifacts, processes — where panels toggle independently, are resizable with per-panel minimums, and persist layout per task.
- **FR-041**: The editor MUST provide VS Code-class editing for files on the VPS: syntax highlighting, find/replace, multiple open files, dirty indicators, and conflict-safe saves (warn when the file changed remotely since load).
- **FR-042**: The file browser/quick-open MUST list and search project files via the gateway file API; all paths are validated server-side; the client never composes raw filesystem paths beyond user-visible navigation.
- **FR-043**: The processes panel MUST show running processes on the VPS (read-only at minimum) via the gateway once the process-listing dependency is available; until then it MUST render an explicit unavailable state rather than fake process data.
- **FR-044**: The artifacts panel MUST list task/project artifacts and previews with safe rendering (no arbitrary remote origins).
- **FR-045**: Open-task workspaces MUST be limited by an LRU policy: beyond the cap, the least-recently-used workspace releases live sockets and heavy views but remains restorable.

#### Git & Review

- **FR-050**: The git panel MUST show branches, worktrees, PRs, and working-tree status for the project, fetched via the gateway (read paths existed in the prototype; diff content requires a gateway delta — see Dependencies).
- **FR-051**: Diff review MUST render per-file diffs natively with file-tree navigation.
- **FR-052**: Users MUST be able to create a task-scoped worktree, and the task's terminal and editor MUST scope to it.
- **FR-053**: "Ask agent to fix" from a diff context MUST open the composer pre-filled with the file/hunk context.
- **FR-054**: PR creation MUST go through the gateway using the user's connected GitHub identity; the app never stores GitHub credentials.

#### Embedded Matrix OS Surfaces

- **FR-060**: The hosted shell (Canvas) MUST be embeddable, authenticated via the existing app-session handoff; the handoff MUST verify both required session cookies are present before declaring success, and MUST clear stale third-party auth cookies that can shadow the native session.
- **FR-061**: Hosted-shell auth failure handling MUST be non-destructive: at most one automatic retry, then an inline sign-in prompt scoped to the embedded surface; the native principal is never signed out by an embedded-surface failure.
- **FR-062**: Matrix OS apps MUST launch only through the bridged app runtime (short-lived session token, launch URL resolved against the gateway base, foreign origins rejected); un-bridged app loading paths MUST NOT exist in this client.
- **FR-063**: App launch tokens MUST be cached with expiry (bounded LRU) and refreshed transparently when stale.
- **FR-064**: All embedded web content MUST run in isolated browser contexts with no access to the app's privileged APIs or credential store; navigation inside embedded surfaces is restricted to an origin allowlist, and external links open in the system browser.
- **FR-065**: Native settings MUST cover: account/profile, runtime selection, appearance, agent persona, channels, integrations, skills, security, billing, cron, and system info — with read paths at parity with the web shell and mutations routed through existing gateway routes.

#### Notifications & Attention

- **FR-070**: Native notifications MUST fire for: agent thread completion/failure/attention, long-running terminal command completion in unfocused sessions (when detectable), and connection-level failures requiring user action.
- **FR-071**: Notification click-through MUST deep-link to the exact thread/task; the dock badge reflects threads needing attention.

#### Security, Errors & Privacy

- **FR-080**: All user-facing errors MUST be generic and safe; raw gateway, database, provider, or filesystem-path text never renders in the UI. Full errors go to local diagnostic logs (rotated, size-capped) and the existing observability pipeline with redaction.
- **FR-081**: Every privileged operation crossing from a rendering surface to the trusted core MUST go through a typed, schema-validated message contract; unknown or malformed messages are rejected and logged.
- **FR-082**: External input (deep links, protocol invocations, file drops, notification payloads) MUST be validated against strict schemas before acting.
- **FR-083**: Crash, error, and usage telemetry MUST flow through the existing observability stack with the same identity and redaction rules as the web shell.
- **FR-084**: The app MUST hold no durable user workspace data locally: local persistence is limited to the credential, connection profile, window/layout state, and bounded caches — losing the local machine loses no user work.

#### Distribution & Updates

- **FR-090**: The app MUST ship signed and notarized for macOS, distributed outside the App Store.
- **FR-091**: The app MUST self-update over a signed feed wired into the existing release-channel model (dev/canary/beta/stable); updates download in the background and apply on relaunch.
- **FR-092**: The app MUST enforce single-instance; second launches focus the existing window.
- **FR-093**: macOS is the launch platform; core architecture MUST NOT take mac-only dependencies outside an isolated platform layer (Windows/Linux are future targets, not v1 deliverables).

### Key Entities

- **Connection Profile**: the user's handle, platform proxy host, and selected runtime slot; locally stored, recreatable at any time by signing in.
- **Principal Credential**: the device-auth bearer token and expiry; OS-encrypted, owned by the trusted core.
- **Project**: a named scope owning tasks, statuses, tags, templates, and a repository context on the VPS.
- **Task**: a unit of work with status, order, priority, tags, optional linked workspace session, optional worktree, and optional agent threads; canonical record lives in owner Postgres.
- **Workspace Session**: a terminal-multiplexer session on the VPS, identified by name, attachable with sequence-numbered output.
- **Agent Thread**: one kernel conversation (session + request lineage) with transcript, status, and originating task.
- **Panel Layout**: per-task arrangement of workspace panels (visibility, order, sizes).
- **Matrix App**: an installed Matrix OS app launchable through the bridged runtime with a short-lived session token.
- **Artifact**: a file or preview produced by work on a task, listed via the gateway.
- **Notification**: an attention event bound to a thread/task with deep-link target.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From app launch (signed in), the board is rendered and interactive within 5 seconds on a typical broadband connection.
- **SC-002**: Opening a task reaches a usable terminal prompt within 3 seconds.
- **SC-003**: Terminal keystroke echo latency is ≤150 ms at p95 on typical broadband.
- **SC-004**: After a network drop, terminals reconnect and restore scrollback within 5 seconds of connectivity returning, with zero duplicated output lines.
- **SC-005**: Board changes made on another client appear in the app within 2 seconds once Dependency #1 lands; bounded REST polling/SWR refresh is the acceptable interim behavior while full task-event push remains outstanding.
- **SC-006**: Switching between two open task workspaces preserves terminal buffers and editor state and completes with no visible reload (perceived as instant; ≤200 ms to interactive).
- **SC-007**: 90% of first-time users complete sign-in and reach their board without external help.
- **SC-008**: Deleting the app and all its local data loses zero user work; signing in on a fresh machine restores projects, tasks, sessions, and history from the VPS.
- **SC-009**: Zero raw upstream error strings are reachable in the UI (verified by error-path audit).
- **SC-010**: Agent thread completion raises a notification within 2 seconds, and notification click lands on the correct thread 100% of the time.
- **SC-011**: Cold app launch to interactive is ≤3 seconds on Apple Silicon.
- **SC-012**: With 5 task workspaces open (1 attached terminal + 4 cached), the app stays responsive and total memory stays under 1.5 GB.
- **SC-013**: Feature parity checklist against the SwiftUI prototype (sign-in, board, terminal attach/reconnect, Hermes chat, bridged apps, hosted shell, settings read-parity) is 100% complete before the prototype is retired.

## Security Architecture *(quality gate)*

### Auth Matrix

| Surface | Mechanism | Credential location | On failure |
|---|---|---|---|
| Gateway HTTP | Bearer in Authorization header | OS-encrypted store, trusted core only | 401 → re-auth prompt; UI state preserved |
| Gateway WS (terminal, kernel, events) | Bearer in Authorization header at upgrade | Same | Backoff reconnect; auth-fatal → re-auth prompt, no retry loop |
| Hosted shell embed | App-session handoff (both session cookies required) into an isolated browser partition | Cookies live only in that partition | One retry → inline sign-in; never cascades to native sign-out |
| Bridged Matrix apps | Short-lived session token in launch URL, gateway-origin only | In-memory LRU with expiry | Refetch token; foreign origin → refuse to load |
| Rendering surface ↔ trusted core | Typed, schema-validated message channels only | n/a | Reject + log; no partial application |

### Input Validation

- Every message crossing the rendering/trusted-core boundary is schema-validated (bounded sizes, strict types) before any action.
- Deep links and protocol invocations are parsed, allowlisted by action, and never execute or navigate from raw input.
- Embedded web surfaces cannot open privileged windows; window/navigation requests are intercepted and checked against the origin allowlist.
- Terminal input frames are size-bounded and chunked; oversized paste is split client-side.

### Error Policy

- One error mapper: all failures collapse to typed categories (unauthorized, offline, timeout, not-found, server, fatal-session) with generic user copy.
- Unknown/long/provider-looking error strings are replaced with generic copy at the display boundary (defense in depth, per CLAUDE.md client-store rule).
- Full detail goes to rotating local logs and the observability pipeline with redaction; logs are size-capped with cleanup.

## Integration Wiring *(quality gate)*

- **Startup sequence**: trusted core boots → loads connection profile + credential → opens main window → renders cached board (stale-while-revalidate) → establishes event/kernel sockets → background-refreshes projects, sessions, apps.
- **Surface separation**: one trusted core owns credentials, network, notifications, updates, and lifecycle; rendering surfaces own UI state only and reach the core exclusively via the validated message contract. Embedded remote content (hosted shell, bridged apps) is a third tier with no core access at all.
- **Session-token handoff** (hosted shell): core performs the exchange, verifies both cookies, installs them into the isolated partition, and clears known-stale auth cookies before each load.
- **Runtime switching**: changing runtime slot tears down sockets cleanly (drain → close), updates the resolver, and re-establishes connections; in-flight requests for the old runtime are cancelled, not retargeted.
- **CLI/MCP parity**: every board/task mutation the app performs uses the same gateway routes as the web shell and CLI, so all clients converge (no app-private write paths).

## Failure Modes *(quality gate)*

| Failure | Expected behavior |
|---|---|
| Network drop / sleep-wake | All sockets reconnect with backoff + jitter; terminals resume from last sequence; chat threads re-bind to sessions; no duplicate output; no stuck spinners |
| Credential expired | Single re-auth prompt; open workspaces intact; queued mutations fail visibly (no silent drop) |
| Hosted web session expired | Retry handoff once → inline sign-in; native session untouched (auth-loop class structurally prevented) |
| Server session gone (`session_not_found`) | Fatal terminal state + recreate CTA; zero further retries |
| Replay window evicted | Accept gap, clear stale buffer, attach at tail, show gap marker |
| Race: open task A then B quickly | Generation guard cancels A's attach; B wins deterministically |
| VPS down / proxy 5xx | Coarse offline banner + periodic retry; no upstream status codes or bodies surfaced |
| Update failure | Current version keeps running; update retried later; never blocks app use |
| Partial mutation failure (e.g., create task succeeds, open fails) | Error surfaced on the failed step; board state refreshed; no orphaned UI state |
| Crash | Crash report to observability; relaunch restores window, open tasks, and layouts from local layout state + server data |

## Resource Management *(quality gate)*

- Terminal scrollback: fixed ring per terminal (cap on lines), eviction documented to the user as a gap marker on replay miss.
- Live socket budget: one attached terminal socket per session; cached (detached) terminal buffers capped by LRU (target: 8) with full release beyond cap.
- Agent transcripts: bounded message count per thread in memory (target: 500); older history remains server-side.
- App launch-token cache: bounded LRU with TTL.
- Embedded web surfaces: bounded count of live embeds; LRU suspension beyond cap.
- Notifications: coalesced per thread; bounded pending queue.
- Local logs: rotated and size-capped; temp files cleaned on a schedule and on quit.
- All in-memory maps/sets carry explicit caps and eviction (CLAUDE.md resource rules apply to the client too).

## Assumptions

- **Electron is a user decision, not an open question.** The runtime choice is mandated; the spec records consequences (security model, distribution), and `research-prior-art.md` records the rationale.
- **This app replaces the SwiftUI prototype** as the desktop path. The 086–092 Swift branches stay archived for reference; their behavioral contracts (auth, terminal protocol, session merge, error policy) carry into this spec. Retirement happens only after SC-013 parity.
- **The proven gateway surface is the contract**: device auth, projects/tasks, terminal WS with sequence replay, kernel WS protocol, files, apps + session tokens, system info — all verified live by the prototype. New server work is limited to the Dependencies list.
- **Reuse of existing web-shell code** (terminal rendering, chat reducer semantics, design tokens) is expected but decided at plan time, not here.
- **Distribution rides the existing release-channel infrastructure** (R2 artifacts + platform release metadata) with a new desktop artifact type.

## Dependencies (gateway/platform deltas)

1. **Task event push**: board live-sync (FR-014) needs full task create/update/delete events on the existing gateway WebSocket; bounded REST polling/SWR refresh is the temporary fallback.
2. **Session termination by name**: FR-026 needs a gateway endpoint to kill a terminal-multiplexer session by name (known prototype blocker).
3. **Diff content endpoint**: FR-050/051 need working-tree and branch diff content via the gateway (branches/PRs/worktrees lists already exist).
4. **Desktop release feed**: FR-091 needs a signed update feed tied to release channels.
5. **Process listing endpoint**: FR-043 needs a gateway read endpoint for running VPS processes; the desktop client shows an unavailable state until it exists.
6. **Long-running command attention** (FR-070, best-effort): may need a gateway signal for command completion in unfocused sessions; degrade gracefully if absent.

## Out of Scope

- Local PTYs, local kernel execution, or any local database of record (thin client, Constitution P1).
- Offline-first mode.
- Windows/Linux packaging and distribution (architecture must not preclude them; shipping them is a later feature).
- Mac App Store distribution.
- Rebuilding Canvas/Desktop web surfaces natively (they embed instead).
- Mobile (spec 075) and CLI/TUI (spec 085) remain separate.
- Symphony orchestration UI beyond surfacing run status on tasks.
- GitHub/Linear ticket import and multi-assignee collaboration (Phase 2 carryover from 086).
