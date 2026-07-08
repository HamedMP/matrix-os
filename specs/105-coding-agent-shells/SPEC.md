# Feature Specification: Coding Agent Shells

**Feature Branch**: `chore/mobile-expo-sdk-57`
**Created**: 2026-07-06
**Status**: Draft
**Input**: Upgrade Matrix OS desktop and mobile shells into first-class interfaces for managing multiple coding agents on the user's remote Matrix computer, while preserving every existing desktop and mobile capability.

## Overview

Matrix OS should feel like a remote development computer with native-feeling shells on desktop and mobile. The user signs in once, chooses their Matrix computer, opens a project, starts one or more coding agents, watches live work, reviews files and diffs, uses terminal sessions, opens previews, and resumes the same work from another device.

The headless runtime remains the source of truth. The desktop app and mobile app are interfaces, not separate runtimes. Every project, terminal session, agent thread, approval, diff, file read/write, app launch, and preview route must flow through authenticated gateway contracts backed by the user's Matrix computer.

This spec intentionally builds on the existing Matrix OS pieces:

- `packages/gateway`: HTTP and WebSocket gateway for terminal, apps, files, messages, agents, cron, and system state.
- `packages/kernel`: AI kernel, agents, tools, approvals, memory, and prompt system.
- `packages/sync-client`: CLI, remote run/attach, file sync, and local daemon patterns.
- `shell`: browser/canvas shell and web terminal.
- `desktop`: Electron desktop shell with trusted main process, validated IPC, auth handoff, embeds, updater, and native notifications.
- `apps/mobile`: Expo SDK 57 native shell with terminal, apps, chat, canvas entry, offline state, and mobile persistence.

## Product Goals

1. **Remote computer first**: desktop and mobile connect to the user's Matrix computer and never require users to manage SSH keys, hostnames, VPS IPs, or raw credentials.
2. **Multi-agent by default**: users can configure and run multiple coding agents side by side, with independent sessions, transcripts, terminals, statuses, approvals, and notifications.
3. **Thread/task/workspace model**: each agent run can be standalone or bound to a project/task/worktree. Opening a thread reveals the relevant terminal, files, diff, preview, logs, and actions.
4. **Cross-shell continuity**: work started on desktop resumes on mobile and vice versa. The same named terminal session, agent thread, project, diff, and app launch inventory are visible from both shells.
5. **Native-feeling clients**: desktop uses Electron's trusted core and native notifications/menus. Mobile uses Expo SDK 57 and phone-first layouts. Both retain current features.
6. **Reliability under interruption**: reconnects, sleep/wake, token expiry, runtime switch, network loss, and mobile app suspension must produce recoverable states, not lost work.
7. **Safe by construction**: every endpoint, WebSocket frame, IPC message, app launch, deep link, and persisted reference is validated and owner-scoped.

## Non-Goals

- Replacing the Matrix kernel or moving core orchestration into desktop/mobile.
- Making desktop or mobile run local PTYs as the canonical terminal source.
- Requiring SSH setup as the user-facing path.
- Duplicating project/task/session storage in local client databases.
- Replacing the existing Canvas, app launcher, mobile terminal, desktop embeds, auth flow, update flow, or sync client.
- Implementing every possible provider-specific capability in the first PR.
- Storing provider credentials in desktop renderer, mobile JS state, embedded app frames, or local shell stores.
- Adding unreviewed third-party native dependencies before a spike and explicit license/security review.

## User Stories

### US1 - Connect Desktop To My Matrix Computer (P1)

As a user, I want the desktop app to sign in, select my Matrix computer, and show a connected developer workspace without manual server setup.

**Independent Test**: Fresh desktop install, sign in via device flow, select runtime, see connection status, list projects, open terminal, run `pwd`, disconnect network briefly, reconnect, and verify the terminal resumes.

**Acceptance Criteria**

