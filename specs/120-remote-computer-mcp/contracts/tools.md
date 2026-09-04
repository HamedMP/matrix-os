# MCP Tool Contract: Matrix Remote Computer

All tool names are exposed under the MCP server namespace chosen by the coding-agent host. JSON examples omit the outer MCP protocol envelope.

Every computer-scoped input requires `computer`, the `runtimeSlot` returned by `list_computers`. Every result includes a machine-readable `ok` boolean. Failures use a safe code and message; credentials and raw upstream bodies are never returned.

## Discovery

### `list_computers`

Input: `{}`

Output:

```json
{"ok":true,"computers":[{"runtimeSlot":"primary","handle":"neo","label":"Main Computer","availability":"available","kind":"customer","versionLabel":"stable","capabilities":[]}],"selectedSlot":"primary","hasMore":false}
```

Annotation: read-only, open-world.

## Commands

### `run_command`

Input:

```json
{"computer":"primary","command":["git","status","--short"],"cwd":"projects/repo","timeoutMs":60000}
```

Output:

```json
{"ok":true,"computer":{"runtimeSlot":"primary","handle":"neo"},"stdout":"","stderr":"","exitCode":0,"signal":null,"timedOut":false,"truncated":false,"durationMs":18}
```

Annotation: state-changing, open-world. Although commands may be read-only, their effect is determined by argv, so this tool is never marked read-only.

## Persistent terminals

### `list_terminals`

Input: `{"computer":"primary"}`

Output: `{"ok":true,"terminals":[...bounded safe terminal metadata...]}`

### `create_terminal`

Input: `{"computer":"primary","name":"agent-task-4f2a","cwd":"projects/repo"}`

Output: `{"ok":true,"terminal":{"name":"agent-task-4f2a","created":true}}`

### `list_terminal_tabs`

Input: `{"computer":"primary","terminal":"agent-task-4f2a"}`

Output: `{"ok":true,"tabs":[{"idx":0,"name":"shell"}]}`

### `create_terminal_tab`

Input: `{"computer":"primary","terminal":"agent-task-4f2a","name":"tests","cwd":"projects/repo"}`

Output: `{"ok":true,"tab":{"created":true}}`

### `select_terminal_tab`

Input: `{"computer":"primary","terminal":"agent-task-4f2a","tab":1}`

Output: `{"ok":true,"terminal":"agent-task-4f2a","tab":1}`

### `send_terminal_input`

Input: `{"computer":"primary","terminal":"agent-task-4f2a","data":"bun run test\n"}`

Output: `{"ok":true,"terminal":"agent-task-4f2a","bytes":13}`

Terminal listing is read-only. Create/select/input operations are state-changing and open-world. Input is sent to the currently active tab; callers use `select_terminal_tab` first when tab identity matters.

## Files

### `list_files`

Input: `{"computer":"primary","path":"projects/repo"}`

Output: `{"ok":true,"path":"projects/repo","entries":[...up to 500...]}`

### `read_file`

Input: `{"computer":"primary","path":"projects/repo/README.md"}`

Output: `{"ok":true,"path":"projects/repo/README.md","encoding":"utf8","content":"...","size":1234,"mediaType":"text/markdown"}`

### `download_file`

Input: `{"computer":"primary","path":"artifacts/report.pdf"}`

Output: `{"ok":true,"path":"artifacts/report.pdf","filename":"report.pdf","encoding":"base64","content":"JVBERi0...","size":8192,"mediaType":"application/pdf"}`

### `upload_file`

UTF-8 input:

```json
{"computer":"primary","path":"projects/repo/notes.txt","encoding":"utf8","content":"hello\n","overwrite":false,"secret":false}
```

Binary input uses `"encoding":"base64"`. Output is `{"ok":true,"path":"...","size":6}`.

List/read/download are read-only and open-world. Upload is state-changing and open-world; overwrite defaults to false.

## Chats

### `list_chats`

Input: `{"computer":"primary","limit":20,"lifecycle":"active","cursor":"optional-cursor"}`

Output: `{"ok":true,"items":[...],"nextCursor":"optional-cursor"}`

### `search_chats`

Input: `{"computer":"primary","query":"terminal bug","limit":20}`

Output follows `list_chats`.

### `get_chat`

Input: `{"computer":"primary","chatId":"chat_...","limit":100,"cursor":"optional-cursor"}`

Output: `{"ok":true,"record":{...},"messages":[...up to 100...],"nextCursor":"optional-cursor"}`

All chat tools are read-only and open-world.

## Safe error shape

```json
{"ok":false,"error":{"code":"auth_required","message":"Authenticate with the Matrix CLI and try again.","retryable":false}}
```

Allowed public codes: `invalid_input`, `auth_required`, `computer_not_found`, `computer_unavailable`, `not_found`, `conflict`, `payload_too_large`, `request_timeout`, and `request_failed`.

## Transport lifecycle

The command `matrix mcp serve [--profile <name>]` starts one stdio server, loads no owner data merely for protocol initialization, and exits when stdin closes or the transport disconnects. It never emits human-readable text on stdout.
