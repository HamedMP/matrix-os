# Spec 056: Terminal Upgrade — Warp-Grade Features

## Overview

Upgrade the existing terminal (spec 047) from a basic xterm.js wrapper to a Warp-grade terminal with persistent sessions, GPU rendering, search, rich themes, clickable links, and smart clipboard handling. The terminal should feel like a native app — sessions survive browser refresh, tab switching is instant, and output rendering is fast.

This spec ports proven patterns from the slayzone terminal implementation, adapted for Matrix OS's WebSocket-based architecture.

## Goals

1. PTY sessions persist across browser refresh, tab switch, and window close/reopen
2. Terminal output history is preserved via backend ring buffer with sequence-numbered chunks
3. GPU-accelerated rendering via WebGL (5-10x speedup for heavy output)
4. In-terminal search with match highlighting
5. High-quality ANSI color palettes per OS theme preset
6. Clickable URLs and file paths (with line:col support)
7. Improved copy/paste with Ctrl+Shift+C/V
8. xterm.js instance caching for instant tab switching
9. Serialize addon for future terminal output export
10. All features respect the existing Matrix OS theme system (no separate terminal theme picker)

## Non-Goals

- No AI activity detection or provider-specific adapters (separate future spec)
- No PTY survival across gateway restarts (process dies, but session metadata persists for cleanup)
- No block-based output grouping (Warp blocks — future spec)
- No terminal theme picker independent of OS theme

## Dependencies

- Spec 047 (Terminal App) — this spec extends the existing terminal
- Existing packages: `@xterm/xterm`, `@xterm/addon-fit`, `node-pty`
- New packages: `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-serialize`

---

## Architecture

### Current State

```
Browser (TerminalPane)          Gateway (server.ts)
┌─────────────────┐            ┌─────────────────┐
│ xterm.js        │◄──WebSocket──► createPtyHandler │
│ (created fresh  │            │ (thin pipe,      │
│  each mount)    │            │  PTY dies on     │
│                 │            │  WS close)       │
└─────────────────┘            └─────────────────┘
```

Each tab mount creates a new xterm + WebSocket + PTY. Switching tabs destroys everything. No history survives.

### Target State

```
Browser                              Gateway
┌──────────────────────┐            ┌───────────────────────────────┐
│ Terminal Cache        │            │ SessionRegistry               │
│ ┌──────────────────┐ │            │ ┌───────────────────────────┐ │
│ │ xterm instance   │ │            │ │ PtySession (sessionId)    │ │
│ │ (preserved on    │ │            │ │ ├── node-pty process      │ │
│ │  tab switch)     │◄──WebSocket──►─│ ├── RingBuffer (5MB)      │ │
│ │                  │ │            │ │ ├── attached client count  │ │
│ │ lastSeq tracking │ │            │ │ └── state (running/exited)│ │
│ └──────────────────┘ │            │ └───────────────────────────┘ │
│                      │            │                               │
│ terminal-layout.json │            │ terminal-sessions.json        │
│ (paneId → sessionId) │            │ (sessionId → metadata)        │
└──────────────────────┘            └───────────────────────────────┘
```

PTY sessions live in the registry, independent of WebSocket lifetime. Frontend caches xterm instances across tab switches. Ring buffer captures all output for replay on reconnection.

---

## 1. Session Registry

### `SessionRegistry` Class

New file: `packages/gateway/src/session-registry.ts`

```typescript
interface SessionInfo {
  sessionId: string
  cwd: string
  shell: string
  state: "running" | "exited"
  exitCode?: number
  createdAt: number        // Date.now()
  lastAttachedAt: number
  attachedClients: number
}

class SessionRegistry {
  create(cwd: string, shell?: string): string        // returns sessionId
  attach(sessionId: string): SessionHandle | null     // null if session not found
  destroy(sessionId: string): void
  list(): SessionInfo[]
  getSession(sessionId: string): SessionInfo | null
  shutdown(): void                                    // cleanup on gateway stop
}

interface SessionHandle {
  sessionId: string
  subscribe(cb: (msg: PtyServerMessage) => void): void
  send(msg: PtyMessage): void
  replay(fromSeq: number): void    // replays buffered output via subscribe cb
  detach(): void
}
```

**Session lifecycle**:

