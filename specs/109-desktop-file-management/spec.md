# Desktop File Management

**Tracking:** [MAT-268](https://linear.app/matrix-os/issue/MAT-268/add-desktop-file-crud-multi-select-and-drag-to-move) · [GitHub #1183](https://github.com/HamedMP/matrix-os/issues/1183)

## Summary

Upgrade the native Desktop Files workspace from a browse-and-preview surface into a safe structural file manager. Users can create files and folders, rename one item, select multiple sibling items, move them with a folder picker or internal drag and drop, and move them to Trash. The Gateway remains the source of truth for capabilities, conflicts, results, and reconciliation.

The browser Shell already exposes Finder-like file actions, but its current client-side store calls legacy single-item endpoints independently and does not provide the idempotent batch, capability, or partial-result guarantees required by Desktop. MAT-268 adds shared Gateway contracts first and consumes them from Desktop; it does not copy the Shell store into Electron.

## Scope

### In scope

- Create an empty file or directory in the open directory after explicit name submission.
- Rename exactly one selected item after explicit submission.
- Current-directory multi-selection with pointer, keyboard, and screen-reader parity.
- Batch `Move to…`, internal drag-to-folder/breadcrumb, and `Move to Trash` for at most 100 top-level source paths.
- Deterministic preflight conflicts with `Keep Both`, `Skip`, or `Cancel`; optional application of one choice to remaining conflicts.
- Per-item results and reconciliation after partial completion, timeout, reconnect, or Gateway restart.
- Server-provided `canRename`, `canMove`, and `canTrash` capabilities on listed entries.
- Authenticated current-directory change hints followed by a debounced authoritative list reload.
- Context menus and discoverable `···` menus as the primary action affordances.
- macOS live Electron verification and automated Windows/Linux modifier, path, and keyboard semantics.

### Out of scope

- Editing file contents in Files; the existing Editor remains the editing surface.
- Copy, duplicate, archive/zip, download, share, or permission management.
- Generic or durable undo. MAT-275 tracks durable undo.
- Trash browsing, restore, retention, and permanent deletion. MAT-276 tracks Trash management.
- Finder/Explorer imports. MAT-261 owns uploads and screenshot paste.
- Shell or mobile UI parity beyond consuming the shared contracts in later work.

## User experience contract

### Selection and preview

- Selection is scoped to the current directory. Navigation or runtime/auth-generation change clears it.
- Refresh retains selected paths that still exist and removes stale paths.
- State contains serializable `selectedPaths: string[]`, one range anchor, and one focused path.
- The focused file drives preview. Selection drives batch actions.
- Clicking an unselected item selects only it. Platform multi-select modifiers toggle items; Shift selects a contiguous visible range from the anchor.
- Dragging a selected item moves the selection. Dragging an unselected item first replaces the selection with that item.
- The drag preview shows the focused item and a count badge for additional items.

### Create and rename

- Toolbar and empty-space context menu expose `New File` and `New Folder`.
- A temporary inline row is renderer-only until the user submits a valid name. Escape/cancel leaves no filesystem artifact.
- Blank names, `.`/`..`, separators, control characters, names over 255 UTF-8 bytes, and reserved platform names are rejected before submission and again at the Gateway.
- Rename is available from an item context menu and `···` menu. It is disabled for multi-selection, pending items, and entries without `canRename`.
- Enter or an explicit button submits. Escape cancels. Blur preserves the editor and does not silently submit.

### Move and Trash

- Initial batch actions are `Move to…`, internal drag-to-move, and `Move to Trash`.
- Selection may exceed 100 items, but batch actions are disabled with an explanation. The Gateway independently rejects more than 100 top-level sources.
- Visible folders and breadcrumbs are valid drag targets. The open directory, a source itself, or a source descendant is invalid.
- `Move to…` provides a folder picker for arbitrary destinations and is the accessible non-drag path.
- Rows enter a disabled pending state immediately, but do not disappear or change directories until the Gateway confirms success.
- Successful items leave selection. Failed or skipped items remain selected and display bounded, safe reasons.
- Delete language always says `Move to Trash`; MAT-268 never permanently deletes user content.

### Conflicts and partial completion

- Preflight validates the complete request before execution and returns conflicts in source order.
- Conflict choices are `Keep Both`, `Skip`, and `Cancel`. Overwrite and directory merge are never offered.
- `Keep Both` generates Finder-style numbered names and claims the final target without check-then-write. Node 24 spike evidence confirms `fs.cp(source, missingTarget, { recursive: true, force: false, errorOnExist: true })` exclusively creates a directory target and returns `ERR_FS_CP_EEXIST` when the target exists. The Gateway claims the top-level directory itself before streaming exclusive child copies so only that top-level claim can advance to another candidate name.
- Once execution begins, each item completes independently. The service does not attempt a batch-wide rollback.
- An item move copies to an exclusively created target and removes the source only after copy success. Cleanup first atomically detaches the matching source into an exclusive same-parent recovery directory, verifies the detached recursive snapshot, and removes only that verified artifact. A crash, identity mismatch, or removal failure may leave the destination plus one normalized recovery artifact; it must never remove a replacement at the original pathname or overwrite a destination while attempting recovery. This bounded duplicate is the acceptable orphan state and its recovery path is surfaced by reconciliation.
- A nested directory-copy failure retains and reports exactly the one normalized, operation-claimed partial target. It is another acceptable reconciliation state: the Gateway does not recursively delete a path that concurrent owner activity may have changed, and duplicate/Keep Both logic does not fan out additional candidate names after a nested conflict.

## Gateway contracts

All paths are owner-home-relative, slash-normalized strings. Responses never expose absolute filesystem paths, provider names, stack traces, or raw filesystem messages.

### Listing capability extension

`GET /api/files/list?path=<relative-directory>` retains its existing response and adds capabilities to every entry:

```ts
interface FileEntryCapabilities {
  canRename: boolean;
  canMove: boolean;
  canTrash: boolean;
  readOnlyReason?: "protected" | "policy";
}
```

Capabilities are computed by a shared Gateway policy. The renderer treats them as affordances only; every mutation re-authorizes the path.

Top-level dot roots such as `.trash` and `.ssh` remain omitted from directory listings, matching Finder's default hidden-file behavior, so they do not produce rows or capability objects. The same policy still rejects create/copy targets inside those hidden roots and rejects rename, move, or Trash operations whose source is one of them. Visible protected roots such as `system` and `agents` remain listed with all three capabilities set to `false` and `readOnlyReason: "protected"`; visible ancestors of denied subtrees, such as `data`, are listed with all three capabilities set to `false` and `readOnlyReason: "policy"`.

### Create and rename

`POST /api/files/create`

```ts
interface CreateFileRequest {
  parentDirectory: string;
  name: string;
  kind: "file" | "directory";
}
```

`POST /api/files/rename`

```ts
interface RenameFileRequest {
  path: string;
  name: string;
}
```

Both routes return the normalized resulting relative path and its fresh capability object. They use the shared Zod name/path schemas and mutation policy, re-authorize the complete source and target paths against the authenticated owner immediately before the filesystem write, exclusively create a new file/directory, and reject an occupied rename target rather than overwriting it. Directory self/descendant targets are rejected before creation. Copy traversal repeatedly validates source and claimed-target identities with `lstat` and `realpath`, never dereferences source symlinks, and fails closed on a source-entry or target swap. Rename captures a bounded recursive source snapshot (maximum 10,000 entries and depth 128), verifies it immediately before cleanup, atomically detaches the matching source into an exclusive same-parent recovery directory, verifies the detached snapshot, and removes only that verified artifact. Cleanup failure returns `cleanup_failed` with one normalized `recoveryPath`; nested directory-copy failure returns the one normalized `partialPath` from create, copy, duplicate, or rename. Exact denied sources and ancestors containing denied content are never copyable or duplicable, while legacy copying from protected `system` and `agents` sources remains compatible. MAT-268 hardens and replaces the Desktop use of the legacy `mkdir`, `touch`, and `{ from, to }` rename payloads; compatibility handling for other callers remains explicitly tested at the route boundary.

### Batch move

`POST /api/files/batch/move`

```ts
interface BatchMovePreflightRequest {
  requestId: string; // UUID
  sources: string[]; // 1..100 unique, same parent directory
  destinationDirectory: string;
  phase: "preflight";
}

interface BatchMoveExecuteRequest {
  requestId: string; // same UUID as its preflight request
  phase: "execute";
  preflightFingerprint: string;
  conflictChoices?: Array<{
    source: string;
    resolution: "keep-both" | "skip";
  }>;
}

type BatchMoveRequest = BatchMovePreflightRequest | BatchMoveExecuteRequest;
```

Preflight returns normalized sources, destination, ordered conflicts, invalid items, and an opaque `preflightFingerprint`. Execute requires the same request ID and that fingerprint; the Gateway retrieves the owner-scoped preflight record, rejects expired/stale/mismatched fingerprints, and returns one terminal result per source: `moved`, `skipped`, or `failed`, plus authoritative affected directories.

### Batch Trash

`POST /api/files/batch/trash`

```ts
interface BatchTrashRequest {
  requestId: string; // UUID
  sources: string[]; // 1..100 unique, same parent directory
}
```

The response returns one `trashed` or `failed` result per source and the authoritative source directory. Trash manifest updates stay serialized per home. Permanent deletion is not part of this endpoint.

### Idempotency

- The Gateway stores at most 512 recent operation results for 10 minutes in an LRU+TTL cache.
- Cache identity is `(authenticated owner/principal ID, operation namespace, requestId)`. A client-controlled UUID therefore cannot replay or inspect another owner's result.
- Batch move uses distinct `move:preflight` and `move:execute` namespaces so an execute can deliberately reuse its preflight request ID. The preflight canonical payload is `{ phase, sources, destinationDirectory }`; the execute canonical payload is `{ phase, preflightFingerprint, conflictChoices }`. The request ID, owner/principal, auth tokens, and absolute paths are never payload-hash fields.
- A repeated request ID in the same owner and operation namespace with the same canonical payload replays the stored result. A payload mismatch returns `409 request_id_conflict`.
- In-flight duplicate requests with the same owner, namespace, request ID, and payload share one promise and do not execute twice.
- Gateway restart intentionally loses this cache. The client must reload source and destination and classify each item from authoritative state instead of blindly retrying or reporting a false failure.

### Directory change subscription

Desktop uses the authenticated main Gateway WebSocket:

```ts
type FileDirectoryClientMessage =
  | { type: "files:subscribe"; directory: string }
  | { type: "files:unsubscribe"; directory: string }
  | { type: "files:touch"; directory: string };

type FileDirectoryServerMessage =
  | { type: "files:subscribed"; directory: string; revision: number }
  | { type: "files:change"; directory: string; entry: string; event: "add" | "change" | "unlink"; revision: number }
  | { type: "files:shutdown" };
```

- Subscriptions are keyed by authenticated owner ID, connection ID, and normalized directory.
- Limits: 1,024 total subscribers, 8 directories per connection, 32 connections per owner, 5-minute stale TTL.
- Touching, resubscribing, or receiving an authorized change refreshes `lastTouched`.
- Failed sends are isolated and evicted. Shutdown sends a best-effort notice and drains the registry before watcher/auth dependencies close.
- Events are hints only. Desktop debounces them and reloads the open directory from `GET /api/files/list`.
- Each subscription has a monotonic in-process revision. Reconnect or revision gaps trigger a reload; revisions are not durable across Gateway restart.

## Auth and authorization matrix

| Route / channel | Method | Auth source of truth | Public | Authorization |
| --- | --- | --- | --- | --- |
| `/api/files/list` | GET | Existing global Gateway auth middleware | No | Authenticated owner home; path boundary validation |
| `/api/files/create` | POST | Existing global Gateway auth middleware | No | Revalidate parent and name against owner home and mutation policy immediately before exclusive create |
| `/api/files/rename` | POST | Existing global Gateway auth middleware | No | Revalidate source, target name, and capability against owner home and mutation policy immediately before rename |
| `/api/files/batch/move` | POST | Existing global Gateway auth middleware | No | Revalidate every source and destination against owner home and mutation policy |
| `/api/files/batch/trash` | POST | Existing global Gateway auth middleware | No | Revalidate every source against owner home and Trash policy |
| `/ws` `files:*` frames | WebSocket | Principal captured at authenticated upgrade | No | Normalize directory and bind subscription to that principal and connection |

Desktop IPC/native code is not a filesystem authority for these operations. The existing authenticated renderer `ApiClient` and Gateway WebSocket are the only transport paths.

## Security and resource constraints

- Zod 4 validates query, body, result, and WebSocket frame schemas at route boundaries.
- Mutating endpoints use Hono `bodyLimit`; the JSON contract limit is 128 KiB.
- Reject absolute paths, traversal, NUL/control characters, denied roots, symlink escapes, sources outside one directory, root moves, and directory self/descendant moves.
- Bound recursive source snapshots to 10,000 entries and depth 128. Revalidate source and claimed-target filesystem identities around traversal and writes; source symlinks are copied as links and never dereferenced.
- Protected root policy supplies both list capabilities and mutation enforcement. Visible `system` and `agents` rows expose all-false capabilities. `.trash`, `.ssh`, and other top-level dot roots remain hidden from listings, while mutations targeting them are still rejected. Denied roots and their visible ancestors cannot be renamed, moved, or trashed from Desktop.
- Bound names to 255 UTF-8 bytes, paths to 4,096 UTF-8 bytes, arrays to 100, conflict choices to 100, result text to a small allowlist, and all in-memory caches/registries as specified above. The result cache has a separate authenticated-owner component in its key as well as the canonical payload hash.
- Never rely on a renderer capability flag, preflight result, or existence check as the mutation authorization decision.
- Log detailed server failures with request ID; return stable safe error codes and generic messages.

## Public test seams

1. **Gateway HTTP seam:** Hono requests to list, batch move, and batch Trash exercise public schemas, auth/path policy, idempotency, conflicts, and per-item outcomes.
2. **Directory subscription seam:** public `FileDirectorySubscriptionHub` methods plus authenticated WebSocket integration exercise caps, TTL eviction, shutdown drain, frame validation, revisions, and failed-sender isolation.
3. **Desktop component seam:** React Testing Library drives rendered Files rows, menus, inline editors, folder picker, pointer/modifier/keyboard selection, drag events, safe errors, and public `ApiClient` methods without asserting private React state.
4. **Live Electron seam:** the packaged-equivalent macOS Desktop runs against a real Gateway; create, rename, multi-select, drag/move, Trash, partial failure, and external Terminal/Agent changes are observed in the UI.

## Acceptance criteria

- A user can create and rename files/folders without accidental orphan names or overwrites.
- A user can select sibling items and move or Trash up to 100 with context menu/`···`, keyboard, and drag alternatives.
- Conflicts and partial failures are deterministic, safe, and recoverable; failed items remain selected.
- Runtime/auth scope changes cannot expose or mutate stale owner paths.
- External changes to the open directory appear after a bounded debounced authoritative refresh.
- Focused Gateway/Desktop tests, desktop typecheck, production Desktop build, and live macOS Electron verification pass.
- A separate English documentation PR updates `FinnaAI/matrix-os-site` after implementation behavior is final.
