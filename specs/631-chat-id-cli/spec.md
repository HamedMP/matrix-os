# Work with Matrix Chats by ID

Ticket: [ENG-323](https://linear.app/matrix-os/issue/ENG-323).

Add `matrix chats read|get`, `send`, `watch`, and `export` for an existing
private Chat. Use the selected CLI profile and preserve its runtime routing.
No gateway routes or permissions change. Recommend engineering review of the
CLI behavior and retry semantics before release.

| Operation | Existing route | Authority |
| --- | --- | --- |
| Read/export | GET `/api/chats/:chatId` with authenticated cursors | Runtime Bearer token, owner access |
| Send | POST `/api/chats/:chatId/turns` | Same token; server revision, model and permission admission |
| Watch | GET `/api/chats/events` | Same token; filter every frame to the requested Chat |

Read returns a bounded page and its cursor. Export follows every history page
in chronological order, rejects inconsistent/repeating cursors or revision
changes, and fails explicitly at 10,000 messages or 64 MiB. JSON exports retain
the retrieved canonical records and tool activity; Markdown presents messages
and structured parts. Neither downloads referenced files nor contains provider
session state. Create exports exclusively with mode 0600; never overwrite files.

Send uses the Chat's current model selection, explicit/default supervised
permissions, an optimistic revision and a stable request ID. Report that ID on
uncertain admission; never automatically send again with a new ID. Preserve
the exact payload for any internal retry. Sending may start a remote agent.

Watch emits NDJSON with the selected Chat's content/events, resumes with the
global event cursor, reconnects with a bounded consecutive-failure budget and
backoff, survives normal request timeouts on healthy quiet connections, reports
replay gaps with a fresh snapshot, and cancels on SIGINT/SIGTERM.
All requests reject redirects and have timeouts; bodies and stream frames are
bounded. Errors use local safe copy. No credentials are written in exports.

Validation: failing tests first for routing, validation, pagination, duplicate
admission, limits, export exclusivity, stream chunking/filtering/reconnect and
cancellation; sync-client typecheck/package validation; read/export/watch live
against the selected VPS and send against a disposable synthetic Chat. CLI-only:
no Web Canvas, Web Desktop, Electron Desktop, Web Mobile or Native Mobile UI
changes. Include CLI capture evidence and link the separate public documentation
PR in `FinnaAI/matrix-os-site` (`content/docs/`).