1. `create(cwd)` — spawns PTY, allocates ring buffer, generates UUID session ID, saves metadata to `~/system/terminal-sessions.json`
2. `attach(sessionId)` — increments attached client count, returns a handle for I/O
3. Handle's `replay(fromSeq)` — sends `replay-start`, then all buffered chunks since `fromSeq`, then `replay-end`
4. Handle's `detach()` — decrements client count. If count reaches 0, session becomes orphaned (stays alive)
5. `destroy(sessionId)` — kills PTY process, clears buffer, removes from registry and persistence file

**Eviction policy**: Max 20 sessions. When the cap is hit, the oldest orphaned session (lowest `lastAttachedAt` with `attachedClients === 0`) is destroyed. If all 20 sessions are attached, creation fails with an error message.

**Persistence**: `~/system/terminal-sessions.json` stores session metadata (sessionId, cwd, shell, createdAt). On gateway startup, stale entries are cleaned up (no live PTY process to reconnect to). The file is written atomically (write to `.tmp`, rename).

**Resource limits**:
- Max 20 concurrent sessions
- 5MB ring buffer per session (100MB worst case total)
- Session metadata file capped at 50KB (bodyLimit on any endpoint that writes to it)

### Ring Buffer

New file: `packages/gateway/src/ring-buffer.ts`

```typescript
interface BufferChunk {
  seq: number
  data: string
}

class RingBuffer {
  constructor(maxBytes?: number)       // default 5MB (5 * 1024 * 1024)

  write(data: string): number          // appends chunk, returns seq number
  getSince(seq: number): BufferChunk[] // all chunks with seq >= given seq
  getAll(): BufferChunk[]              // all chunks currently in buffer
  clear(): void
  readonly currentBytes: number
  readonly nextSeq: number
}
```

- Sequence numbers are monotonically increasing (start at 0, never wrap)
- When `currentBytes` exceeds `maxBytes`, oldest chunks are evicted until under the cap
- Clients detect gaps via seq discontinuity (chunk 5 followed by chunk 12 means 6-11 were evicted)
- `getSince(0)` returns the full buffer (used on first attach)

### WebSocket Protocol Changes

Current protocol preserved for backward compatibility. New messages added:

**Client to Server**:

| Message | Description |
|---------|-------------|
| `{ type: "attach", sessionId, fromSeq? }` | Reattach to existing session, replay from seq |
| `{ type: "attach", cwd, shell? }` | Create new session and attach |
| `{ type: "input", data }` | Send keystrokes (unchanged) |
| `{ type: "resize", cols, rows }` | Resize PTY (unchanged) |
| `{ type: "detach" }` | Detach without killing session |

**Server to Client**:

| Message | Description |
|---------|-------------|
| `{ type: "attached", sessionId, state, exitCode? }` | Confirmation with session info |
| `{ type: "output", data, seq }` | PTY output with sequence number |
| `{ type: "replay-start", fromSeq }` | Buffer replay beginning |
| `{ type: "replay-end", toSeq }` | Buffer replay complete, live stream follows |
| `{ type: "exit", code }` | Process exited (unchanged) |
| `{ type: "error", message }` | Error (session not found, cap reached, etc.) |

**Backward compatibility**: The existing `?cwd=` query param on the WebSocket URL still works. If a client connects with `?cwd=` and sends no `attach` message, the gateway auto-creates a session — same behavior as today but now with a persistent session behind it.

**Detach behavior**: Both explicit `{ type: "detach" }` and unexpected WebSocket close (browser crash, network loss) result in the same behavior — session stays alive, client count decremented.

### Integration with `server.ts`

The `SessionRegistry` is instantiated once in `server.ts` and passed to the WebSocket upgrade handler. The existing `createPtyHandler` is replaced — its logic moves into `SessionRegistry.create()`.

```
server.ts startup:
  const sessionRegistry = new SessionRegistry(homePath, {
    maxSessions: 20,
    bufferSize: 5 * 1024 * 1024,
    persistPath: path.join(homePath, "system/terminal-sessions.json"),
  })

  // WebSocket handler
  app.get("/ws/terminal", upgradeWebSocket((c) => {
    const cwd = c.req.query("cwd")
    return createTerminalWsHandler(sessionRegistry, cwd)
  }))

  // REST endpoints for session management
  app.get("/api/terminal/sessions", ...)
  app.delete("/api/terminal/sessions/:id", ...)
```

