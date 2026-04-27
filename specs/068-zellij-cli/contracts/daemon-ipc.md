# Daemon IPC Contract: Version 1

The local sync daemon exposes control-plane operations over `~/.matrixos/daemon.sock`.

## Transport

- Unix socket path: `~/.matrixos/daemon.sock`
- Socket directory mode: `0700`
- Socket mode: `0600`
- Wire format: one JSON object per line
- Max message size: 65536 bytes unless implementation tightens it
- Every request and response includes `"v": 1`

## Request Envelope

```json
{
  "id": "uuid-or-client-id",
  "v": 1,
  "command": "shell.list",
  "args": {}
}
```

## Success Envelope

```json
{
  "id": "uuid-or-client-id",
  "v": 1,
  "result": {}
}
```

## Error Envelope

```json
{
  "id": "uuid-or-client-id",
  "v": 1,
  "error": {
    "code": "stable_code",
    "message": "Generic safe message"
  }
}
```

## Commands

### Auth

- `auth.whoami` -> `{ "authenticated": true, "userId": "user_...", "handle": "alice" }`
- `auth.token` -> `{ "accessToken": "...", "expiresAt": "..." }`
- `auth.refresh` -> `{ "accessToken": "...", "expiresAt": "..." }`

### Shell

- `shell.list` -> `{ "sessions": [...] }`
- `shell.create` args `{ "name": "main", "layout": "dev", "cwd": "~/project", "cmd": "claude" }`
- `shell.destroy` args `{ "name": "main", "force": false }`

Terminal bytes are not proxied through daemon IPC. Clients attach directly to the gateway WS after resolving auth/profile data.

### Tabs

- `tab.list` args `{ "session": "main" }`
- `tab.create` args `{ "session": "main", "name": "editor", "layout": "dev", "cwd": "~/project" }`
- `tab.go` args `{ "session": "main", "tab": 1 }`
- `tab.close` args `{ "session": "main", "tab": 1 }`

### Panes

- `pane.split` args `{ "session": "main", "direction": "right", "cmd": "bun run test", "cwd": "~/project" }`
- `pane.close` args `{ "session": "main", "pane": "pane-2" }`

### Layouts

- `layout.list` -> `{ "layouts": [...] }`
- `layout.show` args `{ "name": "dev" }`
- `layout.save` args `{ "name": "dev", "kdl": "layout { ... }" }`
- `layout.apply` args `{ "session": "main", "name": "dev" }`
- `layout.delete` args `{ "name": "dev" }`

### Sync

Existing commands remain supported:

- `status`
- `pause`
- `resume`
- `getConfig`
- `setSyncPath`
- `setGatewayFolder`
- `restart`
- `logout`

Versioned aliases are supported while keeping old commands for compatibility:

- `sync.status`
- `sync.pause`
- `sync.resume`
- `sync.events`

## Compatibility

- v1 commands remain supported for at least two minor releases after v2 exists.
- Unknown commands return `unknown_command`.
- Unsupported protocol versions return `unsupported_version`.
- Terminal byte streams are intentionally outside daemon IPC. Editor clients use `auth.token` plus `status.gatewayUrl` to attach directly to `/ws/terminal?session=<name>`, keeping daemon IPC as a small local control plane.
