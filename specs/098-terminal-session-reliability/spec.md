# Feature Specification: Terminal Session Reliability

**Feature Branch**: `fix-shell-sticky-waiting-status`
**Created**: 2026-06-25
**Status**: Ready for Planning
**Input**: User description: "List all shell terminal and gateway session-management code-quality findings in a new spec, then work on them one by one."

## Scope Boundary

This spec owns terminal runtime/session reliability: the truth model for live terminal sessions, saved shell metadata, terminal pane references, terminal WebSocket reattach, terminal close/delete behavior, and terminal-specific diagnostics.

Related spec `specs/099-shell-connection-resilience/` owns browser-shell live connection resilience: reconnect banners, browser live-event replay, credential refresh, queued outbound shell actions, public route health, and shell-wide connection diagnostics.

When implementation touches both specs, use this boundary:

- If the user-visible problem is a terminal process/session appearing stuck, lost, duplicated, killed, detached, or not reattached, plan it under this spec.
- If the user-visible problem is the browser shell losing live updates, showing disruptive reconnect state, failing credential refresh, or missing shell-wide event replay, plan it under `099-shell-connection-resilience`.
- Shared diagnostics and reconnect contracts may be introduced in `099`, but terminal-specific status, liveness, and pane/session reconciliation remain acceptance criteria for `098`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Truthful Session Status (Priority: P1)

A developer running commands or agents in Matrix Terminal always sees a visual status that reflects the real runtime state. Stale saved metadata must not keep a shell looking "waiting", "running", or otherwise stuck after the process has produced newer activity, finished, exited, or disappeared.

**Why this priority**: A customer runtime incident showed sessions remaining visually stuck after v2026.06.24-483, showing that the current status model can mislead users even when the underlying runtime may have changed.

**Independent Test**: Seed an existing terminal session with stale waiting metadata, then simulate live output, command-start marks, command-finished marks, quiet live state, and missing runtime state. The user-visible status must update from runtime evidence without manual data cleanup.

**Acceptance Scenarios**:

1. **Given** a session has saved waiting metadata, **When** the terminal records newer command activity, **Then** the session status changes to running.
2. **Given** a session has saved waiting metadata, **When** no command activity is present after the waiting window expires, **Then** the session status changes to idle or finished based on unread output.
3. **Given** a session has saved running metadata from an older release, **When** command-finished evidence appears, **Then** the session status changes to finished or idle.
4. **Given** a session exists only in saved metadata, **When** the runtime no longer lists it, **Then** the user sees a recoverable exited or removed state rather than a live-looking shell.

---

### User Story 2 - Sessions Keep Running Across Tab Switches (Priority: P1)

A developer can switch between Matrix tabs without background terminal processes being killed, detached in a way that breaks reattach, or visually replaced by a stale shell.

**Why this priority**: Long-running coding agents, builds, tests, and deploys are core to the developer product. Tab focus changes must never imply process lifecycle changes.

**Independent Test**: Start a long-running terminal process, switch away to another tab, switch back, refresh, and reconnect. The process must still run unless the user explicitly closes or kills it, and the shell must reattach to the same runtime session.

**Acceptance Scenarios**:

1. **Given** a terminal process is running, **When** the user switches to another Matrix tab, **Then** the process continues running in the runtime.
2. **Given** a background terminal process is still running, **When** the user returns to its tab, **Then** Matrix reattaches to the same session without creating a duplicate.
3. **Given** a browser refresh happens while a terminal is backgrounded, **When** the shell reloads, **Then** Matrix restores the visible tab to the existing session if it is still live.
4. **Given** a terminal is explicitly closed, **When** close succeeds, **Then** Matrix removes only that session and does not affect unrelated running sessions.

---

### User Story 3 - One Session Source Of Truth (Priority: P1)

A developer sees one coherent terminal/session model rather than competing lists, synthetic fallbacks, persisted UI records, workspace-session records, and runtime sessions that can disagree.

**Why this priority**: Current behavior mixes live runtime state, saved shell metadata, scrollback activity, pane layout, and workspace sessions. That makes it easy for stale UI to survive after the runtime has changed.