### New REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/terminal/sessions` | Same as existing terminal WS | List active sessions |
| DELETE | `/api/terminal/sessions/:id` | Same as existing terminal WS | Destroy a session |

Input validation:
- Session ID: UUID format validation
- Path parameters sanitized (no traversal)
- Response: generic error messages, no internal state leakage

---

## 2. Terminal Instance Caching (Frontend)

### Cache Module

New file: `shell/src/components/terminal/terminal-cache.ts`

```typescript
interface CachedTerminal {
  terminal: Terminal
  fitAddon: FitAddon
  webglAddon: WebglAddon | null
  searchAddon: SearchAddon | null
  ws: WebSocket
  lastSeq: number
  sessionId: string
}

const cache = new Map<string, CachedTerminal>()

function cacheTerminal(paneId: string, entry: CachedTerminal): void
function getCached(paneId: string): CachedTerminal | null
function removeCached(paneId: string): void
function hasCached(paneId: string): boolean
```

No size cap needed — bounded by open pane count (max 4 per tab, reasonable tab count).

### Tab Switch Flow

1. **Switching away from pane**: The xterm.js `Terminal` DOM element is detached from its container (not destroyed). WebSocket stays open. Entry stored in cache keyed by pane ID.
2. **Switching to cached pane**: DOM element reattached to new container. `fitAddon.fit()` called to handle size changes. No network activity.
3. **New pane (cache miss)**: Fresh Terminal + addons created, WebSocket opened, `attach` message sent with `cwd`. Server creates session, sends `attached` response.

### Refresh/Reopen Flow

1. Page loads, reads `~/system/terminal-layout.json` (existing behavior)
2. Layout now includes `sessionId` per pane (new field)
3. For each pane with a `sessionId`: create new Terminal + addons, open WebSocket, send `{ type: "attach", sessionId, fromSeq: 0 }`
4. Server replays full ring buffer -> xterm renders scrollback history
5. If session not found (gateway restarted): server sends `{ type: "error" }`, client falls back to creating a new session with the stored `cwd`

### Layout Persistence Update

The `PaneNode` type gains a `sessionId` field:

```typescript
type PaneNode =
  | { type: "pane"; id: string; cwd: string; sessionId?: string; claudeMode?: boolean }
  | { type: "split"; direction: "horizontal" | "vertical"; children: [PaneNode, PaneNode]; ratio: number }
```

`sessionId` is written to `terminal-layout.json` after a session is created. On restore, it's used to reattach. If the session is gone, `cwd` is used to create a new one.

### WebSocket Reconnection

If a WebSocket drops unexpectedly while the pane is visible:
1. Wait 1 second, then reconnect
2. Send `{ type: "attach", sessionId, fromSeq: lastSeq }` to replay only missed output
3. If session is gone, create new session with stored `cwd`
4. Max 3 reconnection attempts with exponential backoff (1s, 2s, 4s), then show "[Disconnected]" with a "Reconnect" button

---

## 3. WebGL Rendering

### Changes

File: `shell/src/components/terminal/TerminalPane.tsx`

- Add `@xterm/addon-webgl` to shell dependencies
- After loading `addon-fit`, load and activate the WebGL addon
- Wrap in try/catch: if WebGL context creation fails, log warning and continue (canvas fallback is automatic)
- Listen for `webglcontextlost` event on the terminal's canvas element — dispose and recreate the WebGL addon

### Fallback

xterm.js renders via canvas 2D by default. The WebGL addon replaces the renderer. If it fails at any point, xterm.js continues with canvas 2D. No user-facing error.

---

## 4. Terminal Search

### New Component

File: `shell/src/components/terminal/TerminalSearchBar.tsx`

Floating bar anchored to the top-right of the focused pane. Rendered inside the pane's container div (not a portal).

**UI elements**:
- Text input (auto-focused on open)
- Match count indicator: "3 of 12"
- Case-sensitive toggle button
- Previous match button (Shift+Enter or click)
- Next match button (Enter or click)
- Close button (Escape or click)

**Decoration colors** (derived from theme):
- All matches: theme `warning` color at 40% opacity
- Active match: theme `primary` color at 80% opacity

