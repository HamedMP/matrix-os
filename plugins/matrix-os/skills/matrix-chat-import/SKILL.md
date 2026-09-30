---
name: matrix-chat-import
description: Import a specifically selected local Codex JSONL session into the owner's private Matrix Chat. Use when a user asks to bring their local Codex conversation into Matrix Chat.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
---

# Matrix Chat import

Use the authenticated Matrix CLI to preview one local Codex session, then
import that same file into the user's private canonical Chat. This is a Chat
import, not a raw Files upload or a continuation of the old Codex runtime.

1. Identify the exact `rollout-*.jsonl` file the owner selected. If choosing
   from a project, inspect Codex `session_meta` repository URL and recorded
   working directory; do not choose by file modification time alone. Do not
   scan or import unrelated global sessions.
2. Run `matrix whoami` and verify the authenticated Matrix account is the
   intended owner. Do not pass access tokens in command arguments.
3. Run `matrix chats import codex /absolute/path/to/rollout.jsonl` to preview
   the session identity, recorded repository, projected message count and raw
   SHA-256. If an expected hash is known, add `--sha256 <expected-hash>`.
   Raw transcripts may contain pasted secrets; the importer sends visible user
   and final assistant text, so review the selected source before importing.
4. When the owner has selected this exact session for import, rerun with
   `--apply` and the same file/hash. Report the returned Chat ID and message
   count. If verification fails, report the error; do not claim success or
   rerun against another file automatically.
5. The imported Chat stays private. Let the owner choose any later project
   attachment or organization sharing in Matrix. Do not share all imports or
   copy provider session files to another member's computer.

For multiple sessions, repeat the preview and import for each exact file. A
large raw JSONL file is read as a stream; the importer excludes hidden
instructions, reasoning, tool output and duplicate event records.