**Independent Test**: Provide intentionally divergent saved metadata, runtime sessions, workspace sessions, and pane-layout references. Matrix must reconcile them into one safe user-facing list with clear precedence and no duplicate or ghost attach targets.

**Acceptance Scenarios**:

1. **Given** a runtime session and saved shell metadata disagree, **When** the shell loads sessions, **Then** runtime existence wins for liveness and saved metadata contributes only durable UI preferences.
2. **Given** a pane layout references a missing session, **When** the shell reads layout state, **Then** Matrix marks that pane recoverable and routes the user to an existing session or a clear recovery action.
3. **Given** two records alias the same runtime session, **When** the user opens either record, **Then** Matrix attaches to one runtime session and does not duplicate the process.
4. **Given** a legacy session identifier is still present, **When** the user opens or deletes it, **Then** Matrix validates and reconciles the legacy form rather than rejecting it before recovery can run.

---

### User Story 4 - Bounded, Visible Refresh Failures (Priority: P2)

A developer understands when Matrix cannot refresh terminal state, and stale data is labeled as stale instead of silently looking current.

**Why this priority**: Silent polling failures and timeouts can preserve old state and make the shell appear frozen. Users need visible, repairable state without raw provider or filesystem errors.

**Independent Test**: Force session-list, agent-status, and layout refresh calls to time out or fail transiently. The UI must keep usable last-known data while labeling it stale and offering a retry or recovery action.

**Acceptance Scenarios**:

1. **Given** terminal session refresh times out, **When** previous sessions are still shown, **Then** Matrix labels the list as stale and keeps explicit retry available.
2. **Given** agent status refresh times out, **When** the new-session menu opens, **Then** Matrix falls back to safe defaults without showing console-only failure as the only signal.
3. **Given** refresh later succeeds, **When** current runtime state is available, **Then** stale labels clear and the shell updates to the current state.

---

### User Story 5 - Maintainable Terminal State Architecture (Priority: P2)

Engineers can change terminal behavior without editing a giant UI component that owns unrelated project, shell, session, file, agent-status, drag, reorder, and layout state at once.

**Why this priority**: The current shell terminal UI concentrates too many independent state machines in one component. That increases regression risk and makes subtle lifecycle bugs difficult to isolate.

**Independent Test**: Extract or isolate terminal state ownership behind focused stores/helpers while keeping existing user behavior unchanged. Component tests should prove the same visible flows still work.

**Acceptance Scenarios**:

1. **Given** a developer changes session refresh behavior, **When** tests run, **Then** they can validate that behavior without rendering unrelated file-tree or agent-menu state.
2. **Given** shell placement changes, **When** the UI updates optimistically and later rolls back, **Then** rollback affects only the fields in the failed mutation.
3. **Given** session-list state changes, **When** pane layout and workspace-session state are unchanged, **Then** those independent states are not rederived or clobbered by accident.

---

### User Story 6 - Live Focused-Pane Agent Identity (Priority: P1)

A developer can launch and exit different coding agents in the same terminal and the session card follows the focused pane's foreground process within the existing refresh cycle. Provider hooks enrich the card when available but never keep an exited or replaced provider visible.

**Why this priority**: Persisted launch metadata and delayed or missing provider end hooks can leave terminal cards showing the wrong agent, model, or task after the foreground process has changed.

**Independent Test**: Advance one terminal through `Terminal → Claude → Terminal → Codex → Terminal` while polling session summaries every five seconds. Each refresh must show only the currently observed provider and matching enrichment, with plain-terminal layout restored after each agent exits.

**Acceptance Scenarios**:

1. **Given** a plain terminal, **When** Claude is launched manually in its focused pane, **Then** the next refresh identifies Claude even on a first-run or authentication screen with no hook snapshot.
2. **Given** Claude is observed with matching hook enrichment, **When** Claude exits to the shell, **Then** the next refresh removes the Claude badge, subtitle, action, model, strength, and agent timestamp.
3. **Given** Claude previously populated enrichment, **When** Codex becomes the focused pane's foreground command, **Then** Codex appears immediately without inheriting any Claude enrichment.
4. **Given** several panes exist, **When** their foreground commands differ, **Then** only the focused terminal pane determines the session's live agent identity.
5. **Given** focused-pane inspection is unavailable, **When** a non-ended hook snapshot exists, **Then** Matrix may use that snapshot; otherwise it may use the persisted launch provider for no more than 12 seconds.
6. **Given** a successful focused-pane observation reports a shell or unrecognized command, **When** stale hook or launch metadata exists, **Then** runtime truth wins and the response omits every agent-specific field.