### Integration

- `@xterm/addon-search` loaded per terminal instance
- `TerminalPane` manages search state: `{ isOpen: boolean, query: string, caseSensitive: boolean }`
- Search bar communicates with the addon via `searchAddon.findNext()`, `searchAddon.findPrevious()`, `searchAddon.clearDecorations()`

### Keyboard Shortcut

| Action | Shortcut |
|--------|----------|
| Search in active pane | `Ctrl+Shift+F` |

Added to the existing shortcut table from spec 047.

---

## 5. Theme Mapping Improvement

### Changes

New file: `shell/src/components/terminal/terminal-themes.ts`

Replaces the inline `DARK_ANSI` / `LIGHT_ANSI` constants in `TerminalPane.tsx`.

**Structure**:

```typescript
interface AnsiPalette {
  black: string; red: string; green: string; yellow: string
  blue: string; magenta: string; cyan: string; white: string
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string
}

// Curated palettes ported from slayzone
const palettes: Record<string, AnsiPalette> = {
  "one-dark": { ... },
  "one-light": { ... },
  "catppuccin-mocha": { ... },
  "dracula": { ... },
  "nord": { ... },
  "solarized-dark": { ... },
  "solarized-light": { ... },
  "github-dark": { ... },
  "github-light": { ... },
}

// Maps OS theme slug to ANSI palette name
const themeMapping: Record<string, string> = {
  "default-dark": "one-dark",
  "catppuccin": "catppuccin-mocha",
  // ... etc
}

function getAnsiPalette(themeSlug: string, backgroundHex: string): AnsiPalette
```

`getAnsiPalette` checks `themeMapping` first. If no match, falls back to luminance detection (dark bg -> `one-dark`, light bg -> `one-light`). Same behavior as today for custom/unknown themes, better colors for known presets.

`buildXtermTheme` in `TerminalPane.tsx` updated to use `getAnsiPalette` instead of the inline constants.

---

## 6. Clickable Links and File Paths

### New Module

File: `shell/src/components/terminal/web-link-provider.ts`

Implements xterm.js `ILinkProvider` interface, registered via `terminal.registerLinkProvider()`.

**URL detection**:
- Pattern: `https?://[^\s<>"')\]]+`
- Action: open in new browser tab (`window.open(url, "_blank")`)

**File path detection**:
- Patterns: `./relative/path.ts:42:10`, `../up/file.js:15`, `/absolute/path.rs`
- Must have a recognized file extension to avoid false positives (`.ts`, `.js`, `.tsx`, `.jsx`, `.py`, `.rs`, `.go`, `.md`, `.json`, `.yaml`, `.yml`, `.toml`, `.css`, `.html`, `.sh`, `.sql`, `.rb`, `.java`, `.kt`, `.swift`, `.c`, `.cpp`, `.h`)
- Optional `:line` and `:line:col` suffix
- Action: if code editor app is available, open file there. Otherwise copy path to clipboard with notification.

