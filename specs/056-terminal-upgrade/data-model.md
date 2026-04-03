# Data Model: Terminal Upgrade (Spec 056)

## Entities

### BufferChunk (in-memory only)

```typescript
interface BufferChunk {
  seq: number    // Monotonically increasing, never wraps
  data: string   // Raw PTY output
}
```

- Stored in RingBuffer's internal array
- Evicted when buffer exceeds maxBytes (5MB default)
- No persistence — lost on gateway restart

### SessionInfo (persisted to file)

```typescript
interface SessionInfo {
  sessionId: string         // UUID v4
  cwd: string               // Validated absolute path within home
  shell: string             // e.g. "/bin/bash", "/bin/zsh"
  state: "running" | "exited"
  exitCode?: number         // Set when state transitions to "exited"
  createdAt: number         // Date.now() epoch ms
  lastAttachedAt: number    // Updated on each client attach
  attachedClients: number   // Current connected client count (not persisted)
}
```

**Persistence**: `~/system/terminal-sessions.json` — array of SessionInfo (minus `attachedClients` which is runtime-only). Atomic writes (tmp + rename). Max 50KB.

**State transitions**:
```
create() → running
PTY exit → exited (exitCode set)
destroy() → removed from registry
```

### PaneNode (updated — persisted in terminal-layout.json)

```typescript
type PaneNode =
  | { type: "pane"; id: string; cwd: string; sessionId?: string; claudeMode?: boolean }
  | { type: "split"; direction: "horizontal" | "vertical"; children: [PaneNode, PaneNode]; ratio: number }
```

- `sessionId` is new (optional for backward compat)
- Written after session creation, used for reattach on restore
- Falls back to `cwd` if session is gone

### CachedTerminal (in-memory, frontend only)

```typescript
interface CachedTerminal {
  terminal: Terminal           // xterm.js instance
  fitAddon: FitAddon
  webglAddon: WebglAddon | null
  searchAddon: SearchAddon | null
  ws: WebSocket
  lastSeq: number              // Last received sequence number
  sessionId: string
}
```

- Keyed by `paneId` in a module-level Map
- LRU cap of MAX_CACHED=20 with eviction (sends detach, closes WS, disposes terminal)

### AnsiPalette (static config)

```typescript
interface AnsiPalette {
  black: string; red: string; green: string; yellow: string
  blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}
```

- 9 curated palettes (one-dark, one-light, catppuccin-mocha, dracula, nord, solarized-dark, solarized-light, github-dark, github-light)
- Mapped from OS theme slug via `themeMapping` record

## Relationships

```
SessionRegistry 1──* PtySession (in-memory, owns PTY process + RingBuffer)
PtySession 1──1 RingBuffer (5MB, holds BufferChunk[])
PtySession 1──* SessionHandle (one per connected WebSocket client)

PaneNode *──? SessionInfo (optional sessionId reference)
CachedTerminal 1──1 PaneNode (keyed by paneId)
```

## Validation Rules

| Field | Rule |
|-------|------|
| sessionId | UUID format regex `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i` |
| cwd | Must pass `resolveWithinHome()` — no path traversal |
| cols/rows | Positive integers, `1 <= cols <= 500`, `1 <= rows <= 200` |
| input data | String, max 64KB per message |
| fromSeq | Non-negative integer |
| Ring buffer | Max 5MB per session, chunks evicted FIFO |
| Session count | Max 20 concurrent |
| Session metadata file | Max 50KB |
