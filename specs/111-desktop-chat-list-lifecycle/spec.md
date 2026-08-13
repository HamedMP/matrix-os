# Feature Specification: Desktop Chat List Search and Delete

**Feature Branch**: implementation branch created after written-spec approval

**Linear Issue**: created after written-spec approval

**Spec Directory**: `specs/111-desktop-chat-list-lifecycle/`

**Created**: 2026-08-13

**Status**: Product design approved; written specification awaiting review

**Depends On**: MAT-299 persistent Hermes conversation index and switching

**Input**: Align the Electron Desktop conversation list with the latest Figma
handoff: remove bulk Select, keep Search and New chat, and expose a per-row
delete action on hover and keyboard focus.

## Problem

MAT-299 establishes the canonical Gateway-backed Hermes conversation index,
history loading, creation, switching, reconnect attachment, and runtime-safe
invalidation. The latest Desktop Figma handoff changes the remaining list
interaction model:

- the previous top-level `Select` control is removed;
- Search remains a first-class list action;
- deletion is a row-level action revealed on hover or keyboard focus; and
- unsupported bulk selection and archive behavior must not be inferred.

The current Gateway has a conversation delete route, but it accepts an
unvalidated path identifier, performs synchronous deletion, has no body-limit
middleware, and does not reject deletion of an active run. It is not safe to
wire directly to a destructive Desktop control.

## Design Evidence and Boundary

The current signed-in Figma canvas and designer comment thread were inspected
on 2026-08-13. Direct `get_design_context` remained unavailable because the
Professional View-seat MCP call limit was exhausted. This specification uses
the visible Ready-for-dev canvas and the designer's explicit comment that the
top Select control was removed and delete should appear on row hover.

Figma Sandbox comments about collaboration avatars, overflow menus, unified
coding chat, Terminal themes, Files column navigation, and project worktrees
are not Ready-for-dev requirements for this feature.

## Product Decisions

1. The conversation list uses the latest flat-row visual hierarchy and retains
   `Search` and `New chat` in its header.
2. Search filters the bounded canonical index already loaded from the Gateway.
   It matches derived title and preview text case-insensitively; it does not
   claim full-transcript search.
3. Each idle conversation row exposes one destructive delete icon on pointer
   hover and when the row or action receives keyboard focus.
4. The delete action is a separate button, stops row-open propagation, and is
   available without entering a selection mode.
5. Delete requires a confirmation dialog naming the conversation. It does not
   require typing the title because the deleted scope is one conversation and
   the action is already row-specific.
6. A conversation with an active run cannot be deleted. The renderer disables
   the action when it knows the run is active, and the Gateway independently
   rejects stale or competing delete requests.
7. The renderer removes a row only after the Gateway confirms deletion. Failed
   deletion leaves the conversation visible and retryable.
8. Bulk select, bulk delete, archive, collaboration avatars, rename, Voice,
   project context, repository context, and MAT-268 are excluded.

## User Scenarios and Acceptance

### User Story 1 — Find a Conversation (P1)

A user can narrow the visible conversation list without creating another
server-owned search index.

**Independent Test**: Load at least three canonical conversations, open Search,
enter text matching one title and one preview, and verify only matching rows
remain without changing the canonical store.

1. Search opens from the Figma-aligned header icon and immediately focuses its
   input.
2. Matching is case-insensitive and ignores leading and trailing whitespace.
3. Clearing or closing Search restores the current Gateway-provided list.
4. No match renders `No matching chats` and keeps New chat available.
5. Loading, initial error, stale-data warning, and empty-index states remain
   distinguishable from a no-match state.
6. A runtime switch clears the query and cannot repopulate results from the
   previous computer.

### User Story 2 — Delete an Idle Conversation (P1)

A user can permanently delete one idle conversation from its row.

**Independent Test**: Hover and keyboard-focus an idle row, open the delete
confirmation, confirm, and verify the Gateway record disappears before the
Desktop row is removed.

1. Hovering a row or focusing within it reveals the delete action without
   shifting the title, provider, or timestamp columns.
2. Activating delete never opens the conversation.
3. Cancel closes the dialog and sends no request.
4. Confirm disables repeated submission until the request settles.
5. Success removes the row and clears the selected transcript only when the
   deleted conversation was selected.
6. A stale 404 reconciles by refreshing the canonical list and reports no raw
   server detail.
7. A server, timeout, or conflict error keeps the row and dialog recoverable.

### User Story 3 — Protect an Active Conversation (P1)

A running conversation is never deleted underneath an active Kernel turn.

**Independent Test**: Start a turn, attempt deletion from a second client or a
stale UI, and verify the Gateway returns a conflict and retains the record.

1. Desktop disables delete for its known active Hermes session and explains
   that the response must be stopped first.
2. Gateway active-run state is authoritative; a stale renderer cannot bypass
   it.
3. Once the run is idle and finalized, deletion can be retried normally.

## UX and Components

### Header and Search

- Preserve the current Desktop tokens, typography, spacing, and Lucide/Phosphor
  icon conventions; do not redesign the shell.
- Replace the standalone title block used by the first MAT-299 implementation
  with the Figma-aligned `Chats` header and compact actions.
- Search expands inline in the header or immediately below it without changing
  the list route. Escape closes it, and the search icon has an accessible name.
- Filtering is derived with a pure helper and `useMemo`; Zustand selectors do
  not allocate filtered arrays.

### Conversation Row

- Use a flat row with stable title, provider, and relative-activity columns.
- The delete action uses `group-hover` and `focus-within`; opacity alone must
  not leave an unfocusable hidden button in the tab order.