1. Given the user is signed out, when they start sign-in, then the app opens the existing secure auth flow and stores the credential only in the trusted desktop core.
2. Given the user has one or more runtimes, when sign-in completes, then the app shows the selected runtime and allows switching through an authenticated runtime selector.
3. Given the runtime is reachable, when the app opens, then project/task/thread/terminal summaries load through gateway contracts.
4. Given connectivity is lost, when the app reconnects, then open views recover without clearing local UI state or duplicating terminal output.

### US2 - Connect Mobile To The Same Work (P1)

As a user, I want the mobile app to open the same Matrix computer, resume recent work, and provide a phone-first interface for agent threads and terminals.

**Independent Test**: Start a terminal and agent run on desktop, open mobile SDK 57 app, sign in, see the same active thread/session, attach, send input or follow-up, background the app, return, and verify state resumes.

**Acceptance Criteria**

1. Given the user is signed in on mobile, when the app opens, then it loads the authenticated runtime profile and shows recent work without requiring SSH details.
2. Given a terminal session exists, when the user opens Terminal on mobile, then the app can attach to that named session or create a new one.
3. Given an agent thread is running, when the user opens mobile, then the thread appears with live or resumable status.
4. Given the app is backgrounded, when the user returns, then mobile reconciles live runtime state before trusting stale local resume state.

### US3 - Manage Multiple Coding Agents (P1)

As a user, I want to see installed/configured coding agents, start runs with a chosen agent, and manage concurrent runs without state mixing.

**Independent Test**: Configure at least two agent providers, start two runs against the same project and one run against another project, switch between threads, approve/decline requests, abort one run, and verify the others continue.

**Acceptance Criteria**

1. Given multiple agent providers are available, when the user opens the agent picker, then every provider has a safe display name, availability status, install/auth status, default model or mode, and last health check.
2. Given the user starts a run, when they pick an agent, project, task, and prompt, then the gateway creates an owner-scoped agent thread and begins streaming events.
3. Given multiple threads are running, when the user switches between them, then each thread preserves its own transcript, tool activity, terminal binding, approvals, and status.
4. Given a thread needs approval or input, when the event arrives, then desktop and mobile show a safe, actionable attention state.
5. Given the user aborts one thread, when abort succeeds, then only that thread stops; other threads and terminal sessions remain unaffected.

### US4 - Work In A Project Workspace (P2)

As a user, I want every project/task/thread to open into a workspace with terminal, files, diff, preview, logs, and agent transcript.

**Independent Test**: Open a project, create a task, start an agent, inspect changed files, open a file, view diff, open preview, send follow-up, and verify the same workspace is visible on desktop and mobile with shell-appropriate layout.

**Acceptance Criteria**

1. Given a project is selected, when the user opens its workspace, then the shell shows project identity, repository status, active tasks, active threads, terminals, and recent activity.
2. Given the user opens files, when edits occur, then saves go through gateway file contracts with conflict detection.
3. Given an agent changes files, when diff data is available, then the shell shows per-file status and review actions.
4. Given a dev server or generated app is running, when preview opens, then the preview route is owner-scoped and origin-restricted.
5. Given the viewport is mobile, when the same workspace opens, then it uses stacked panes/sheets/tabs instead of desktop panel density.

### US5 - Review And Ship Agent Work (P2)

As a user, I want to review diffs created by agents, ask for follow-up fixes, and prepare changes for PR without leaving Matrix.

**Independent Test**: Agent modifies a repo, diff appears, user reviews file-by-file, selects a hunk, asks the agent to adjust it, commits or opens a PR through gateway-backed source-control actions.

**Acceptance Criteria**

1. Given a thread has file changes, when the user opens Review, then changed files and diff hunks render with additions/deletions.
2. Given a hunk is selected, when the user chooses "ask agent to fix", then the composer opens with structured context for that hunk and target thread/project.
3. Given source control credentials are available server-side, when the user creates a PR, then the operation runs through the gateway and no GitHub token is stored in the client.
4. Given diff data is too large, when review opens, then the shell shows partial/summary state and explicit fetch-more behavior instead of freezing.