### Edge Cases

- A user upgrades with old saved `waiting` or `running` metadata from a previous release.
- A shell has output but no command boundary markers.
- A shell has command boundary markers but no recent output.
- A terminal session is listed by the runtime but has no saved metadata.
- Saved metadata exists for a runtime session that has exited.
- A pane layout references a session that no longer exists.
- The same runtime session is reachable through multiple aliases.
- Browser refresh happens during a session refresh request.
- Session refresh times out while delete, rename, or reorder is in flight.
- A user switches tabs rapidly while a terminal WebSocket is reconnecting.
- A terminal WebSocket disconnects without a clean close event.
- A background terminal is still running while the sidebar is collapsed.
- A terminal delete succeeds server-side but the client refresh fails.
- A terminal delete fails and the optimistic UI has already removed the row.
- The runtime host is reachable but session-listing is temporarily degraded.
- A recognized agent is displaying setup, first-run, or authentication UI before hooks start.
- The focused pane changes while another pane continues running an agent.
- Zellij returns malformed pane JSON, a missing command, or a command wrapped with `env`.
- A provider changes without the prior provider emitting a session-end hook.

## Requirements *(mandatory)*

### Findings Inventory

- **F-001 Sticky waiting metadata**: Saved visual status can keep a live shell looking stuck because waiting metadata is treated as authoritative even when newer runtime activity exists.
- **F-002 Mixed status authorities**: Runtime liveness, saved UI metadata, scrollback activity, pane layout, and workspace-session state all influence the visible terminal state without a single documented precedence model.
- **F-003 Tab lifecycle ambiguity**: Switching tabs, backgrounding panes, detaching transports, and reattaching are not governed by a clear invariant that process lifecycle is independent from UI focus.
- **F-004 Synthetic session fallback risk**: The UI can render synthetic shell rows from open panes when authoritative session data is unavailable, which may hide backend/session-list failures.
- **F-005 Silent stale refresh risk**: Silent polling failures preserve last-known state without consistently labeling it stale to the user.
- **F-006 Legacy session-id recovery gap**: Older session identifiers can still appear in saved state or user actions; validation and reconciliation must support recovery paths before rejecting them.
- **F-007 Giant terminal component**: The shell terminal UI owns too many unrelated states in one component, making targeted fixes and regression tests harder than necessary.
- **F-008 Optimistic mutation complexity**: Delete, rename, reorder, placement, and seen-state mutations use local optimistic updates that can interleave with background refreshes.
- **F-009 Reattach observability gap**: The product lacks a clear user-visible distinction between a live process, a detached view, a reconnecting transport, a stale status, and an exited session.
- **F-010 Insufficient upgrade-state tests**: Current tests cover many fresh-state flows, but not enough upgraded persisted-state cases where old metadata survives into a new bundle.
- **F-011 Incomplete end-to-end lifecycle proof**: There is no single acceptance test proving a process keeps running across tab switch, backgrounding, refresh, reconnect, and return.
- **F-012 Operational diagnosis dependency**: Live incident diagnosis can be blocked when the expected smoke SSH key no longer authenticates, so platform-side and product-side evidence paths need to be stronger.
- **F-013 Persisted agent identity masquerades as live state**: The saved launch provider and non-authoritative hook snapshots can outlive the foreground process, causing stale badges and cross-provider metadata leakage.

### One-by-One Work Order

