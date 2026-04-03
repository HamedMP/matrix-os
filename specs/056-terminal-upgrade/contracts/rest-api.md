# REST API Contract: Terminal Sessions

## GET /api/terminal/sessions

List active terminal sessions.

**Auth**: Same as existing gateway auth.

**Response 200**:

```json
[
  {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "cwd": "/home/matrixos/home/projects/myapp",
    "shell": "/bin/bash",
    "state": "running",
    "createdAt": 1712160000000,
    "lastAttachedAt": 1712160300000,
    "attachedClients": 1
  }
]
```

## DELETE /api/terminal/sessions/:id

Destroy a terminal session. Kills PTY process, clears buffer, removes from registry.

**Auth**: Same as existing gateway auth.

**Path params**:
- `id`: UUID v4 format. Validated via regex.

**Response 200**:

```json
{ "ok": true }
```

**Response 404**:

```json
{ "error": "Session not found" }
```

**Response 400**:

```json
{ "error": "Invalid session ID" }
```
