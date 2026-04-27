# REST API Contract: Zellij-Native Shell

All gateway routes are authenticated and scoped to the active user's container/home. Responses use JSON. Client-visible errors use:

```json
{
  "error": {
    "code": "stable_code",
    "message": "Generic safe message"
  }
}
```

Raw zellij output, filesystem paths, stack traces, and provider/internal details must not be returned to clients.

## Common Rules

- Auth: sync JWT bearer for CLI/editor clients. Browser routes may rely on existing session/token helpers only where already established.
- Mutating routes: must use Hono `bodyLimit` before body parsing.
- Names: validate session and layout names as safe slugs.
- Paths: resolve cwd/layout paths within the user's home/system layout directory.
- Timeouts: every zellij control subprocess has a bounded timeout and cancellation.
- Atomicity: registry and layout writes are atomic.

## `GET /api/sessions`

Lists zellij-backed sessions.

Response `200`:

```json
{
  "sessions": [
    {
      "name": "main",
      "status": "active",
      "tabs": [{ "idx": 0, "name": "shell", "focused": true }],
      "attachedClients": 1,
      "createdAt": "2026-04-26T00:00:00.000Z",
      "updatedAt": "2026-04-26T00:00:00.000Z"
    }
  ]
}
```

## `POST /api/sessions`

Creates a named session.

Request body limit: 4096 bytes.

Request:

```json
{
  "name": "main",
  "layout": "default",
  "cwd": "~/projects",
  "cmd": "claude"
}
```

Response `201`:

```json
{ "name": "main", "created": true }
```

Errors:

- `400 invalid_session_name`
- `400 invalid_cwd`
- `404 layout_not_found`
- `409 session_exists`
- `507 session_limit`
- `504 session_create_timeout`

## `DELETE /api/sessions/:name`

Deletes a named session.

Query:

- `force=1`: allow forced termination where supported.

Response `200`:

```json
{ "ok": true }
```

Errors:

- `400 invalid_session_name`
- `404 session_not_found`
- `504 session_delete_timeout`

## `GET /api/sessions/:name/tabs`

Lists tab metadata for a session.

Response `200`:

```json
{
  "tabs": [
    { "idx": 0, "name": "shell", "focused": true }
  ]
}
```

## `POST /api/sessions/:name/tabs`

Creates a tab in a session.

Request body limit: 4096 bytes.

Request:

```json
{
  "name": "editor",
  "layout": "dev",
  "cwd": "~/projects/app"
}
```

Response `201`:

```json
{ "idx": 1, "name": "editor" }
```

## `DELETE /api/sessions/:name/tabs/:target`

Closes a tab by index or explicit name target.

Response `200`:

```json
{ "ok": true }
```

## `POST /api/sessions/:name/panes/split`

Splits the focused pane.

Request body limit: 4096 bytes.

Request:

```json
{
  "direction": "right",
  "cmd": "bun run test",
  "cwd": "~/projects/app"
}
```

Response `200`:

```json
{ "ok": true }
```

## `DELETE /api/sessions/:name/panes/focused`

Closes the focused pane.

Response `200`:

```json
{ "ok": true }
```

## `GET /api/layouts`

Lists saved layouts.

Response `200`:

```json
{
  "layouts": [
    {
      "name": "dev",
      "modifiedAt": "2026-04-26T00:00:00.000Z"
    }
  ]
}
```

## `GET /api/layouts/:name`

Reads a layout.

Response `200`:

```json
{
  "name": "dev",
  "kdl": "layout { }"
}
```

## `PUT /api/layouts/:name`

Validates and saves a layout.

Request body limit: 100000 bytes.

Request:

```json
{ "kdl": "layout { }" }
```

Response `200`:

```json
{ "ok": true }
```

Errors:

- `400 invalid_layout_name`
- `400 invalid_layout`
- `413 layout_too_large`
- `504 layout_validation_timeout`

## `DELETE /api/layouts/:name`

Deletes a layout.

Response `200`:

```json
{ "ok": true }
```

## `POST /api/sessions/:name/layout/dump`

Dumps the current session layout.

Request body limit: 1024 bytes.

Response `200`:

```json
{ "kdl": "layout { }" }
```