1. **Slice 1: Fix sticky visual status** - Covers F-001 and F-010. Deliver a failing regression test first for upgraded persisted state where old waiting/running metadata survives into a newer bundle, then make current runtime/activity evidence override stale visual metadata.
2. **Slice 2: Prove process lifecycle across tab changes** - Covers F-003 and F-011. Deliver a lifecycle regression proving focus, backgrounding, refresh, and reconnect do not kill, duplicate, or permanently detach terminal processes.
3. **Slice 3: Define one session truth model** - Covers F-002, F-006, and F-009. Deliver the documented precedence model and gateway/shell reconciliation behavior for runtime sessions, saved metadata, pane references, workspace aliases, and legacy identifiers.
4. **Slice 4: Make stale refresh visible and recoverable** - Covers F-004, F-005, and F-008. Deliver stale-state UX and field-scoped optimistic rollback behavior for terminal session list refresh, delete, rename, reorder, placement, and seen-state operations.
5. **Slice 5: Extract terminal state seams** - Covers F-007. Deliver testable terminal session state helpers or stores that isolate shell/session refresh behavior from unrelated file, project, and agent-menu state.
6. **Slice 6: Add non-SSH operational diagnostics** - Covers F-012. Deliver a supported status path for customer runtime/session health when direct VPS SSH is unavailable, using coarse metadata only.
7. **Slice 7: Track focused-pane agent identity** - Covers F-013. Make the focused pane foreground command authoritative, retain hooks as provider-matched enrichment, and prove the complete Terminal/Claude/Terminal/Codex/Terminal lifecycle within five-second polling.

### Planning Readiness Review

- **MVP slice**: Slice 1 is the correct first task group because it targets the reported "visually stuck" symptom with the smallest blast radius.
- **Implementation shape**: Plan each slice as an independently reviewable PR. Do not combine the state-architecture extraction with the sticky-status fix.
- **TDD requirement**: Every slice must start with failing tests. The first slice needs upgraded persisted-state tests before implementation.
- **Frontend evidence**: Any slice that changes terminal visible status, stale labels, recovery actions, or sidebar behavior needs screenshot or screen-recording evidence.
- **Public docs**: Implementation planning must include a docs update if user-visible terminal recovery language or operator diagnostic workflow changes.
- **Spec Kit pointer**: `.specify/feature.json` is intentionally not part of this PR's durable diff. For local planning, point Spec Kit at `specs/098-terminal-session-reliability` before running plan/tasks commands.

### Functional Requirements

- **FR-001**: Matrix MUST define and document the precedence order for terminal session truth: runtime existence, runtime activity, durable user preferences, saved metadata, pane layout, and workspace-session aliases.
- **FR-002**: Matrix MUST ensure saved visual status cannot indefinitely override newer runtime or activity evidence.
- **FR-003**: Matrix MUST expire transitional visual states after a bounded period unless current runtime evidence renews them.
- **FR-004**: Matrix MUST preserve terminal process lifecycle across tab switches, sidebar collapse, browser refresh, WebSocket reconnect, and UI focus changes.
- **FR-005**: Matrix MUST reattach returning views to the original runtime session when it is still live.
- **FR-006**: Matrix MUST avoid creating duplicate runtime sessions during reattach or recovery.
- **FR-007**: Matrix MUST identify stale session-list data in the user interface when refresh fails or times out.
- **FR-008**: Matrix MUST keep last-known terminal state usable during transient failures while clearly marking it as stale.
- **FR-009**: Matrix MUST provide a user action to retry or recover stale terminal state without requiring manual file edits.
- **FR-010**: Matrix MUST reconcile saved pane/session references during normal shell reads, not only during explicit cleanup jobs.
- **FR-011**: Matrix MUST support recovery of known legacy session-id forms during open, delete, and layout reconciliation flows.
- **FR-012**: Matrix MUST keep terminal close/delete operations scoped to the explicitly selected session.
- **FR-013**: Matrix MUST keep optimistic UI rollbacks field-scoped so a failed mutation does not clobber unrelated fresh refresh data.
- **FR-014**: Matrix MUST separate or isolate terminal UI state domains enough that session refresh behavior can be tested independently from file-tree, project-list, and agent-install menu behavior.
- **FR-015**: Matrix MUST add regression coverage for upgraded persisted-state cases, including stale waiting metadata, stale running metadata, missing runtime sessions, and legacy identifiers.
- **FR-016**: Matrix MUST add a lifecycle test that proves a long-running terminal process remains live across tab switching, backgrounding, refresh, reconnect, and return.
- **FR-017**: Matrix MUST provide an operator-readable status path for terminal/session health that does not depend solely on direct SSH access to the customer VPS.
- **FR-018**: Matrix MUST avoid exposing provider errors, raw filesystem paths, or raw runtime failures in user-facing terminal recovery messages.
- **FR-019**: Matrix MUST derive live agent identity from the focused terminal pane's validated foreground command whenever pane inspection succeeds.
- **FR-020**: Matrix MUST recognize only the exact allowlisted commands `claude`, `codex`, `opencode`, and `pi`, including safely parsed `env` wrappers, and MUST NOT use substring matching.
- **FR-021**: A successful observation of a shell, missing command, or unrecognized command MUST omit `agent`, `subtitle`, `lastAction`, `agentUpdatedAt`, `model`, and `strength` from the session response.
- **FR-022**: Hook enrichment MUST be exposed only when its provider matches the observed agent and its phase is not `ended`; an observed recognized agent without compatible enrichment MUST fall back to `running`.
- **FR-023**: When focused-pane inspection is unavailable, Matrix MAY fall back to a non-ended hook snapshot, then to the persisted launch hint for at most 12 seconds.
- **FR-024**: Session-start and provider-change events MUST reset subtitle, action, model, and strength before applying new-provider event fields, and ended snapshots MUST NOT derive an active visual status.
- **FR-025**: `GET /api/terminal/sessions` MUST retain its compatible optional response fields, with `agent` defined as the currently observed or safely degraded active agent rather than the originally launched provider.
- **FR-026**: Matrix MUST retain the existing five-second session polling contract and MUST NOT require provider session-end hooks for correct exit or provider-switch behavior.