**Wrapped line handling**: When the terminal wraps a long line, the URL might span two terminal rows. The provider joins consecutive wrapped lines (checking xterm's `isWrapped` line attribute) before running the regex.

**Hover behavior**: underline the link text, show tooltip with full URL/path.

---

## 7. Improved Copy/Paste

### Changes to `TerminalPane.tsx`

**Keyboard shortcuts** (handled in xterm.js `attachCustomKeyEventHandler`):

| Action | Shortcut | Notes |
|--------|----------|-------|
| Copy selection | `Ctrl+Shift+C` | Only when selection exists, otherwise pass through |
| Paste | `Ctrl+Shift+V` | Read from clipboard, write to PTY |

**Implementation**:
- Copy: `navigator.clipboard.writeText(terminal.getSelection())`
- Paste: `navigator.clipboard.readText().then(text => ws.send({ type: "input", data: text }))`
- After copy: briefly flash the selection area (200ms highlight) as visual confirmation
- `Ctrl+C` without Shift always passes through to the PTY (SIGINT) — never intercepted for copy

**Context menu**: not in initial scope (adds complexity with portal rendering inside xterm). Can be added later. The keyboard shortcuts cover the primary use case.

---

## 8. Serialize Addon (Low Priority)

### Changes

- Add `@xterm/addon-serialize` to shell dependencies
- Load per terminal instance alongside other addons
- Expose `serializeAddon.serialize()` in the cache entry for future use

**No UI in this spec.** The addon is loaded and available. A future "Export terminal output" feature (context menu or command palette action) would call `serialize()` and save the result. This spec just ensures the addon is wired up.

---

## Security Architecture

### Auth Matrix

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| WS | `/ws/terminal` | Existing auth (same as current) | Session create/attach/detach |
| GET | `/api/terminal/sessions` | Existing auth | List sessions |
| DELETE | `/api/terminal/sessions/:id` | Existing auth | Destroy session |

No new auth mechanisms required. All endpoints use whatever auth the gateway already enforces.

### Input Validation

| Boundary | Validation |
|----------|-----------|
| Session ID (attach message, URL param) | UUID format regex, reject invalid |
| CWD (attach message, query param) | `resolveWithinHome` — reject path traversal |
| WebSocket messages | Zod schema validation on every incoming message |
| Ring buffer chunks | Size-capped (5MB total), old chunks evicted |
| Session metadata file | Atomic writes (tmp + rename), max 50KB |

### Error Response Policy

- WebSocket errors: `{ type: "error", message: "Session not found" }` — generic messages only
- REST errors: `{ error: "Not found" }` with appropriate HTTP status
- Server-side: detailed error logged with session ID for debugging
- Never expose: PTY exit signals, file paths, internal state

---

## Resource Management

| Resource | Limit | Eviction |
|----------|-------|----------|
| Concurrent sessions | 20 | Oldest orphaned session destroyed |
| Ring buffer per session | 5MB | Oldest chunks dropped (circular) |
| Total ring buffer memory | 100MB (20 x 5MB) worst case | Bounded by session cap |
| Frontend terminal cache | Unbounded (bounded by pane count) | Removed on pane close |
| Session metadata file | 50KB | Stale entries cleaned on startup |
| WebSocket reconnection | 3 attempts, exponential backoff | Show "Reconnected" button |

---

## Failure Modes

### Gateway restart
- All PTY processes die (OS kills child processes)
- On startup, `SessionRegistry` reads `terminal-sessions.json`, marks all entries as stale, cleans up
- Frontend detects WebSocket close, attempts reconnect, gets "session not found", creates new session
- User sees: terminal clears and starts fresh (scrollback lost). Layout (tabs, splits) preserved.

### WebSocket drop (network blip)
- Session stays alive in registry, buffer keeps filling from PTY output
- Frontend reconnects (1s → 2s → 4s backoff), replays from `lastSeq`
- User sees: brief "[Reconnecting...]" message, then output catches up seamlessly

### Ring buffer overflow
- Old chunks evicted silently
- Client detects gap via seq discontinuity on next replay
- User impact: very old scrollback lost, recent output always available

### Process exit while detached
- PTY sends exit event, `PtySession` records `state: "exited"` and `exitCode`
- On reattach, client receives buffer replay + `exit` message
- User sees: scrollback history + "[Process exited with code N]"

### All sessions at cap
- New session creation returns error: `{ type: "error", message: "Session limit reached. Close an existing session." }`
- User sees error in terminal pane with guidance

---

## Testing Strategy

### Unit Tests

**Ring Buffer** (`ring-buffer.test.ts`):
- Write and read back chunks
- Sequence numbers increment monotonically
- Eviction when exceeding max bytes
- `getSince` returns correct subset
- `getSince` with seq beyond buffer returns empty
- `clear` resets state
- Edge cases: empty buffer, single chunk, exact size boundary

**Session Registry** (`session-registry.test.ts`):
- Create session returns valid ID
- Attach to existing session
- Attach to nonexistent session returns null
- Detach decrements client count
- Destroy kills PTY and clears buffer
- Session cap enforcement (21st session triggers eviction)
- Eviction targets oldest orphaned, not attached sessions
- List returns all sessions with correct state
- Persistence: metadata written to file on create/destroy
- Startup cleanup: stale entries removed
- Process exit updates session state
- Atomic file writes (no corruption on concurrent access)

**WebSocket Protocol** (`terminal-ws.test.ts`):
- Attach with cwd creates new session
- Attach with sessionId reattaches
- Attach with fromSeq triggers replay
- Replay includes replay-start/replay-end framing
- Output messages include seq number
- Detach keeps session alive
- WebSocket close keeps session alive
- Invalid sessionId returns error
- Invalid cwd (traversal) returns error
- Message validation rejects malformed input

**Terminal Cache** (`terminal-cache.test.ts`):
- Cache and retrieve terminal instance
- Remove from cache
- Cache miss returns null

**Terminal Themes** (`terminal-themes.test.ts`):
- Known theme slug maps to correct palette
- Unknown theme falls back to luminance detection
- Dark background gets dark palette
- Light background gets light palette

**Web Link Provider** (`web-link-provider.test.ts`):
- Detect HTTP/HTTPS URLs
- Detect file paths with extensions
- Detect file:line and file:line:col patterns
- Reject paths without recognized extensions
- Handle wrapped lines (join before matching)
- Ignore partial matches inside words

### Integration Tests

**Session lifecycle** (`terminal-session.integration.test.ts`):
- Create session, send input, receive output with seq numbers
- Detach, reattach, replay from seq
- Detach, let PTY produce output, reattach, verify missed output replayed
- Close session, verify PTY killed
- Session cap: create 20 sessions, verify 21st evicts oldest orphaned
- Process exit while detached: reattach receives exit message

**Backward compatibility** (`terminal-compat.integration.test.ts`):
- Connect with `?cwd=` param, no attach message, verify session auto-created
- Input/output works as before
- Disconnect no longer kills session (behavior change from spec 047). Session stays alive in registry.

### Manual Docker Verification

1. Open terminal, run a long command (`find / -name "*.ts"`)
2. Refresh the browser — verify scrollback is preserved
3. Open two tabs, switch between them — verify instant switch, no flicker
4. Close browser tab, reopen — verify terminal layout and scrollback restored
5. Run `Ctrl+Shift+F`, search for text — verify matches highlighted
6. Click a URL in terminal output — verify it opens in new tab
7. `Ctrl+Shift+C` to copy, `Ctrl+Shift+V` to paste — verify clipboard works
8. Open 20 terminal panes, try to open 21st — verify error message

---

## Implementation Phases

### Phase 1: Session Registry + Ring Buffer (Backend)

- `RingBuffer` class with tests
- `SessionRegistry` class with tests
- Updated WebSocket handler with new protocol
- Persistence to `terminal-sessions.json`
- REST endpoints for session listing/deletion
- Backward compatibility with `?cwd=` param
- Integration tests for full session lifecycle

**Checkpoint**: PTY survives WebSocket disconnect. Can verify with: open terminal, disconnect WebSocket manually (DevTools), reconnect, see output replayed.

### Phase 2: Terminal Caching + Session Reattach (Frontend)

- `terminal-cache.ts` module
- Updated `TerminalPane` to cache/restore instances on tab switch
- Layout persistence updated with `sessionId`
- Reconnection logic with backoff
- Replay integration (attach with `fromSeq`)
- Tests for cache module and reconnection

**Checkpoint**: Open terminal, run command, refresh browser, see scrollback history. Tab switching is instant.

### Phase 3: WebGL Rendering

- Add `@xterm/addon-webgl` dependency
- Load in `TerminalPane` with fallback
- WebGL context loss handling
- Verify rendering speed improvement with heavy output

**Checkpoint**: Run `cat` on a large file, observe smooth rendering. Check DevTools — WebGL context active.

### Phase 4: Search

- Add `@xterm/addon-search` dependency
- `TerminalSearchBar` component
- `Ctrl+Shift+F` shortcut integration
- Match decoration colors from theme
- Tests for search bar state management

**Checkpoint**: `Ctrl+Shift+F` opens search, type query, matches highlighted, Enter/Shift+Enter navigates.

### Phase 5: Themes + Links + Copy/Paste + Serialize

- `terminal-themes.ts` with curated ANSI palettes
- Theme mapping for OS presets
- `web-link-provider.ts` with URL and file path detection
- Copy/paste keyboard shortcuts in `TerminalPane`
- `@xterm/addon-serialize` loaded (no UI)
- Tests for all modules

**Checkpoint**: Switch OS theme — terminal colors update. Click a URL — opens in new tab. `Ctrl+Shift+C/V` works.
