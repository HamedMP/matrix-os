# Feature Specification: File deletion and Trash

**Feature Branch**: `634-complete-file-trash`
**Created**: 2026-10-20
**Status**: Draft
**Input**: Add working deletion in File Manager, confirmation before moving files, and a Trash app with an AI-generated icon, recovery, and empty-Trash controls.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Move files to Trash safely (Priority: P1)

As an owner browsing files, I can select a file or folder and choose **Move to Trash** from its context menu, File Manager actions, or a delete keyboard shortcut. A modal identifies what I selected, explains that folders include their contents, and says the items can be restored. Nothing moves until I confirm.

**Why this priority**: The reported menu lacks Delete, and all delete entry points need the same safe behavior.

**Independent Test**: Create a file and a folder, invoke each entry point, cancel once, then confirm. Both disappear from their original locations and appear intact in Trash.

**Acceptance Scenarios**:

1. **Given** a writable file is selected, **when** I choose Move to Trash, **then** a modal names the file and offers Cancel and Move to Trash; the file stays put until confirmation.
2. **Given** a folder or multiple items are selected, **when** I request deletion, **then** the modal identifies the selection or count and warns that folder contents move too.
3. **Given** the modal is open, **when** I cancel, press Escape, or dismiss it, **then** no item moves and the selection remains available.
4. **Given** I confirm, **when** the move finishes, **then** the source and Trash show the new state, including after reopening the app.
5. **Given** a batch partly fails, **when** the operation finishes, **then** failed items remain selected at their original locations and I see which items succeeded or failed.

---

### User Story 2 - Find and recover deleted items (Priority: P1)

As an owner, I can launch **Trash** from the app launcher or a desktop shortcut and reach it from File Manager. I can recognize deleted items by name, original location, type, and deletion time, then restore one, several, or all items.

**Why this priority**: A recoverable deletion is useful only when Trash and Restore are easy to find.

**Independent Test**: Trash same-named files from different folders and a folder with contents, reopen Trash, restore them, and verify their exact contents and original paths.

**Acceptance Scenarios**:

1. **Given** I open Trash from any entry point, **when** it loads, **then** I see the same scoped items and count with clear loading, empty, and error states.
2. **Given** an item's original location is free, **when** I restore it, **then** it returns intact and disappears from Trash.
3. **Given** multiple items are selected, **when** I restore them, **then** eligible items return and failures remain in Trash with an accurate result summary.
4. **Given** another item occupies the original name, **when** I restore, **then** it is never overwritten; I can choose another name/location or cancel while keeping the trashed item.
5. **Given** the original parent no longer exists, **when** I restore, **then** I can recreate that location or restore elsewhere; cancellation keeps the item in Trash.
6. **Given** Trash contains many items, **when** I search by name or original location or sort by deletion time, **then** I can find the intended item without changing any file.

---

### User Story 3 - Permanently remove items (Priority: P2)

As an owner, I can permanently delete selected Trash items or choose **Empty Trash** for the current scope. A distinct confirmation modal warns that the action cannot be undone and shows the affected count.

**Why this priority**: A computer-style Trash needs both selective cleanup and a clear way to reclaim space.

**Independent Test**: Permanently delete one selected item, restore the rest, refill Trash, and empty it; verify only the intended items are removed at each step.

**Acceptance Scenarios**:

1. **Given** selected Trash items, **when** I choose Delete Permanently, **then** a modal identifies the selection and requires explicit confirmation.
2. **Given** Trash has items, **when** I choose Empty Trash, **then** a modal shows the count and irreversible consequence; Cancel leaves all items recoverable.
3. **Given** I confirm, **when** removal completes, **then** removed items cannot be restored through Trash and the count updates after reload.
4. **Given** removal partly fails, **when** the result appears, **then** surviving items remain listed and recoverable with an accurate failure summary.
5. **Given** Trash is empty, **when** I open it, **then** Restore All and Empty Trash are unavailable and the empty state explains the bin.

---

### User Story 4 - Recognize Trash across Matrix OS (Priority: P2)

As an owner, I can recognize and open Trash like a standard computer app. Its icon is an original AI-generated illustration of a bin, polished at app-icon size and aligned with Matrix OS's visual language. The visible label remains the primary accessible cue.

**Why this priority**: The user requested a distinct Trash app with a cool AI-generated icon.

**Independent Test**: Find and launch Trash from the app launcher and applicable desktop/mobile entry points; inspect the icon and label in light and dark themes at small and large sizes.

**Acceptance Scenarios**:

1. **Given** the app launcher is visible, **when** I search or browse, **then** I see a labeled Trash entry with the generated icon and opening it shows Trash directly.
2. **Given** a classic desktop theme has Recycle Bin, **when** I open it, **then** I reach the same Trash contents and actions without a second bin.
3. **Given** the artwork cannot load, **when** Trash renders, **then** a clear static fallback and the label remain usable.

### Edge Cases

