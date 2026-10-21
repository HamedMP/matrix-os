# ENG-353: Chat folders and file previews

## Goal

Open Chat paths in the Files surface that owns them, expose full paths and Editor actions in Files, and make text previews useful for reading and editing.

## Routing

- Normalize Chat paths with the existing contract. Reject traversal, unsupported schemes, and paths outside Matrix home before navigation.
- Resolve home paths with the authenticated `/api/files/stat` route. Directories open a Files workspace tab; files open the Chat inspector. The request is pinned to the current runtime slot and auth generation.
- Resolve project and worktree directories with the scoped `runtime:browse-files` operation. Directory links expand the matching Chat Files tree; files continue through the authenticated preview service. A failed lookup cannot grant access; the preview service remains the authority for files.

## Preview and editing

- Use Monaco for highlighted source and the existing Markdown renderer and sandboxed HTML policy for rendered modes. The shared Chat preview exposes source and rendered modes.
- Home text, Markdown, and HTML previews can enter the existing Monaco editor host. Its save path checks the last loaded mtime and surfaces conflicts. A runtime change invalidates the editor API before writes.
- Worktree previews use the existing `runtime:get-file-content` and etag-checked `runtime:save-file-content` operations for complete UTF-8 files up to 64 KiB. Owner home previews use the Monaco editor host. Larger project and project-root editing remains with [GTM-67](https://linear.app/matrix-os/issue/GTM-67).
- Prompt before discarding a dirty side preview through selection, close, and mode changes.

## Auth and failure behavior

| Boundary | Auth source | Failure |
| --- | --- | --- |
| `/api/files/stat`, `/api/files/blob`, `/api/files/list` | Current authenticated gateway session and home path policy | Hide content and show unavailable/permission state |
| `runtime:browse-files` | Scoped project/worktree runtime operation | Keep tree closed or show preview failure |
| File preview service | Resource scope plus principal admission | No content on denial |

The filesystem remains the source of truth. Save is one file write after a fresh stat check; concurrent edits surface a conflict instead of silently overwriting. No new persistence or endpoint is added.

## Validation

- Test folder links, inline folder chips, project/worktree path resolution, listing actions, Markdown/HTML source modes, sandbox policy, and runtime guards.
- Run desktop and UI typechecks plus focused Vitest suites.
- Capture Web Desktop and Electron Desktop from a reviewed test runtime when available; record missing access as a review blocker.
