# Import Codex transcripts into Chat

## Goal

An owner imports selected local Codex JSONL sessions into their own canonical
Matrix Chats from the Matrix CLI or the Electron Desktop Settings app. The
same import contract serves both entry points. Imported Chats are private by
default. Project attachment and sharing are separate later actions chosen by
the owner.

## Source and presentation

- Accept Codex `rollout-*.jsonl` files with one `session_meta` identity. Read
  incrementally, including files larger than the normal Matrix file-upload
  limit. Preserve the order and timestamps of user messages and final assistant
  responses. Exclude developer/system instructions, hidden reasoning, tool
  calls and tool output, duplicate `event_msg` records, and commentary progress.
- Show the selected session ID, recorded repository and working directory,
  projected message count, a clear notice about omitted non-text parts, and a first-message preview
  before import. A repository match is evidence for a project suggestion, not
  authority to attach to or share that project automatically.
- Long visible messages must be split into valid canonical Chat text parts or
  adjacent messages with no silent truncation. An unsupported or malformed
  transcript fails with a line number and no visible partial Chat.
- Import creates a new Chat in the authenticated owner's Postgres. Historical
  Codex messages are visible as history; importing does not resume the old
  Codex provider session. A new AI turn uses the user's current Matrix route.
- The original JSONL remains on the owner's source computer unless the owner
  separately saves it in Files. The import stores the projected conversation
  and provenance ID/hash, not raw hidden/tool records.

## Transport and atomicity

### Endpoint authority

| Route | Auth source | Allowed scope | Body cap |
| --- | --- | --- | --- |
| `POST /api/chats/imports/codex` | Gateway request principal | Principal's personal owner ID | 4 KiB |
| `POST /api/chats/imports/codex/:sourceId/messages` | Gateway request principal | Same owner and session ID | 512 KiB |
| `POST /api/chats/imports/codex/:sourceId/complete` | Gateway request principal | Same owner and session ID | 4 KiB |

All routes are private. The route validates the path UUID and strict JSON body
before database use. It obtains the owner only from the verified principal, not
from a request header or body. CLI and UI requests use 30-second timeouts;
completion can take up to five minutes. The client verifies the Chat through
the authenticated read route before reporting success. Integration tests mount
these routes with a Kysely/Postgres-compatible repository and exercise
authentication, staging, publication, and repository read-back.

- The CLI reads local files as a stream and sends bounded message batches to
  the authenticated owner's gateway. Electron Desktop reads a chosen local
  file through the user-selected browser File stream; the renderer does not
  receive arbitrary local filesystem access. Each request has a body limit and timeout.
- Owner-scoped Postgres staging rows are bounded by count, bytes and age.
  Batch offsets are contiguous and idempotent. Retrying the same session and
  hash resumes or returns the existing Chat; a changed hash for one session ID
  is a conflict. Abandoned staging rows expire and are removed by a bounded
  sweep on the next import start.
- Completion checks the expected count and commits Chat, members, messages,
  provenance, and outbox in one database transaction. A failure leaves no
  visible partial Chat. The client verifies the resulting Chat ID and message
  count before reporting success.
- No client-supplied owner ID is accepted. The gateway derives owner identity
  from the authenticated principal. Imported Chats cannot be organization
  owned or shared as a side effect of import.

## Product surfaces

- `matrix chats import codex <file>` previews by default and
  imports only with `--apply`. The packaged skill guides local agents through
  selection, preview, import, and post-import verification without reading or
  uploading unrelated sessions.
- Electron Desktop Settings has an **Import chats** action with a local file
  picker, per-session preview, progress, retry, and a link
  to the imported Chat. Web Desktop/Canvas receive the same import state and
  action when a browser file is selected; Native Mobile is limited by local
  file access and is deferred explicitly.
- File sharing through the organization drive and project sharing use the
  existing collaboration authority. Import itself makes no grant.

## Acceptance

1. A large JSONL dominated by tool output imports the full visible user/final
   assistant conversation without loading the raw file into memory.
2. Importing the same session twice creates one Chat. A changed source hash,
   missing batch, wrong owner, malformed record, or mid-import failure creates
   no second or partial visible Chat.
3. Chat history shows the right order, role, timestamp, title and message count
   on Web Desktop and Electron Desktop after reconnect.
4. A private import is absent from every other member's Chat until Ash shares
   that Chat or its project explicitly. Revocation follows collaboration rules.
5. The first live import is verified by comparing source projected count/hash
   with the owner Chat's stored count and provenance. No support credential is
   used to read private local transcripts.

## Delivery

- Separate implementation PRs may cover importer, CLI/skill, and Settings UI,
  each with current-head review and CI. A separate public documentation PR in
  `FinnaAI/matrix-os-site/content/docs/` explains the import and sharing flow.