### Security Architecture

#### Auth Matrix

| Surface | Actor | Required Authorization | Notes |
| --- | --- | --- | --- |
| Terminal session list | Runtime owner | Own runtime only | Shows live, stale, exited, and recoverable sessions for that owner. |
| Terminal session attach | Runtime owner | Own runtime and session alias resolved to owner-owned session | Must not attach to another user's runtime session. |
| Terminal session delete | Runtime owner | Own runtime and explicit target session | Delete must be scoped to one selected session. |
| Terminal UI-state update | Runtime owner | Own runtime and explicit target session | Durable UI preferences must not create fake liveness. |
| Terminal layout restore | Runtime owner | Own runtime and owner-owned layout file | Stale references are recoverable, not trusted as live sessions. |
| Terminal health diagnostics | Runtime owner or operator automation | Coarse owner/runtime health only | No raw provider errors or secrets in user-visible responses. |

#### Input Validation and Error Policy

- Session names, aliases, legacy identifiers, pane identifiers, layout references, and query parameters MUST be validated at the route boundary before use.
- Recovery paths MUST distinguish invalid input from recoverable legacy identifiers.
- User-facing terminal errors MUST use coarse, actionable categories such as reconnecting, stale, exited, recoverable, and unavailable.
- Logs may include enough diagnostic detail for operators, but client responses MUST NOT expose provider errors, filesystem paths, tokens, private host details, or raw runtime command output.
- Foreground command text is internal classification input only. Session responses MUST expose the allowlisted agent identity, never the raw command or arguments.
- Health checks and reachability probes MUST return coarse status only.

#### Resource Management

- Any in-memory session, reconnect, or subscriber registries touched by this work MUST retain explicit caps and stale-entry eviction.
- Terminal WebSocket subscribers MUST be evicted when sends fail or connections go stale.
- Polling and retry loops MUST be bounded and cancelable when components unmount or users leave the surface.
- Focused-pane observation caches MUST be capped and expire before the next five-second refresh can reuse stale foreground-process data.
- Durable session metadata updates MUST remain atomic and must not corrupt owner files if a write fails.
- Stale/recoverable session metadata cleanup MUST be safe for owner data and must not delete active runtime sessions.

#### Integration Wiring

- The shell must receive one coherent session summary from the gateway, including liveness, visual status, stale/recoverable flags, attach target, unread state, and safe user actions.
- The gateway must reconcile runtime sessions, scrollback/activity evidence, saved shell metadata, and pane/layout references before returning session summaries.
- The gateway must obtain focused cwd and foreground command from the same bounded Zellij pane inspection and apply runtime-agent precedence before serializing a session summary.
- Browser terminal views must reattach through the owner-authorized WebSocket/session path after tab switch, refresh, and reconnect.
- Operator diagnostics must be available through an authenticated platform or gateway path even when direct VPS SSH is unavailable.

