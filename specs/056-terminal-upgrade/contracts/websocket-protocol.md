# WebSocket Protocol Contract: /ws/terminal

## Connection

```
GET /ws/terminal?cwd={encodedPath}
Upgrade: websocket
```

Auth: Same as existing gateway WebSocket auth.

## Client → Server Messages

### attach (create new session)

```json
{ "type": "attach", "cwd": "/home/matrixos/home/projects/myapp", "shell": "/bin/bash" }
```

- `cwd`: Required. Validated via `resolveWithinHome()`.
- `shell`: Optional. Defaults to `$SHELL` or `/bin/bash`.

### attach (reattach to existing session)

```json
{ "type": "attach", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "fromSeq": 42 }
```

- `sessionId`: Required. UUID v4 format.
- `fromSeq`: Optional. If provided, replay starts from this seq. Default: 0 (full replay).

### input

```json
{ "type": "input", "data": "ls -la\r" }
```

- `data`: String, max 64KB.

### resize

```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

- `cols`: Integer, 1-500.
- `rows`: Integer, 1-200.

### detach

```json
{ "type": "detach" }
```

No payload. Session stays alive.

## Server → Client Messages

### attached

```json
{ "type": "attached", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "state": "running" }
```

```json
{ "type": "attached", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "state": "exited", "exitCode": 0 }
```

### output

```json
{ "type": "output", "data": "total 42\n", "seq": 7 }
```

- `seq`: Monotonically increasing sequence number per session.

### replay-start

```json
{ "type": "replay-start", "fromSeq": 0 }
```

### replay-end

```json
{ "type": "replay-end", "toSeq": 42 }
```

After `replay-end`, live output follows as `output` messages.

### exit

```json
{ "type": "exit", "code": 0 }
```

### error

```json
{ "type": "error", "message": "Session not found" }
```

Generic messages only. No internal state leakage.

## Backward Compatibility

If a client connects with `?cwd=` and sends no `attach` message within 100ms, the server auto-creates a session — same external behavior as current spec 047 but now backed by a persistent session.

## Zod Schemas

```typescript
import { z } from "zod/v4"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const AttachNewSchema = z.object({
  type: z.literal("attach"),
  cwd: z.string().min(1).max(4096),
  shell: z.string().min(1).max(256).optional(),
})

const AttachExistingSchema = z.object({
  type: z.literal("attach"),
  sessionId: z.string().regex(UUID_REGEX),
  fromSeq: z.number().int().nonnegative().optional(),
})

const AttachSchema = z.union([AttachNewSchema, AttachExistingSchema])

const InputSchema = z.object({
  type: z.literal("input"),
  data: z.string().max(65536),
})

const ResizeSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
})

const DetachSchema = z.object({
  type: z.literal("detach"),
})

const ClientMessageSchema = z.union([AttachSchema, InputSchema, ResizeSchema, DetachSchema])
```
