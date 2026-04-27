# WebSocket Protocol Contract: Terminal Attach

## Endpoint

`WS /ws/terminal?session=<name>[&fromSeq=<n>]`

## Auth

- Browser clients use a short-lived terminal token in the query string because browser WebSocket APIs cannot set headers.
- CLI and editor clients use `Authorization: Bearer <sync-jwt>` and should not use query-string long-lived tokens.
- The session name is always validated and scoped to the authenticated user.

## Connect Behavior

1. Authenticate the request.
2. Validate `session` and optional `fromSeq`.
3. Attach to the existing zellij session.
4. Start bounded replay if `fromSeq` is provided.
5. Forward terminal bytes between the WS client and the zellij attach PTY.

Attaching to a missing session fails; clients should call the create-session route or `matrix shell new <name>`.

## Server Events

```json
{ "type": "attached", "session": "main", "state": "running", "fromSeq": 42 }
```

```json
{ "type": "replay-start", "fromSeq": 10 }
```

```json
{ "type": "output", "seq": 11, "data": "base64-or-utf8-terminal-data" }
```

```json
{ "type": "replay-end", "toSeq": 42 }
```

```json
{ "type": "exit", "code": 0 }
```

```json
{ "type": "error", "code": "session_not_found", "message": "Session not found" }
```

## Client Events

```json
{ "type": "input", "data": "bytes" }
```

```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

```json
{ "type": "detach" }
```

## Resource Rules

- Per-session replay buffers are capped by byte count and event count.
- Oversized client messages close the connection with a stable error.
- Each attach owns its own zellij client process.
- Process cleanup runs on close, error, and server shutdown.
