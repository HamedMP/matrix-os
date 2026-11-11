# Project agent context

## Goal

A project owner can configure skills, MCP declarations, and agent configuration files from the project overview. Repository files remain the source of truth. Existing file editing and computer-level MCP settings retain their own permissions.

## User journey

Open a personal project and expand **Agent configuration**. The three sections show Skills, MCP and Config files in the primary checkout. Each file has a direct action to open it in the existing editor or preview. Explicit creation can add a project skill, an empty MCP declaration file, or a missing root instruction file through Files. Computer MCP settings manage separate, computer-wide connections and approvals. The inventory shows a partial state when a source cannot be safely read and supports retry after request failures.

Selecting a project opens its overview in the main Chat area on Electron Desktop, Web Desktop and Web Canvas. Agent configuration appears below the project title. The sidebar holds project and chat navigation.

On Electron Desktop and Web, the configuration panel starts closed. Opening it expands Skills
and shows compact headers for MCP and Config files. Expanding a section closes the previous
one, and selecting the open header closes it.

Within Skills, **Add skill** opens three options. **Choose installed skill** searches the current computer's Settings catalog by name or description and copies the selected Markdown file on confirmation. **New skill** accepts a name, description, and instructions in one form. **Import SKILL.md** accepts a local UTF-8 skill manifest. The project stores these as `.agents/skills/<name>/SKILL.md` in the primary checkout. Copy and import transfer the Markdown only. Related scripts and assets remain at their source, and the project does not inherit Settings permissions or connection state.

Config files offers a Create action for each missing starter. When all starters exist, the section explains that they can be opened for editing.

The inventory is available in Electron Desktop, Web Desktop and Web Canvas. Mobile is outside this feature’s scope. The list describes project files. Skill availability, config trust, and MCP connection status depend on the selected runtime. Worktree-specific inventory, automatic Markdown injection, and shared project inventory are deferred.

## Wiring and authorization

| Operation | Authority | Result |
| --- | --- | --- |
| GET `/api/projects/:projectId/agent-context` | Existing request principal and canonical active personal project resolver by immutable ID | Bounded allowlisted metadata for the project primary checkout |
| GET `/api/projects/:slug/files-location?projectId=…&file=…` | Active personal owner with immutable project identity, allowlisted relative file and safe checkout path | Existing home-relative file location |
| POST `/api/files/touch` with `projectId` and `projectFile` | Existing file authority and project write admission, canonical active owner project revalidation before write | Descriptor-relative exclusive creation through the existing Files endpoint, with conflict on duplicate |
| GET `/api/settings/skills` and `/api/settings/skills/manifest?path=…` | Current computer Settings authority and approved installed skill roots | Catalog metadata and one bounded, explicitly selected manifest. Managed links to the bundled skill directory are supported. |
| Project file content and editing | Existing Files project/owner authority | Existing file editor or preview |
| MCP connection and tool changes | Existing owner settings and MCP broker approvals | Existing connection and tool policy |

The Gateway registers the route with its project/workspace routes. Clients validate the shared response contract and bind request state to the current project and runtime/account identity. The endpoint rejects invalid IDs, returns the same not-found response for missing and inaccessible projects, and returns a generic unavailable response if project authority or safe file access cannot be established. The Gateway uses directory capabilities and bounded file reads. Symlinks, nonregular files, inaccessible/oversized sources, and malformed JSON or TOML cannot make it read outside the project or return manifest values. The inventory route performs no writes, imports, provider launches or MCP operations. File creation is explicit. Skills accept up to 64 KiB of UTF-8 Markdown, including frontmatter. Switching the project, account, or runtime cancels outstanding source reads. Source and destination remain independently scoped. Manifest reads are limited to approved installed skill roots and reject symlinks into projects or unrelated directories. Opening an exact file is a handoff into existing owner Files permissions, with file contents fetched only after the explicit action.

## Acceptance

- On Electron Desktop, the project composer keeps the `/` Skills and commands list and the `@` resource list visible and selectable when they open outside the composer. Hiding or leaving the surface dismisses its suggestions.
- In the project composer, Preview dictation quota stays readable outside the toolbar. Attachment, model, reasoning, permission and send controls remain within the composer at narrow and wide widths.
- In Web Desktop and Web Canvas, selecting a project shows one Agent configuration panel in the main project overview. Selecting a chat opens its transcript. Selecting the project name in the sidebar returns to the overview with a draft scoped to that project.
- Owners see only their active project's metadata, with paths relative to the project. Project switches discard older requests. Shared members gain no new access.
- Valid Codex TOML and Claude JSON declarations appear with distinct source labels. Credentials, URLs, headers, executable arguments, instruction bodies, and skill bodies never appear in the response.
- Exact file actions reach the existing editor or preview. Creation only writes an allowlisted path in the same active project and rejects overwrites. Files and computer MCP actions reach existing surfaces where supported. Loading, empty, partial, error and retry states remain legible at narrow widths.
- Opening a project file on Web raises Preview and places keyboard focus on the selected file tab. When switching from Canvas to Desktop, a Preview window without a previous Desktop position starts centered in the Desktop work area. An existing Desktop position is restored and adjusted only as needed to keep the editor inside the Desktop work area.
- Verify all three Add skill actions create the expected Markdown in the selected project, preserve copied or imported content, and reject duplicates. The installed picker loads only the selected file.
- Verify the actual editor can create, modify and save a project skill, MCP declaration and instruction file. Refresh shows the new declarations only in their project. A failed read cannot be saved as an empty file, and a failed write preserves the draft.
- Verify instruction behavior using the pinned native process and synthetic local inference, plus Gateway tests for project/worktree dispatch, retry/resume provenance and intentional suppression. Keep local runtime and release/production evidence separate.
