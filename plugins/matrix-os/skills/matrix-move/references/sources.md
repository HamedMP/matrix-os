# Capture sources without overstating completeness

## Codex and Claude Code on macOS/Linux

`matrix chats discover` honors `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. It inventories
active/archived Codex sessions and Claude project/subagent JSONL independently of
indexes. Use actual source IDs and repository evidence to select candidates.
Do not copy global history, state databases, authentication stores, or an entire
agent configuration directory.

For the current chat, match its known thread/session identity to the transcript
metadata. Cwd can narrow candidates but cannot distinguish two chats in the same
project. For a project, include only confirmed members, and report unresolved
associations rather than guessing. A shared worktree parent is not membership.

Capture original bytes up to a stable boundary into a private temp file, without
rewriting JSONL records. The importer reports partial final records and unsupported
content. If the source changes during capture, recapture before preview. The
preview/apply hash must refer to the same capture. A transcript stored on a
remote Codex host must be captured there or obtained through an authorized export;
a matching-looking local session is not a substitute.

For an active current-chat move, use the end of the invoking user turn as the
capture boundary, before transfer tooling starts. Report that boundary in the
receipt. Preserve the complete original prefix through that request; transfer
diagnostics belong to this operation, not the conversation being moved. Do not
remove earlier records to bypass importer errors. If an earlier capture failed,
verify it did not publish before applying a new capture; do not replace a
successful import with a changed snapshot automatically.

Tools, supported embedded media, and readable prose can be reconstructed. Original
unknown/internal/encrypted records stay in the private archive. External file/URL
references are not fetched. Preserve source-reported missing assets in the receipt.
Do not promise restoration of an old provider session, active process, or approval.

## Codex Cloud / ChatGPT / other cloud workspaces

First inspect the tools and files actually available in that environment. Cloud
execution with a real checkout and a supported saved transcript can use the
normal workflow; being remote does not itself prevent a transfer.

When only chat summaries or visible conversation context are available, produce
an explicitly labeled continuation brief. Do not fabricate a Codex/Claude JSONL
file from a summary or claim that `read_thread` exported original history. Keep
visible messages separate from source originals and list inaccessible turns,
attachments, project instructions, and files.

Use an actual user-selected export if the current Matrix importer supports it.
An arbitrary cloud JSON/ZIP export is not automatically Codex JSONL. Unsupported
formats require a converter/import adapter and validation before native Chat
publication. Upload an authorized unsupported export as a private file archive
and report that native history import is blocked; do not silently discard it.

For a cloud project, enumerate actual project membership through available tools,
including paginated results. If the inventory is bounded or incomplete, say so.
Transfer accessible project instructions and files, preserve exact originals
where possible, and list unavailable resources. Do not publish a source chat just
to obtain an export link. Do not claim a complete project transfer from the
current context window or one page of chat summaries.

If no source filesystem exists, use Matrix MCP `upload_file` for a bounded brief
or selected files on one explicit computer. Respect its upload size limit; do
not embed a large export in a prompt. MCP currently exposes read-only Chat tools,
not a generic import/create-project tool: use the CLI where executable or the
authenticated Matrix UI. If neither is available, return the prepared artifact
and the exact missing capability rather than pretending an upload occurred.
