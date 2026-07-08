# Research: Attached Terminal Rich Paste

## Decision: Process Rich Paste Locally Before Terminal Input Frames

**Rationale**: The local CLI is the only component that can read local macOS screenshot files or clipboard data. Rewriting before WebSocket input frames lets the existing attached terminal transport remain the delivery mechanism for the final prompt.

**Alternatives considered**:

- Send local paths to the remote shell and let the remote side resolve them: rejected because local `/var/folders/...` paths do not exist on the VPS and leak local filesystem details.
- Add image bytes to the terminal WebSocket protocol: rejected for this feature because it expands a latency-sensitive stream protocol and makes failures harder to isolate from ordinary terminal input.

## Decision: Detect Paths Inside Larger Pasted Text

**Rationale**: Real pastes often look like `"Screenshot 2026-07-08 at 10.31.00.png" what about this?`. The parser must find quoted and unquoted image paths within surrounding text, verify they exist as local regular files, and preserve the user's prose in order.

**Alternatives considered**:

- Only handle pastes where the entire value is a single path: rejected because the previous narrow behavior misses the target UX.
- Treat every path-like string as an upload candidate: rejected because ordinary text and non-image paths should remain unchanged.

## Decision: Add a Terminal-Aware Paste Asset Route

**Rationale**: Generic file upload requires the client to choose a destination path and can accidentally expose source filenames. A terminal-aware route can validate the session, generate safe remote names, enforce asset count/size limits, and return Matrix-owned paths suitable for prompt rewriting.

**Alternatives considered**:

- Reuse `/api/files/blob` directly from the rich paste rewriter: rejected because the route has no terminal paste semantics, no transaction response shape, and no paste-specific cleanup policy.
- Store paste assets in platform object storage: rejected because this is user shell context and should stay in the owner's Matrix home.

## Decision: Use Bounded Multipart Uploads

**Rationale**: Multipart upload supports binary image data without base64 inflation and keeps each paste transaction atomic from the client's perspective. The gateway can reject the whole transaction before prompt forwarding when validation fails.

**Alternatives considered**:

- JSON with base64 data: rejected because it increases request size and makes body limits less intuitive.
- One request per asset through the generic file API: rejected because it complicates all-or-nothing prompt rewrite behavior.

## Decision: Pure Image Clipboard Paste Is Best-Effort and Paste-Boundary Driven

**Rationale**: A normal terminal cannot send image bytes over stdin if the terminal emulator does not emit text or a paste boundary. The CLI can attempt clipboard image reads only when it observes a paste transaction or receives paste text that indicates image intent.

**Alternatives considered**:

- Continuous clipboard polling: rejected because it is surprising, privacy-sensitive, and outside a user-initiated paste transaction.
- Global keyboard hooks: rejected because they require OS-level permissions and are beyond the CLI attach surface.

## Decision: Owner-Visible Temporary Paste Asset Retention

**Rationale**: Pasted screenshots should remain available long enough for the remote AI and user to inspect them, but the hidden paste directory must not grow forever. Assets should live under the user's Matrix home, be safe to delete, and be pruned by a recurring symlink-safe cleanup policy.

**Alternatives considered**:

- Delete immediately after forwarding the prompt: rejected because the remote AI or terminal program may read the path after prompt delivery.
- Retain forever: rejected because screenshots are often temporary and can accumulate quickly.
