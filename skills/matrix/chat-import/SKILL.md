---
name: matrix-chat-import
description: Discover and import owner-selected local Codex and Claude Code transcripts as private Matrix Chats with original archives.
version: 2.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
---

# Matrix Chat import

Requires Matrix CLI 0.3.21 or newer and a compatible Matrix gateway. Check
`matrix --version`, then `matrix whoami` to verify the intended owner. Do not
pass credentials in command arguments or copy sessions to another member.

## Discover and select

Use `matrix chats discover --json` for metadata-only inventory, or add
`--project /absolute/path/to/repository` for repository evidence. Discovery
uses `CODEX_HOME` (default `~/.codex`) and `CLAUDE_CONFIG_DIR` (default
`~/.claude`). It includes Codex `sessions/**/*.jsonl` and
`archived_sessions/*.jsonl`, and Claude `projects/**/*.jsonl` including
subagents. Project folder names, including `CLAUDE_CODE_PROJECT_DIR_NAME`,
are not repository evidence. Indexes and global input history are not complete
transcripts. Credential stores and adjacent files are excluded.

Keep unresolved sessions separate. Association is a suggestion, not permission
to attach a Chat to a project or share it. A recorded cwd inside a currently
verified Git worktree/common directory, or an exact recorded remote plus a
commit present in the selected repository, can establish a match. A branch,
shared workspace parent, directory slug, title, or modification time cannot.

## Preview and import

1. Choose exact files within the owner's requested scope. Existing approval to
   import those selected sessions remains valid; do not request it again.
2. Preview each file without uploads:
   `matrix chats import codex /absolute/path/session.jsonl --json`
   or `matrix chats import claude /absolute/path/session.jsonl --json`.
   Report session identity, counts, bytes, hash, source issues, and unavailable
   external references. Keep private transcript text out of reports unless the
   owner specifically requests it.
3. Apply that same file and captured hash:
   `matrix chats import claude /absolute/path/session.jsonl --apply --sha256 <hash>`.
   Use `codex` for Codex files. Optionally supply `--title`.
4. Report success only after canonical read-back returns the Chat ID, stored
   history count, and original archive job ID. Retrying the same captured bytes
   resumes durable parts or returns the already published Chat. A changed
   snapshot or prior text-only import requires explicit reconciliation; do not
   automatically re-import it as another Chat or claim incremental merging.
5. Imports stay private. Let the owner choose later project or organization
   sharing. Original archives, internal instructions, and thinking remain
   owner-private. Never automatically share every discovered session.

Files are read without changing or resuming the source sessions. Original bytes
are uploaded in bounded parts and verified by size/SHA-256. Readable history
includes saved prose, tools, and supported embedded media. Unknown, encrypted,
malformed, and internal records remain in the original archive. External paths
and URLs are not followed automatically. Missing historical output cannot be
recovered from a preview or the current version of an edited file. Raw archives
can contain secrets previously pasted into a conversation.

Stopping the client pauses upload/waiting; queued server verification may
continue. Retry the same file to check its status. Do not claim cancellation
removed a published Chat. Do not claim complete support for unseen compaction,
fork, remote media, or platform formats.

## Settings

Web Canvas, Web Desktop, and Electron Desktop expose **Settings → Import chats**:
choose Codex or Claude Code, select one JSONL file, review the preview, and press
**Import private Chat**. Electron uses a native picker and native upload; its
renderer receives no local filesystem path or credential.