- Selecting a parent and child together must not produce duplicate entries or a misleading result.
- Same-named items from different folders and repeated deletions of the same path remain distinct.
- If a file changes or vanishes after selection, the operation fails truthfully or refreshes confirmation instead of affecting an unintended replacement.
- Protected, read-only, shared, and inaccessible locations cannot be silently moved, exposed across owners, restored across scopes, or permanently deleted without authority.
- A symlink or path escape cannot reach a protected target.
- Open previews/editors with unsaved changes warn or block before the backing file moves; they cannot imply unsaved edits were preserved.
- Interrupted moves, restores, and empty operations reconcile actual state on reopen; an item cannot vanish from both source and Trash without explicit permanent deletion.
- Large folders and batches show a busy/progress state, prevent duplicate submissions, and show per-item outcomes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every File Manager delete entry point, including item context menus, selection actions, and keyboard shortcuts, MUST open the same confirmation modal before moving eligible files or folders to Trash.
- **FR-002**: The modal MUST describe the item or count, folder-content effect where relevant, recovery destination, and distinct Cancel and Move to Trash actions; cancellation MUST preserve files and selection.
- **FR-003**: A confirmed move MUST keep each item and its folder contents recoverable, preserving its name, original location, deletion time, and ownership scope across reloads and restarts.
- **FR-004**: Trash MUST be launchable as a labeled app and reachable from File Manager; all entry points MUST show the same scoped contents. Existing classic Recycle Bin entry points MUST work.
- **FR-005**: Trash MUST show each item's name, original location, type, deletion time, and distinct identity when names repeat; it MUST support single and multiple selection.
- **FR-006**: Owners MUST be able to restore selected items or all items to their original locations, preserving folder contents and reporting per-item outcomes.
- **FR-007**: Restore MUST never overwrite an existing item. A collision or missing parent MUST offer a safe alternate destination/name or cancellation while retaining the Trash entry.
- **FR-008**: Owners MUST be able to permanently delete selected Trash items and empty all items in the current scope, each behind an explicit irreversible-action confirmation. Empty Trash MUST be unavailable when empty.
- **FR-009**: Partial failure or interruption of move, restore, or permanent delete MUST leave a truthful, recoverable view of surviving items and a safe error summary; retry MUST not duplicate or destroy an item.
- **FR-010**: Trash MUST provide loading, empty, busy, success, and error states; actions MUST work with keyboard and screen reader, return focus predictably after modal dismissal, and fit compact windows and mobile widths.
- **FR-011**: A distinctive AI-generated Trash icon MUST ship as an app asset, recognizable at 16–64 px in supported themes, with a static fallback and visible label; opening Trash MUST NOT require live AI generation.
- **FR-012**: All file and Trash operations MUST respect current ownership and write permissions. Personal and organization scopes MUST remain separate; alternate entry points MUST NOT grant extra authority.
- **FR-013**: Web Canvas, Web Desktop, and Electron Desktop MUST provide equivalent actions and state semantics. Web Mobile and Native Mobile MUST provide the same flow wherever file management exists, adapted to their controls.
- **FR-014**: Moving to Trash MUST NOT silently discard unsaved edits in an open file preview or editor.
- **FR-015**: Trash MUST support finding items by name or original location and sorting by name or deletion time without affecting selection or recovery state.

### Key Entities

- **Trash item**: One recoverable deleted file or folder, identified independently from its display name; records original location, deletion time, type, and owner/scope.
- **Trash scope**: The personal or organization boundary that determines who may list, restore, or permanently remove items.
- **File selection**: The selected items and their state at confirmation time, used for accurate results.

### Assumptions and scope

- This covers files and folders in locations the current File Manager can modify. Read-only locations show a disabled action with an explanation. Organization drives participate where existing permissions allow writes, with a separate organization Trash scope.
- Trash items remain recoverable until explicitly deleted permanently or Trash is emptied; automatic expiration is outside this feature.
- Empty Trash removes items in the current scope only. This feature does not change external command-line deletion, provider trash, or files deleted before release.
- The dedicated Trash launcher may open the existing shared Trash experience. It does not require a duplicate store.
- The AI-generated icon is a design deliverable for implementation and review. It follows the existing Matrix OS design direction and preserves the classic theme's recognizable Recycle Bin behavior.

### Security and delivery constraints

| Route / operation | Required authority | Public? |
| --- | --- | --- |
| `POST /api/files/delete` — move to Trash | Authenticated owner or authorized scoped writer for source item | No |
| `GET /api/files/trash` — list Trash | Authenticated owner or authorized scoped reader for that Trash | No |
| `POST /api/files/trash/restore` — restore | Authenticated owner or authorized scoped writer for Trash item and destination | No |
| `POST /api/files/trash/empty` — empty scope | Authenticated owner or authorized scoped delete authority for affected items | No |
| Selected-item permanent delete and alternate-location restore (route names set during planning) | Same scope and destination checks as above | No |

The implementation plan must validate paths and selections at the operation boundary, enforce request-size and item-count limits, and reject path escape, symlink traversal, and cross-scope access. It must keep file movement and Trash records recoverable together, define cleanup and failure reconciliation, and return safe errors without internal paths or storage details. Tests must be written before implementation and exercise the full launcher-to-confirmation-to-Trash-to-restore and empty paths, reload persistence, permission denial, collision, partial failure, and every applicable OS view. A separate documentation PR in the private `FinnaAI/matrix-os-site` repository must update the public Files and Trash guidance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of first-time users in usability testing can move a file to Trash and restore it without assistance within two minutes.
- **SC-002**: In acceptance tests, 100% of File Manager delete entry points show confirmation before movement; cancellation causes zero moves.
- **SC-003**: In acceptance tests, 100% of moved files and folders retain their contents and original locations after reload and can be restored without overwriting another item.
- **SC-004**: In acceptance tests, 100% of Empty Trash and selected permanent-delete actions require distinct irreversible-action confirmation; cancellation removes zero items.
- **SC-005**: With 1,000 Trash items, the list becomes usable within three seconds on the supported test computer; a standard single-item move or restore shows its result within two seconds in at least 95% of local acceptance runs.
- **SC-006**: All applicable OS views pass the same move, restore, collision, permanent-delete, empty, loading, empty, and error-state scenarios, with zero cross-scope item exposure.
