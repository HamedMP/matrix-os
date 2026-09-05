# MCP Tool Contract: Matrix Remote Computer

All scoped inputs require `computer`, the `runtimeSlot` returned by `list_computers`. Results include `ok`; failures expose only allowlisted codes/messages, never credentials or upstream bodies.

| Tool | Required input | Result | Semantics |
|---|---|---|---|
| `list_computers` | none | computers, selected slot, pagination flag | read-only |
| `run_command` | computer, argv | bounded output/exit metadata | state-changing |
| `list_terminals` | computer | bounded session metadata | read-only |
| `create_terminal` | computer, name | created session | state-changing |
| `list_terminal_tabs` | computer, terminal | stable IDs, positions, names/focus | read-only |
| `create_terminal_tab` | computer, terminal | stable tab ID/name | state-changing |
| `select_terminal_tab` | computer, terminal, stable tab ID | selection acknowledgement | state-changing |
| `send_terminal_input` | computer, terminal, data | accepted byte count | state-changing |
| `list_files` | computer, path | at most 500 entries | read-only |
| `read_file` | computer, path | UTF-8 content, metadata | read-only |
| `download_file` | computer, path | base64 content, metadata | read-only |
| `upload_file` | computer, path, encoding/content | path and size | state-changing |
| `list_chats` | computer | bounded summaries/cursor | read-only |
| `search_chats` | computer, query | bounded summaries/cursor | read-only |
| `get_chat` | computer, chat ID | record, up to 100 messages/cursor | read-only |

Every tool is open-world because it contacts Matrix. `run_command` is state-changing regardless of argv. Upload overwrite defaults false; all chat tools are read-only.

## Representative messages

```json
{"computer":"primary","command":["git","status","--short"],"cwd":"projects/repo","timeoutMs":60000}
```

```json
{"ok":true,"computer":{"runtimeSlot":"primary","handle":"neo"},"stdout":"","stderr":"","exitCode":0,"signal":null,"timedOut":false,"truncated":false,"durationMs":18}
```

```json
{"computer":"primary","terminal":"agent-task-4f2a","name":"tests","cwd":"projects/repo"}
```

```json
{"ok":true,"tab":{"id":41,"name":"tests"}}
```

`id` is the stable Zellij tab ID; `idx` from listing is only its current display position. Callers select by `id` before sending input when identity matters. The gateway returns the ID emitted by `zellij action new-tab` and accepts it at `POST /api/terminal/sessions/:name/tabs/by-id/:tabId/go`; the position route stays compatible. The stable-ID route uses existing computer-scoped auth, bounded-body middleware, and validated path parameters.

File transfer is content-only:

```json
{"computer":"primary","path":"projects/repo/notes.txt","encoding":"utf8","content":"hello\n","overwrite":false,"secret":false}
```

Binary upload/download uses base64. Text reads cap at 256 KiB, binary at 1 MiB, terminal input at 60,000 characters, command output at 1 MiB combined, directories at 500 entries, and chat pages at 100.

## Safe errors and transport

```json
{"ok":false,"error":{"code":"auth_required","message":"Authenticate with the Matrix CLI and try again.","retryable":false}}
```

Allowed codes: `invalid_input`, `auth_required`, `computer_not_found`, `computer_unavailable`, `not_found`, `conflict`, `payload_too_large`, `request_timeout`, `request_failed`.

`matrix mcp serve [--profile <name>]` starts one stdio server, performs no owner-data read during protocol initialization, emits protocol data only on stdout, and exits when stdin or transport disconnects.
