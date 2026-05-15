# Contract: Mobile Shell API

This contract documents the gateway/mobile interactions needed by the 075 mobile shell. Existing PR #99 app-runtime endpoints are included because the plan builds on them.

## Auth

All endpoints require the authenticated Matrix owner session unless marked otherwise. Browser/mobile WebSocket routes must support query-token auth where browser APIs cannot set `Authorization` headers.

## App Inventory

### `GET /api/apps`

Returns owner-visible system and user apps.

Response:

```json
[
  {
    "name": "Notes",
    "description": "Write notes",
    "icon": "/icons/notes.png",
    "category": "Productivity",
    "slug": "notes",
    "runtime": "vite",
    "runtimeState": { "status": "ready" },
    "launchUrl": "/apps/notes/",
    "file": "notes/index.html",
    "path": "/files/apps/notes/index.html"
  }
]
```

Rules:

- Response entries must not expose internal filesystem paths.
- Unreadable apps are skipped with server-side logs and generic runtime state.
- Mobile clients must treat this as advisory and handle missing apps during launch.

## App Manifest

### `GET /api/apps/:slug/manifest`

Returns a safe app manifest and runtime state for a safe app slug.

Rules:

- `slug` is validated at the route boundary.
- Unknown or invalid apps return generic not-found/unavailable responses.
- Provider, filesystem, and process errors are not returned raw.

## Mobile App Session Bootstrap

### `POST /api/apps/:slug/session-token`

Creates a short-lived mobile app runtime session and returns a launch URL.

Request:

```json
{}
```

Response:

```json
{
  "token": "one-shot-mobile-session-token",
  "launchUrl": "/apps/notes/?session=one-shot-mobile-session-token",
  "expiresAt": 1770000000000
}
```

Rules:

- Route uses `bodyLimit`.
- `slug` is validated.
- Session token is scoped to the authenticated owner and app slug.
- Errors are generic to the client and detailed only in server logs.

## Terminal Sessions

### `GET /api/terminal/sessions`

Lists resumable terminal sessions owned by the authenticated user.

Response:

```json
[
  {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "cwd": "projects/demo",
    "state": "running",
    "createdAt": 1770000000000,
    "lastAttachedAt": 1770000300000,
    "attachedClients": 0,
    "exitCode": null
  }
]
```

Rules:

- Only owner-visible sessions are returned.
- Ended/stale sessions are either omitted or marked terminal according to gateway cleanup policy.
- Response is bounded to the gateway terminal session cap unless a future implementation changes and tests that cap.

### `DELETE /api/terminal/sessions/:id`

Intentionally ends a terminal session.

Rules:

- DELETE still uses `bodyLimit`.
- `id` is validated as a terminal session UUID.
- Repeat deletes do not resurrect or refresh stale sessions.

## Terminal WebSocket

### `GET /ws/terminal?token=...`

Attaches to an existing or newly created terminal session. Terminal creation happens by sending an `attach` frame with `cwd`; resume happens by sending an `attach` frame with `sessionId`.

Client frames:

```json
{ "type": "attach", "cwd": "projects/demo", "shell": "/bin/zsh" }
```

```json
{ "type": "attach", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "fromSeq": 42 }
```

```json
{ "type": "input", "data": "ls\n" }
```

```json
{ "type": "resize", "cols": 80, "rows": 24 }
```

```json
{ "type": "detach" }
```

```json
{ "type": "destroy" }
```

```json
{ "type": "ping" }
```

Server frames:

```json
{ "type": "attached", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "state": "running" }
```

```json
{ "type": "output", "data": "output", "seq": 1 }
```

```json
{ "type": "exit", "code": 0 }
```

Rules:

- Query-token path is explicitly allowlisted for browser/mobile WebSocket auth.
- Every frame is schema-validated after JSON parsing.
- Input frame size is bounded to the gateway 64KB limit; phone key/control/paste actions map to bounded `input` frames.
- Resize is bounded to gateway row/column limits: 1-500 columns and 1-200 rows.
- Subscriber fan-out remains capped by the gateway session subscriber limit.
- Per-subscriber send failures are isolated and dead senders are evicted.
- Attach/auth setup completes before any success frame is sent.