- Keep a visible focus ring on the row and action. The action is reachable by
  keyboard and has `aria-label="Delete <title>"`.
- Running and opening indicators remain available without changing column
  widths.

### Confirmation and Feedback

- Use the existing Desktop dialog primitive and danger tokens.
- Copy states that deletion is permanent and affects only the selected chat.
- Do not expose session IDs, filesystem paths, provider names, or raw errors.
- Success and failure feedback uses the shared Desktop notification/dialog
  patterns rather than a new fixed overlay stack.

## Architecture

### Renderer

Extend the MAT-299 Hermes store with one mutation:

```ts
deleteConversation(api: ApiClient, id: string): Promise<boolean>
```

The store validates the ID using the shared conversation ID schema, captures
the runtime generation, sends the request, and applies the result only when the
same runtime is still active. It does not optimistically remove the row.

Search state remains component-local and ephemeral. A pure helper receives the
bounded `HermesConversationSummary[]` and normalized query and returns the
filtered projection. Search never becomes a second source of truth.

### Gateway Conversation Deletion

Move destructive route behavior behind an async ConversationStore operation:

```ts
delete(id: KernelConversationId): Promise<"deleted" | "not_found" | "busy">
```

The route and store must:

- validate `:id` with the shared Zod 4 conversation ID schema;
- install `bodyLimit` before the DELETE handler even though the body is unused;
- check the authoritative active-run registry before filesystem mutation;
- serialize delete against finalization and context mutation for the same ID;
- use async, symlink-safe filesystem operations;
- remove active buffers only after the persisted record is removed; and
- map internal errors to bounded client codes while logging detail server-side.

The keyed serialization registry must be capped and evicted after idle use. No
new unbounded Map is permitted.

## HTTP and Auth Matrix

| Route | Method | Auth | Validation | Purpose |
|---|---|---|---|---|
| `/api/conversations` | GET | Verified runtime principal through existing Gateway auth | Existing bounded response schema | Load canonical summaries used by Search. |
| `/api/conversations/:id` | DELETE | Verified runtime principal through existing Gateway auth | `bodyLimit`; `KernelConversationIdSchema` at route boundary | Permanently delete one idle canonical conversation. |

No public route is introduced. The renderer cannot choose an owner scope, file
path, provider, or runtime identity through request data.

## Error Contract

Internal failures map to stable client codes and safe messages:

- `conversation_not_found` — refresh the list;
- `conversation_busy` — stop the active response and retry;
- `conversation_delete_unavailable` — keep the row and retry later; and
- `invalid_conversation_id` — reject before store access.

The Desktop allowlists these codes. Unknown, long, path-looking,
provider-looking, database-looking, or credential-looking strings fall back to
`Chat could not be deleted. Try again.`

## Concurrency and State Invariants

- **Source of truth**: Gateway ConversationStore; Desktop is a bounded cache.
- **Mutation ordering**: The visible list changes only after confirmed delete.
- **Run safety**: Gateway active-run state, not renderer status, decides whether
  deletion is allowed.
- **Runtime safety**: A response from a previous computer/account generation is
  discarded.
- **Acceptable orphan state**: A stale renderer may temporarily display a row
  already deleted by another shell until refresh.
- **Unacceptable orphan state**: Removing the renderer row while the Gateway
  record remains, or deleting a record while its Kernel turn is active.

## Testing Strategy

Tests are written first.

### Desktop Unit and Component Tests

- query normalization, title matching, preview matching, and stable ordering;
- no-match versus empty/loading/error states;
- hover and focus-visible delete affordance;
- delete click does not open the row;
- confirmation cancel, pending, success, 404 refresh, busy, timeout, and server
  failure;
- active-run disabled state and safe copy;
- runtime-switch invalidation during delete; and
- unknown error-string allowlisting.

### Gateway and Contract Tests

- valid idle deletion and repeated 404;
- invalid/traversal-shaped IDs rejected before filesystem access;
- body-limit enforcement on DELETE;
- active-run rejection under a stale client;
- delete/finalize serialization;
- symlink record rejection;
- async failure maps to a generic response; and
- keyed-lock cap and cleanup.

### Electron Evidence

Build and run the real Electron Desktop under Flox, then capture equal-viewport
evidence for:

- default list;
- Search with matches and no matches;
- row hover and keyboard focus;
- confirmation dialog;
- busy/error state; and
- successful deletion followed by canonical refresh.

Compare the reference and implementation screenshots side by side at the same
viewport. A screenshot alone is not acceptance evidence; the delete request,
Gateway record, keyboard flow, and post-delete refresh must also be observed.

## Delivery and Documentation

- Implementation lands after MAT-299 or rebases onto its merged canonical
  conversation-index contract.
- Use one focused implementation PR and one independent top-level Codex Task.
- Keep Linear at `PR In Review` until merge and read back PR, reviewer, CI,
  Greptile 5/5, and Linear state.
- Add a separate public documentation PR to `FinnaAI/matrix-os-site` describing
  Desktop chat discovery and deletion after behavior is implemented. Do not
  recreate a local `www/` tree.

## Explicitly Deferred

- full-transcript/global search;
- bulk select and bulk actions;
- archive and restore;
- rename;
- Voice;
- collaboration avatars and shared conversations;
- project/repository context (specified separately in
  `specs/112-desktop-chat-project-context/`);
- Sandbox proposals for coding-chat convergence, worktrees, Terminal, Files,
  and shell navigation; and
- all MAT-268 behavior.
