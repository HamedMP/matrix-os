# Terminal HTTP API Additions

All routes use the gateway's existing owner authentication. Both `/api/terminal`
and legacy `/api` mounts receive the same runtime client and create/recover rate
limiter at registration time.

## Recover

`POST /api/terminal/sessions/:name/recover`

- Path name: existing strict terminal safe-name schema.
- Body: no body or exactly `{}` via `z.object({}).strict()`.
- `bodyLimit` applies before parsing.
- The validated name resolves server-side to one immutable runtime ID.
- `200`: runtime already live.
- `202`: one recovery operation is starting/recovering.
- Generic `404`, `409`, `429`, or `503`; no raw schema, provider, systemd,
  filesystem, path, or supervisor detail.
- Concurrent calls return the same runtime/operation and start at most one unit.

Example response:

```json
{
  "runtimeId": "fedcba9876543210fedcba9876543210",
  "name": "project-shell",
  "lifecycleState": "recovering",
  "recoverable": true,
  "recoveryReason": null,
  "metadataRevision": 3
}
```

## Existing terminal routes

Create, list, rename, delete, health, tab, pane, layout, input, and WebSocket
attach routes keep their existing name-based public forms. Every name is
validated and resolved to runtime ID before calling the supervisor or Zellij.
Input/write/tab/pane/layout mutations return generic conflict unless lifecycle
is authoritatively `live`. Attach never implicitly creates or recovers.

## List projection

Existing list fields remain. Add `runtimeId`, `lifecycleState`, `recoverable`,
`recoveryReason`, and `metadataRevision`. Clients must not infer liveness from
saved layout records or agent-running metadata.
