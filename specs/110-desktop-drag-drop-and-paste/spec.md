# Desktop Drag, Drop, and Paste

**Status**: Approved  
**Linear Issue**: `MAT-261`

## Scope

Improve the Electron Desktop experience while keeping shared CLI, Shell, Mobile,
coding-agent, conversation, and terminal-session contracts unchanged. One narrow
Gateway implementation change moves existing Terminal paste assets into the common
owner-home directory `/home/matrix/home/temporary/`; the endpoint and response
contract remain unchanged.

The implementation is a thin Desktop renderer over two existing authenticated APIs:

- `PUT /api/files/blob` for Files, Chat, and Project Chat uploads.
- `POST /api/terminal/sessions/:name/paste-assets` for Terminal image paste/drop.

No new endpoint, database, cleanup lifecycle, thread identifier, session identifier,
or provider contract is introduced.

## Surface Contract

| Surface | Input | Result |
|---|---|---|
| Files browser | Dropped or pasted regular files, at most 10 MiB each | Upload to the visible owner-home directory and refresh the listing |
| Chat | Dropped or pasted regular files, at most 10 MiB each | Show one Codex-style horizontal preview row; upload on Send under `~/temporary/desktop-chat/` and append owner-readable paths to the Hermes prompt |
| Project Chat | Same as Chat | Upload on thread/turn Send under `~/temporary/desktop-chat/` and pass existing `structured_ref` attachments with owner-relative paths |
| Standalone Terminal | Dropped or pasted PNG/JPEG/GIF/WebP, at most 10 MiB each | Upload through the existing terminal paste endpoint under `~/temporary/terminal-pastes/<date>/` and bracketed-paste returned paths without Enter |
| Inspector Terminal | Same as standalone Terminal | Reuse the same `TerminalView` implementation |

Folder pickers, file preview panes, terminal session lists, chat rails, project inspectors,
and non-active terminals are not drop zones.

## Requirements

- **FR-001**: The change MUST remain inside `desktop/`, the existing Gateway Terminal
  paste-asset storage helper and its focused tests, and this spec directory.
- **FR-002**: Existing Gateway routes and contracts MUST be consumed unchanged.
- **FR-003**: Each accepted file MUST be a regular browser `File` no larger than
  `10 * 1024 * 1024` bytes.
- **FR-004**: Chat and Project Chat MUST accept at most eight pending files.
- **FR-005**: Preview items MUST preserve selection order in one non-wrapping,
  horizontally scrollable row.
- **FR-006**: Image previews MUST use bounded object URLs that are revoked on removal,
  clear, runtime change, and unmount.
- **FR-007**: Uploads MUST be bounded by a 30-second timeout and a maximum of three
  concurrent requests per composer or Files browser.
- **FR-008**: Failed uploads MUST retain their preview and offer Retry or Remove.
- **FR-009**: Runtime changes MUST invalidate pending completions so files from one
  Matrix computer cannot be submitted to another.
- **FR-010**: Files conflicts MUST surface a safe conflict error; Desktop MUST NOT
  silently overwrite an existing owner file.
- **FR-011**: Chat and Project Chat uploads MUST be placed under the
  collision-resistant `temporary/desktop-chat/` directory in owner home, and Hermes
  MUST receive both `~/...` and absolute Matrix-home path forms in plain text.
- **FR-012**: Project Chat MUST reuse `AgentAttachmentSchema` with
  `kind: "structured_ref"`; it MUST NOT add new attachment contract fields.
- **FR-013**: Terminal paste/drop MUST accept only PNG, JPEG, GIF, and WebP and MUST use
  the existing Gateway magic-byte validation as the final authority.
- **FR-014**: Terminal insertion MUST use bracketed paste, strip nested bracket markers,
  remain under the terminal input cap, and never append Enter.
- **FR-015**: Unsupported paste data MUST fall through to normal xterm text paste.
- **FR-016**: Drag/drop interception MUST occur only when at least one supported file is
  present; ordinary terminal/chat/file interactions MUST remain unchanged.
- **FR-017**: No local Desktop absolute path, credential, raw Gateway error, or hidden
  runtime identifier may be rendered or logged. Authenticated owner paths returned by
  the VPS remain valid prompt and terminal input.
- **FR-018**: Terminal paste assets MUST be placed under
  `temporary/terminal-pastes/<YYYY-MM-DD>/` in owner home regardless of terminal cwd.
  The existing Gateway helper MUST create missing directories recursively and retain
  its path-confinement, exclusive-write, and magic-byte validation behavior.
- **FR-019**: Files-browser uploads MUST continue targeting the owner-home directory
  currently visible to the user; they MUST NOT be redirected into `temporary/`.
- **FR-020**: This change MUST NOT introduce automatic deletion or retention behavior.
  Bounded cleanup is deferred to Linear issue `MAT-269`.

## Existing Endpoint Security

| Route | Existing auth | Existing body limit | Desktop use |
|---|---|---:|---|
| `PUT /api/files/blob` | Desktop trusted-core Authorization injection | 10 MiB | Files and composer uploads |
| `POST /api/terminal/sessions/:name/paste-assets` | Desktop trusted-core Authorization injection | 10 MiB | Terminal images only |

Desktop adds only the CORS request header needed by the existing terminal endpoint:
`X-Matrix-Filename`. The Gateway endpoint keeps the same request and response schema;
only its owner-home storage path changes.

## Testing Seams

- `ComputerFileBrowser`: user-visible drop/paste, upload rows, conflict, retry, refresh.
- `ChatTab`: local preview row, ordered Send, failure retention, path prompt.
- `ProjectChatDraft` and `AgentConversationView`: preview row and existing
  `structured_ref` create/turn payloads.
- `TerminalView`: active xterm viewport paste/drop, upload, bracketed write, no Enter,
  unsupported/disconnected behavior, standalone/Inspector reuse.
- `saveTerminalPasteAsset`: owner-home `temporary/terminal-pastes/<date>/` placement,
  recursive directory creation, path confinement, exclusive writes, and unchanged
  response shape.
- `ApiClient` and Electron CORS: binary PUT/POST timeout and allowed request headers.

## Success Criteria

- All four Desktop surfaces work in a production Electron build against the exact PR
  Gateway bundle while consuming unchanged upload endpoint contracts.
- Focused Desktop tests, typecheck, pattern checks, and production build pass.
- A Preview VPS demonstrates Files, Chat, Project Chat, standalone Terminal, and
  Inspector Terminal behavior with all transient composer and terminal assets under
  `~/temporary/`, Files uploads still targeting the visible directory, and no changes
  to Shell, CLI, Mobile, or terminal-session behavior.