### US6 - Use Remote Terminal Sessions Everywhere (P1)

As a user, I want named remote terminal sessions that survive reloads, device switches, network loss, and app restarts.

**Independent Test**: Create session on desktop, attach on mobile, run long command, detach mobile, reattach desktop, resize, terminate intentionally, and verify lifecycle state is consistent everywhere.

**Acceptance Criteria**

1. Given a session exists on the Matrix computer, when a shell lists sessions, then it shows only owner-scoped attachable sessions.
2. Given a shell attaches, when output arrives, then sequence/replay behavior prevents duplicate lines and marks replay gaps.
3. Given a client detaches or disconnects, when the terminal process is still running, then session state remains running.
4. Given the user intentionally terminates a session, when confirmation succeeds, then all attached clients see ended state.
5. Given paste/input is large, when sent, then frames are bounded and chunked according to gateway limits.

### US7 - Keep Existing Desktop Features (P1)

As a current desktop user, I want auth, runtime switching, embeds, settings, updates, notifications, local UI state, and app launch behavior to continue working.

**Independent Test**: Run existing desktop flows before and after agent shell changes: sign in/out, runtime switch, hosted shell embed, app embed, notification click, update check, window state persistence, menu shortcuts, settings.

**Acceptance Criteria**

1. Existing validated IPC channels remain compatible or migrate with compatibility wrappers.
2. Embedded apps remain isolated from privileged APIs and credentials.
3. Deep links and notification click-through validate payloads before navigation.
4. The updater remains non-destructive; it never force-restarts active work.

### US8 - Keep Existing Mobile Features (P1)

As a current mobile user, I want chat, terminal, apps, canvas entry, settings, push, offline state, auth, and mobile shell resume behavior to keep working after the upgrade.

**Independent Test**: Run current mobile Jest tests and manual SDK 57 flows, then repeat after new agent workspace screens land.

**Acceptance Criteria**

1. Existing app tabs/routes keep their behavior unless replaced by a tested superset.
2. Current terminal session behavior is preserved while new state/contracts are added.
3. Mobile safe areas, keyboard avoidance, orientation, offline banners, and persisted mobile shell state keep working.
4. No route introduces Expo Go assumptions; native builds use the Expo dev client.

## Functional Requirements

### Runtime And Contracts

- **FR-001**: Matrix MUST define a shared coding-agent contract layer for projects, agent providers, agent threads, thread events, approvals, terminals, files, diffs, previews, runtime health, and shell summaries.
- **FR-002**: Contracts MUST use Zod 4 at route/WebSocket/IPC boundaries and export inferred TypeScript types for desktop, mobile, shell, gateway, and tests.
- **FR-003**: Contracts MUST be source-compatible with current gateway behavior where possible, using additive fields and explicit versioning for changed frames.
- **FR-004**: Runtime state MUST be canonical on the Matrix computer. Clients may store bounded caches and last-viewed UI state only.
- **FR-005**: The gateway MUST expose a single runtime summary endpoint that desktop and mobile can use to hydrate: active runtime, available agents, projects, active threads, terminal sessions, recent activity, and feature availability.

### Agent Providers

- **FR-010**: The runtime MUST support multiple coding-agent providers as configured tools, not hardcoded UI-only options.
- **FR-011**: Each provider MUST report `id`, `displayName`, `kind`, `availability`, `authStatus`, `installStatus`, `defaultModel`, `supportedModes`, and safe setup actions.
- **FR-012**: Provider setup/install actions MUST run on the Matrix computer in foreground terminal sessions when user interaction may be required.
- **FR-013**: Provider health checks MUST be timeout-bound and return coarse status only.
- **FR-014**: Provider-specific errors MUST never be rendered raw to users; clients receive safe states and recovery actions.

### Agent Threads

