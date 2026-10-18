---
name: matrix-move
description: Transfer the current chat or project from Codex, Claude Code, or an accessible cloud workspace into a private Matrix project and Chats. Use for moving work to Matrix, including files, saved history, and continuation context.
---

# Move work to Matrix

Create a usable destination project with private Chats, source files when
selected, and a continuation brief. Keep the source intact. A terminal session
alone is not a Matrix Chat, and a copied directory is not a registered project.

## Resolve scope and destination

- “This chat” means the active chat only; do not include every chat for its cwd.
- “This project” includes its available files, instructions, and selected project
  chats. Inventory chats by actual project membership or verified repository
  evidence. Record unavailable items and archived/subagent sessions separately.
- Use the current host's chat/project tools to resolve identities. In Codex,
  `list_projects`, `list_threads`, and `read_thread` can supply membership and
  context; their summaries are not full transcript exports. Never identify the
  active chat by title, newest mtime, or cwd alone. If its ID is unavailable and
  several candidates remain, ask which one.
- Select the signed-in Matrix owner and one computer. For Matrix MCP, call
  `list_computers` first and retain the same runtime slot throughout. For CLI,
  check `matrix --version`, `matrix whoami --profile <profile>`, and
  `matrix instance info --profile <profile> --json`. Chat import needs 0.3.21+.
  Verify that the Matrix UI uses this same computer before organizing anything.
- Honor existing authorization for the identified transfer. Show the concrete
  scope and exclusions before uploading; ask only for missing scope or authority.
  Raw original archives can include pasted secrets. Do not widen selection or
  share with other people as a side effect.

Read [sources.md](references/sources.md) for source capture, especially cloud
workspaces. Read [project.md](references/project.md) only when moving files or
registering/organizing a project.

## Transfer saved history

1. Resolve exact source IDs and files. Use `matrix chats discover --json`, adding
   `--project /absolute/repository` for a local code project. Discovery is an
   inventory, never authority to import unrelated sessions.
2. Capture each selected JSONL in a private temporary directory, with its stable
   byte boundary and source identity. Preview the captured file, not a changing
   active transcript:

   ```bash
   matrix chats import codex /absolute/captured.jsonl --json
   ```

   Use `claude` for Claude Code. Report identity, hash, original bytes, source
   issues, unreadable records, and unavailable external references. Archive
   fidelity is different from readable-history fidelity.
3. Import those exact captured bytes to the selected profile:

   ```bash
   matrix chats import codex /absolute/captured.jsonl --apply --sha256 <preview-hash> --profile <profile> --json
   ```

4. Require verified canonical read-back, Chat ID, and original archive job ID.
   Reuse identical captures on retry. Changed snapshots, prior text-only imports,
   forks, and incremental merges need reconciliation; do not create duplicates
   automatically. Save the source-ID → Chat-ID mapping in the transfer receipt.
5. Keep imports private. Attach them to the chosen personal project through
   **Move to project** only after verifying project identity and privacy. If the
   deployed client lacks this action, report organization as incomplete.

## Continuation and completion

Write a brief with the goal, decisions, completed work, unfinished changes,
blockers, tests, and next action. Include source identities and provenance links
only when already accessible and safe. Store it with the project files; for a
chat-only handoff, upload it to a unique owner-private Files path. Do not submit
it as a new AI turn or launch an agent unless continuing execution was requested.

Verify destination files against the manifest, open each imported Chat, and
check project association. In each Chat, check the original human request, the
last saved assistant answer, and a saved tool call with its result. Follow
**Load earlier messages** when history is paginated. A row in Chats or a successful
archive upload alone does not verify readable history. If rendering is broken
or earlier messages are inaccessible, report the move as **partial**.
Report **verified**, **partial**, or **blocked** with:

- Matrix computer, project ID/path, and imported Chat IDs;
- transferred file/chat counts, original archive IDs, and brief location;
- excluded or unavailable data, unresolved history, and remaining setup;
- an observed working link, or a clear navigation path if no direct link exists.

Do not claim a complete move while a selected item is missing. Credentials,
dependencies, Git history/index, active processes, and inaccessible cloud data
do not move with the workspace snapshot. Preserve unpushed commits through a
separately scoped Git transfer before declaring that a full repository moved.

Clean up exact local snapshots after successful verification or cancellation,
and abandoned local previews within 24 hours. Retain failed captures only when
needed for an identified retry and state their location. Remove remote upload
parts after extraction. Never delete/archive the original chat or project
without an explicit request after verification.

Private chat/project deep links are a future routing capability. Do not invent
`?chatId=`, `?projectId=`, or `matrixos://chat/...` links. A `launch=__chat__`
launcher URL opens the app, not the imported Chat. Do not create a public share
link to compensate. Return an existing **Copy link** result only if it preserves
the selected private resource and was verified; otherwise provide project title,
Chat title/ID, and the selected computer's observed web URL.
