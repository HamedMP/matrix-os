# Project agent context

## Goal

A project owner can configure skills, MCP declarations, and agent configuration files from the project overview. Repository files remain the source of truth. Existing file editing and computer-level MCP settings retain their own permissions.

## User journey

Open a personal project and expand **Agent configuration**. The three sections show Skills, MCP and Config files in the primary checkout. Each file has a direct action to open it in the existing editor or preview. Explicit creation can scaffold a project skill, an empty MCP declaration file, or a missing root instruction file through Files. Computer MCP settings manage separate, computer-wide connections and approvals. The inventory shows a partial state when a source cannot be safely read and supports retry after request failures.

On Electron Desktop and Web, the configuration panel starts closed. Opening it expands Skills
and shows compact headers for MCP and Config files. Expanding a section closes the previous
one, and selecting the open header closes it.

The inventory is available in Electron Desktop, Web Desktop and Web Canvas. Mobile is outside this feature’s scope. The list describes project files. Skill availability, config trust, and MCP connection status depend on the selected runtime. Worktree-specific inventory, automatic Markdown injection, and shared project inventory are deferred.

## Wiring and authorization

| Operation | Authority | Result |
| --- | --- | --- |
| GET `/api/projects/:projectId/agent-context` | Existing request principal and canonical active personal project resolver by immutable ID | Bounded allowlisted metadata for the project primary checkout |
| GET `/api/projects/:slug/files-location?projectId=…&file=…` | Active personal owner with immutable project identity, allowlisted relative file and safe checkout path | Existing home-relative file location |
| POST `/api/files/touch` with `projectId` and `projectFile` | Existing file authority and project write admission, canonical active owner project revalidation before write | Descriptor-relative exclusive creation through the existing Files endpoint, with conflict on duplicate |
| Project file content and editing | Existing Files project/owner authority | Existing file editor or preview |
| MCP connection and tool changes | Existing owner settings and MCP broker approvals | Existing connection and tool policy |

The Gateway registers the route with its project/workspace routes. Clients validate the shared response contract and bind request state to the current project and runtime/account identity. The endpoint rejects invalid IDs, returns the same not-found response for missing and inaccessible projects, and returns a generic unavailable response if project authority or safe file access cannot be established. The Gateway uses directory capabilities and bounded file reads. Symlinks, nonregular files, inaccessible/oversized sources, and malformed JSON or TOML cannot make it read outside the project or return manifest values. The inventory route performs no writes, imports, provider launches or MCP operations. File creation is explicit and uses empty or inert starter content. Opening an exact file is a handoff into existing owner Files permissions, with file contents fetched only after the explicit action.

## Acceptance

- Owners see only their active project's metadata, with paths relative to the project. Project switches discard older requests. Shared members gain no new access.
- Valid Codex TOML and Claude JSON declarations appear with distinct source labels. Credentials, URLs, headers, executable arguments, instruction bodies, and skill bodies never appear in the response.
- Exact file actions reach the existing editor or preview. Creation only writes an allowlisted path in the same active project and rejects overwrites. Files and computer MCP actions reach existing surfaces where supported. Loading, empty, partial, error and retry states remain legible at narrow widths.
- Verify the actual editor can create, modify and save a project skill, MCP declaration and instruction file. Refresh shows the new declarations only in their project. A failed read cannot be saved as an empty file, and a failed write preserves the draft.
- Verify instruction behavior using the pinned native process and synthetic local inference, plus Gateway tests for project/worktree dispatch, retry/resume provenance and intentional suppression. Keep local runtime and release/production evidence separate.