- **FR-020**: Users MUST be able to create a thread with provider, prompt, optional project, optional task, optional worktree, optional terminal session, model/mode options, approval policy, and sandbox policy.
- **FR-021**: Threads MUST stream typed events: lifecycle, assistant text, reasoning/plan, tool activity, terminal activity, file changes, diffs, approvals, user-input requests, errors, and completion.
- **FR-022**: Threads MUST be resumable by ID across desktop, mobile, browser shell, and CLI.
- **FR-023**: Threads MUST have explicit statuses: `queued`, `starting`, `running`, `waiting_for_approval`, `waiting_for_input`, `completed`, `failed`, `aborted`, `stale`, and `archived`.
- **FR-024**: Thread abort MUST target one thread/run and leave project, terminal, and other threads intact.
- **FR-025**: Thread transcript memory in clients MUST be capped; clients fetch historical windows or snapshots from the runtime.

### Approvals And User Input

- **FR-030**: Approval requests MUST include bounded display data, provider/thread/project context, requested action kind, risk level, allowed decisions, expiry, and correlation ID.
- **FR-031**: Desktop and mobile MUST support approve, approve for session when allowed, decline, cancel, and provide user-input answers.
- **FR-032**: Approval decisions MUST be idempotent server-side; repeated client sends after reconnect must not double-apply.
- **FR-033**: Approval and input surfaces MUST use safe copy and never expose raw command env vars, secret-looking tokens, or full private paths unless explicitly designed as user-owned project paths.

### Terminal Sessions

- **FR-040**: Terminal sessions MUST be named, owner-scoped, runtime-scoped, and attachable from desktop, mobile, web shell, and CLI.
- **FR-041**: Terminal attachments MUST include sequence/replay support or an equivalent monotonic output cursor.
- **FR-042**: Terminal clients MUST distinguish process state from attachment state.
- **FR-043**: Resize values MUST be clamped and coalesced.
- **FR-044**: Input frames MUST be size-limited and validated.
- **FR-045**: Session lists MUST cap returned items and include pagination or `hasMore`.
- **FR-046**: Ending a session MUST require explicit confirmation in clients and use a mutating endpoint with body limits and ownership checks.

### Files, Diff, Review, Preview

- **FR-050**: Project file APIs MUST support browse, search, read, write, and metadata with path validation inside owner/project scope.
- **FR-051**: File writes MUST include base revision/etag and conflict-safe behavior.
- **FR-052**: Diff APIs MUST support thread diff, working tree diff, file-level diff, hunk metadata, partial diff notices, and large-diff limits.
- **FR-053**: Review comments/follow-up prompts MUST carry structured references, not raw unvalidated strings.
- **FR-054**: Preview APIs MUST support owner-scoped local dev servers and app previews with origin validation and safe status reporting.

### Desktop Shell

- **FR-060**: Desktop MUST keep all privileged behavior in the trusted main process or validated preload bridge.
- **FR-061**: Desktop renderer MUST never receive raw bearer tokens, provider credentials, platform secrets, or app launch tokens not intended for that surface.
- **FR-062**: Desktop MUST add a mission-control style agent workspace: project/task sidebar, active thread list, global composer, terminal panel, file/diff/preview panels, activity timeline, and provider setup surface.
- **FR-063**: Desktop MUST preserve existing embeds, auth handoff, runtime switching, settings, updater, single-instance, deep links, menus, notifications, and persisted window state.
- **FR-064**: Desktop MUST validate every IPC request and response with shared or local schemas.
- **FR-065**: Desktop notifications MUST deep-link to exact thread/task/session targets using validated payloads.

### Mobile Shell

- **FR-070**: Mobile SDK 57 MUST add an agent workspace optimized for phone and tablet: inbox/recent work, provider picker, composer, thread detail, approvals, terminal, files, review, and preview.
- **FR-071**: Mobile MUST preserve existing tabs/routes: chat, mission control, terminal, apps, settings, canvas, sessions, auth, push, and offline handling.
- **FR-072**: Mobile MUST use current gateway auth/token patterns and must not require SSH key management.
- **FR-073**: Mobile terminal MUST remain available and evolve toward a native terminal surface behind a capability flag; the existing WebView terminal stays as fallback until the native path is verified.
- **FR-074**: Mobile thread, approval, terminal, and review screens MUST handle app backgrounding, orientation, safe areas, keyboard, and network transitions.
- **FR-075**: Mobile local persistence MUST store only bounded resume/UI state and safe runtime references; every persisted reference must reconcile against live runtime state on read.

