# Feature Specification: Project sidebar actions

**Feature Branch**: `codex/project-sidebar-actions`
**Created**: 2026-09-20
**Status**: Ready for implementation
**Issue**: https://github.com/HamedMP/matrix-os/issues/1770
**Input**: Codex-inspired project row; move accidental-delete affordance into a menu and add Pin, Edit, and Reveal in Finder.

## User Scenarios & Testing

### User Story 1 - Safely create Chats (Priority: P1)
Users create a Chat from a project row without encountering a neighboring destructive button.
**Why this priority**: The current trash button is easily mistaken for New Chat.
**Independent Test**: Hover/focus a row, create a Chat, and open both action menus.
**Acceptance Scenarios**:
1. Given a project row, when hovered or focused, then it exposes an ellipsis followed by New Chat; no inline Delete button is present.
2. Given the ellipsis or right-click menu, when opened, then identical project actions appear; Delete is separated and destructive.
3. Given Delete, when selected, then existing explicit confirmation is required; cancellation or failure preserves the project and Chats.

### User Story 2 - Pin and edit a project (Priority: P2)
Users keep important projects near the top and edit their display information.
**Why this priority**: Frequently used projects need quick access and recognizable names.
**Independent Test**: Pin, reload, unpin, and edit a project without changing its Chats or folder.
**Acceptance Scenarios**:
1. Given an unpinned project, when Pin succeeds, then it is visibly pinned above unpinned projects and remains pinned after reload; Unpin reverses this.
2. Given Edit, when a valid name and description are saved, then every project projection displays the new information while project identity, location, and Chat associations stay unchanged.
3. Given invalid input or a failed save, then edits stay available with safe error feedback and no false success.

### User Story 3 - Locate project files (Priority: P2)
Users open the actual project folder from its menu.
**Why this priority**: Project files should be reachable from their project context.
**Independent Test**: Locate a project on the connected runtime and verify the opened directory.
**Acceptance Scenarios**:
1. Given a verified local macOS project, when Reveal in Finder is chosen, then Finder reveals its actual folder.
2. Given a remote project or browser client, when Open in Files is chosen, then Matrix Files opens its runtime folder; the client never interprets a remote path as a local path.
3. Given an unavailable folder/capability, then the action is disabled or returns safe actionable feedback without opening a guessed directory.

### Edge Cases
- Long names, duplicate display names, empty/oversized edits, archived/deleted projects.
- Runtime/account changes while saving; repeated clicks; read-only or offline runtime.
- Keyboard invocation, Escape dismissal, focus return, touch access without hover.
- Existing pinned Chats retain their current behavior and order.

## Requirements

### Functional Requirements
- **FR-001**: Remove inline project deletion; preserve direct New Chat as the rightmost row action.
- **FR-002**: Ellipsis and context menu must share Pin/Unpin, Edit, location, and separated Delete actions.
- **FR-003**: Persist pin state in the authoritative owner project model; keep stable ordering within pin groups.
- **FR-004**: Edit display name and description only; preserve immutable identity, slug, workspace and related resources.
- **FR-005**: Reuse existing deletion confirmation and semantics, with honest permanent-deletion copy.
- **FR-006**: Resolve folder location against the connected runtime; enable Finder only with verified local capability.
- **FR-007**: Equivalent actions and state must be available on Web Canvas, Web Desktop and Electron Desktop wherever project navigation is mounted. Web Mobile and Native Mobile must receive equivalent actions where their project navigation exists; document actual platform limitations.
- **FR-008**: Menus support keyboard, focus return and touch; actions provide pending/error feedback and prevent duplicate submissions.
- **FR-009**: Mutations require owner authorization, bounded validated input, safe error handling and runtime-scoped state updates.
- **FR-010**: Add regression tests before implementation and deliver a public documentation PR in `FinnaAI/matrix-os-site`.

### Key Entities
- Project: stable identity and location, editable display name/description, persisted pinned state.
- Project action menu: one action model exposed through ellipsis and contextual invocation.

## Assumptions and Scope
The screenshots are visual references, not instructions to copy every Codex feature. Section management, permanent worktrees and bulk Chat archival are excluded. Pin orders projects above other projects; it does not duplicate their Chats into the existing pinned-Chat section. Edit does not relocate folders. Human Review and production release are separate from implementation validation.

## Success Criteria

### Measurable Outcomes
- **SC-001**: Zero inline destructive project buttons remain in the affected navigation.
- **SC-002**: Every menu action is reachable through mouse and keyboard; touch clients can open the menu directly.
- **SC-003**: Pin and display edits survive reload with unchanged project identity and Chat associations.
- **SC-004**: Local and remote location tests open only the corresponding runtime folder.
- **SC-005**: All regression tests for menu access, persistence, cancellation, failure and runtime switching pass.

## Confirmed platform limitations
Electron Desktop currently connects to runtime-owned projects with no trusted local Mac mapping or Finder IPC. Ship Open in Files through the existing project-scoped file browser; do not expose a nonfunctional Finder command. Finder support requires a future trusted local mapping capability. Native Mobile has a creation-only project picker, not a project-management sidebar; this change does not introduce a native project manager. The hosted sidebar is an Electron Desktop presentation, not the Next.js Web Desktop/Web Canvas Chat sidebar. Current Web Desktop, Web Canvas and Web Mobile Chat have no project-group navigation. This issue updates existing Electron Desktop project navigation only; introducing project navigation on those surfaces is a separate prerequisite. The metadata API is renderer-neutral.