#### Failure Modes

- If session-list refresh fails, keep previous rows usable but label them stale.
- If attach fails while the runtime session is still listed, show reconnect/retry instead of creating a duplicate session.
- If attach fails because the runtime session exited, show exited/recoverable state and offer a new session action.
- If delete succeeds but post-delete refresh fails, remove the deleted session locally and mark the list stale until refresh succeeds.
- If delete fails, restore only the deleted row's optimistic state.
- If saved metadata is corrupt or references impossible sessions, ignore the broken portion, preserve owner data, and surface a recoverable state.
- If focused-pane inspection fails or returns malformed data, use only the bounded degraded fallback chain; do not reinterpret the failed observation as a successful shell observation.
- If a provider hook is delayed, missing, mismatched, or never emits session end, the next successful pane observation still determines the visible agent identity.

### Key Entities *(include if feature involves data)*

- **Runtime Session**: The actual terminal runtime process/session that may be active, exited, detached, or unavailable.
- **Session Summary**: The owner-visible row/card describing liveness, visual status, stale state, unread state, attach target, and allowed actions.
- **Durable UI Metadata**: Owner-controlled saved preferences such as placement, last seen output, order, and display metadata.
- **Activity Evidence**: Recent terminal output and command boundary marks used to infer running, finished, idle, or waiting state.
- **Focused-Pane Runtime Observation**: A bounded Zellij inspection result containing the focused pane's validated cwd and foreground command plus whether observation succeeded.
- **Pane Reference**: A shell layout reference to a terminal session that may be live, stale, or recoverable.
- **Workspace Session Alias**: A higher-level session record that may point at the same runtime terminal session.
- **Stale State Marker**: A user-visible indicator that Matrix is showing last-known state because refresh or attach evidence is incomplete.
- **Recovery Action**: A safe user action to retry refresh, reattach, remove a stale reference, or start a new session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A terminal session with stale waiting metadata updates to running, finished, idle, or exited within one refresh cycle after current runtime evidence is available.
- **SC-002**: A long-running process survives 100% of tested tab switch, background, refresh, reconnect, and return flows unless the user explicitly closes or kills it.
- **SC-003**: In tested refresh-timeout scenarios, the UI labels terminal data stale within 10 seconds and provides an explicit retry or recovery action.
- **SC-004**: In tested legacy-id scenarios, open and delete flows either recover the session or return a safe user-facing error without route-level validation blocking recovery.
- **SC-005**: No tested attach or reattach flow creates duplicate runtime sessions for the same live process.
- **SC-006**: No tested delete flow removes or kills a session other than the explicitly selected target.
- **SC-007**: Upgraded persisted-state tests cover stale waiting metadata, stale running metadata, missing runtime session, duplicate aliases, and stale pane references.
- **SC-008**: Terminal session state tests can exercise refresh/reconcile behavior without rendering unrelated file-tree, project-list, or agent-install menu UI.
- **SC-009**: User-facing terminal/session recovery errors expose no raw provider errors, filesystem paths, tokens, or host internals in 100% of tested failures.
- **SC-010**: Operator diagnostics can confirm terminal session health for a customer runtime without requiring direct SSH access in at least one supported path.
- **SC-011**: The tested `Terminal → Claude → Terminal → Codex → Terminal` lifecycle updates identity, enrichment, logos, labels, and compact card height within each five-second refresh, with zero prior-provider fields remaining after an exit or switch.

## Assumptions

- The runtime process must outlive UI focus changes by default.
- A user explicitly closing or deleting a terminal is the only normal UI action that should terminate that terminal session.
- Durable UI metadata is owner data and should be repaired conservatively, not blindly deleted.
- The shell can keep last-known state during outages, but it must label that state stale when freshness cannot be confirmed.
- The first implementation slice should fix the sticky visual-status behavior before larger component extraction.
- Public documentation updates are required once product-visible behavior or recovery language changes.