### Observability And Diagnostics

- **FR-080**: Gateway, desktop, mobile, and shell MUST emit redacted diagnostics for runtime connection lifecycle, thread lifecycle, terminal attach/replay, approval decisions, provider setup, and preview failures.
- **FR-081**: Client diagnostics MUST be opt-in or follow current product telemetry policy and must exclude terminal content, chat content, file contents, secrets, and raw provider errors.
- **FR-082**: Desktop local logs MUST be rotated and size-capped.
- **FR-083**: Mobile debug logs MUST remain bounded and not persist sensitive content.

## Key Entities

### RuntimeTarget

The selected Matrix computer/runtime. Contains stable ID, display label, health, capabilities, current channel, gateway origin, and selected owner handle. It does not contain secrets.

### AgentProvider

A configured coding-agent provider available on the Matrix computer. Includes display metadata, setup state, auth/install state, supported launch modes, and safe actions.

### AgentThread

A single coding-agent run or resumable conversation. Belongs to owner/runtime, may be bound to project/task/worktree/session, has status, transcript cursor, event cursor, attention state, and lifecycle timestamps.

### AgentEvent

Typed append-only event emitted by runtime: text, tool, reasoning, approval, input request, file change, terminal signal, diff ready, preview ready, error, or lifecycle transition.

### AgentApprovalRequest

A pending decision that blocks or gates a thread action. Must be idempotent, expiring, correlation-aware, and safe to render.

### ProjectWorkspace

Shell projection for one project/task/thread: project metadata, repository state, active sessions, files, diffs, previews, artifacts, processes, and activity.

### TerminalSession

Remote named terminal process state. Distinguished from `TerminalAttachment`, which is the client connection to a session.

### ReviewSnapshot

A bounded projection of changed files and diffs for a thread/task/project. Can be partial and must declare limits.

### PreviewSession

Owner-scoped preview target for app/runtime/dev server with origin policy, status, viewport metadata, and launch context.

### ShellResumeState

Local client UI state for last selected runtime/project/thread/session/screen. It is advisory only and reconciled against runtime state on every load.

## Security Architecture

### Auth Matrix

| Surface | Operation | Auth Requirement | Public? | Notes |
| --- | --- | --- | --- | --- |
| Desktop trusted core | Store credential, inject gateway auth, manage embedded sessions | OS-encrypted credential from existing device flow | No | Renderer never receives raw credential. |
| Desktop renderer | Invoke privileged actions | Validated IPC to trusted core | No | Every request/response schema-checked. |
| Mobile app | Gateway HTTP/WS calls | Existing mobile auth and short-lived gateway token | No | Query token allowed only where browser/native WS APIs need it. |
| Browser shell | Agent workspace routes | Existing shell auth/session | No | Must use query-token allowlist for browser WS routes. |
| Gateway REST | Runtime summary, providers, threads, files, diffs, previews | Owner session or trusted platform-to-runtime auth | No | Body limits on mutating routes. |
| Gateway WS | Thread events, terminal attach, runtime events | Owner session; setup awaited before success frame | No | Frame size and shape validation required. |
| Provider setup | Install/auth/check provider | Authenticated owner, explicit user action | No | Runs on Matrix computer, foreground when interactive. |
| App embeds/previews | Open app/shell/preview | Short-lived owner-scoped launch handoff | No | Origin allowlist and isolated session partitions. |
| Notifications/deep links | Focus target thread/task/session | Local validated payload + existing signed-in state | No | Deep link only selects UI target, never authenticates. |

### Validation Rules

