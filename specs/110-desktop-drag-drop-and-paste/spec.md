# Desktop Drag, Drop, and Paste

**Status**: Approved  
**Linear Issue**: `MAT-261`

## Scope

Improve the Electron Desktop experience without changing shared Gateway, CLI, Shell,
Mobile, coding-agent, conversation, or terminal-session contracts.

The implementation is a thin Desktop renderer over two existing authenticated APIs:

- `PUT /api/files/blob` for Files, Chat, and Project Chat uploads.
- `POST /api/terminal/sessions/:name/paste-assets` for Terminal image paste/drop.

No new endpoint, database, durable attachment lifecycle, thread identifier, session
identifier, or provider contract is introduced.

## Surface Contract

| Surface | Input | Result |
|---|---|---|
| Files browser | Dropped or pasted regular files, at most 10 MiB each | Upload to the visible owner-home directory and refresh the listing |
| Chat | Dropped or pasted regular files, at most 10 MiB each | Show one Codex-style horizontal preview row; upload on Send and append owner-readable paths to the Hermes prompt |
| Project Chat | Same as Chat | Upload on thread/turn Send and pass existing `structured_ref` attachments with owner-relative paths |
| Standalone Terminal | Dropped or pasted PNG/JPEG/GIF/WebP, at most 10 MiB each | Upload through the existing terminal paste endpoint and bracketed-paste returned paths without Enter |
| Inspector Terminal | Same as standalone Terminal | Reuse the same `TerminalView` implementation |

Folder pickers, file preview panes, terminal session lists, chat rails, project inspectors,
and non-active terminals are not drop zones.

## Requirements

- **FR-001**: All behavior MUST remain inside `desktop/` and Desktop tests/specs.
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
- **FR-011**: Chat uploads MUST be placed under a collision-resistant Desktop upload
  directory in owner home, and Hermes MUST receive both `~/...` and absolute Matrix-home
  path forms in plain text.
- **FR-012**: Project Chat MUST reuse `AgentAttachmentSchema` with
  `kind: "structured_ref"`; it MUST NOT add new attachment contract fields.
- **FR-013**: Terminal paste/drop MUST accept only PNG, JPEG, GIF, and WebP and MUST use
  the existing Gateway magic-byte validation as the final authority.
- **FR-014**: Terminal insertion MUST use bracketed paste, strip nested bracket markers,
  remain under the terminal input cap, and never append Enter.
- **FR-015**: Unsupported paste data MUST fall through to normal xterm text paste.
- **FR-016**: Drag/drop interception MUST occur only when at least one supported file is
  present; ordinary terminal/chat/file interactions MUST remain unchanged.
- **FR-017**: No local absolute path, credential, raw Gateway error, or hidden runtime
  identifier may be rendered or logged.

## Existing Endpoint Security

| Route | Existing auth | Existing body limit | Desktop use |
|---|---|---:|---|
| `PUT /api/files/blob` | Desktop trusted-core Authorization injection | 10 MiB | Files and composer uploads |
| `POST /api/terminal/sessions/:name/paste-assets` | Desktop trusted-core Authorization injection | 10 MiB | Terminal images only |

Desktop adds only the CORS request header needed by the existing terminal endpoint:
`X-Matrix-Filename`.

## Testing Seams

- `ComputerFileBrowser`: user-visible drop/paste, upload rows, conflict, retry, refresh.
- `ChatTab`: local preview row, ordered Send, failure retention, path prompt.
- `ProjectChatDraft` and `AgentConversationView`: preview row and existing
  `structured_ref` create/turn payloads.
- `TerminalView`: active xterm viewport paste/drop, upload, bracketed write, no Enter,
  unsupported/disconnected behavior, standalone/Inspector reuse.
- `ApiClient` and Electron CORS: binary PUT/POST timeout and allowed request headers.

## Success Criteria

- All four Desktop surfaces work in a production Electron build against an unchanged
  `origin/main` Gateway bundle.
- Focused Desktop tests, typecheck, pattern checks, and production build pass.
- A Preview VPS demonstrates Files, Chat, Project Chat, standalone Terminal, and
  Inspector Terminal behavior without changing Shell, CLI, Mobile, or Gateway code.