- Validate all IDs with strict prefixes or safe slug patterns.
- Validate provider IDs against configured provider registry.
- Validate route params and query params before service calls.
- Validate every WebSocket frame after JSON parsing and before state mutation.
- Validate IPC messages on both sides of desktop bridge.
- Validate mobile persisted resume state before use; reconcile references against live runtime.
- Validate app launch URLs and preview origins before navigation.
- Validate file paths server-side with resolve-within-project/home helpers.
- Validate diff and file sizes before rendering or storing client-side.

### Resource Limits

- Runtime summaries must be bounded and paginated for projects, threads, sessions, and activity.
- Thread event streams must support cursors and replay windows.
- Client transcript caches must cap message/event count.
- Terminal output buffers must use ring buffers with explicit limits.
- In-memory registries for subscribers, providers, sessions, previews, launch tokens, and diagnostics must have caps and eviction.
- Desktop IPC and mobile gateway clients must reject oversized payloads before rendering.
- Preview/session launch tokens must be short-lived and LRU-cached only where necessary.

### Error Policy

- Never show raw provider, database, filesystem, platform, gateway, or process errors.
- Client copy should say what the user can do: retry, reconnect, sign in, pick runtime, install provider, open terminal setup, resume, start new session, return home.
- Detailed errors go to redacted server logs and bounded local diagnostics.
- Health checks return coarse statuses: available, setup_required, auth_required, unavailable, unknown.
- Runtime offline state must not reveal VPS IPs, private hostnames, or internal routes.

## Integration Wiring

### Required End-To-End Paths

1. Desktop sign-in -> runtime summary -> provider list -> create thread -> stream events -> complete notification -> focus thread.
2. Mobile sign-in -> runtime summary -> attach existing thread -> send follow-up -> receive approval -> approve -> stream resumes.
3. Desktop create terminal -> mobile attach -> desktop detach -> mobile input -> desktop reattach -> intentional terminate.
4. Agent changes files -> review snapshot -> open file -> conflict-safe save -> diff refresh.
5. Provider setup required -> open foreground terminal install/setup command -> provider health refresh -> provider becomes selectable.
6. Runtime switch -> all clients close old runtime streams -> clear embedded sessions where needed -> hydrate selected runtime.
7. Network loss -> clients mark reconnecting -> streams resume by cursor -> no duplicate terminal output or thread events.

## Success Criteria

- **SC-001**: Desktop signed-in launch hydrates runtime summary and renders the agent workspace in under 5 seconds on typical broadband.
- **SC-002**: Mobile signed-in launch hydrates recent threads/sessions in under 5 seconds and remains usable on phone-sized screens.
- **SC-003**: User can start two agent runs with different providers and switch between them without transcript, approval, or terminal state mixing.
- **SC-004**: Terminal sessions created on one shell can be attached from another shell with no process restart.
- **SC-005**: Network interruption and resume produce zero duplicate terminal output lines in scripted tests.
- **SC-006**: Desktop and mobile can both handle an approval request for the same thread, with idempotent server-side decision handling.
- **SC-007**: Existing desktop feature regression checklist passes: auth, embeds, runtime switch, settings, notifications, updates, window state, command palette/menu basics.
- **SC-008**: Existing mobile feature regression checklist passes: chat, terminal, apps, canvas entry, sessions, settings, push/offline, auth, persisted shell state.
- **SC-009**: Error-path audit finds no raw provider names, secret-looking tokens, filesystem paths, database errors, or upstream stack traces in user-visible UI.
- **SC-010**: Typecheck and test gates pass for changed packages, with focused contract tests around every new gateway route/WS/IPC surface.

## Rollout Strategy

1. Ship contracts and read-only runtime summary behind feature flags.
2. Add desktop and mobile read-only agent dashboards.
3. Enable thread creation for one provider path.
4. Add multi-provider creation, approvals, and abort.
5. Add file/diff/review/preview panels.
6. Add native/mobile terminal rendering improvements behind capability detection.
7. Expand provider setup, health, and cross-shell notifications.

Every phase must preserve current desktop and mobile behavior and include compatibility checks before replacing existing surfaces.
