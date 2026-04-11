# 059: Shell Reliability -- WebSocket Resilience, Terminal Persistence, Canvas Stability

## Problem

Two reliability issues make the shell frustrating to use:

1. **Canvas mode freezes after idle.** Leaving the shell in a background tab for a while causes the entire canvas to stop responding, or apps inside windows to stop reacting to clicks. Only a hard refresh fixes it.

2. **Terminal sessions don't survive page refresh.** Despite backend session persistence (SessionRegistry + RingBuffer from spec 056), terminal windows either don't reopen at all or start fresh shells, losing running processes like Claude Code.

## Root Causes

### Canvas freeze after idle

The global WebSocket (`useSocket.ts`) has no heartbeat mechanism. When the browser throttles a background tab, the underlying TCP connection dies silently. The browser's `readyState` property doesn't update to reflect the dead connection -- it stays `OPEN`. The 1-second polling in `useSocket` only checks `readyState`, so it never detects the failure. When the user returns:

- `send()` silently drops messages (checks `readyState === OPEN`, which lies)
- AppViewer iframes stop receiving `data:change` events
- Bridge messages from iframes go nowhere
- The UI appears frozen because no state updates flow

Secondary issue: the `interacting` overlay in `CanvasWindow.tsx` (line 248) blocks all pointer events during drag/resize. If `onPointerUp` doesn't fire (pointer leaves browser, tab switch mid-drag), the overlay stays permanently, making the window unclickable.

### Terminal doesn't restore on refresh

**Path mismatch bug (regression).** Terminal windows get unique paths like `__terminal__:1712345678-a3bc` (`Desktop.tsx:523-524`) to support multiple instances. But layout restore does an exact match on `__terminal__` (`Desktop.tsx:574`):

```typescript
const savedTerminal = layoutMap.get("__terminal__"); // never matches unique paths
```

The saved layout contains `__terminal__:1712345678-a3bc` but the lookup expects `__terminal__`. Result: terminal windows are silently dropped from `layoutToLoad`, so they never reopen.

## Design

### 1. WebSocket Connection Health (`useSocket.ts`)

**Heartbeat with application-level ping/pong:**

- Client sends `{ type: "ping" }` every 30 seconds
- Gateway responds with `{ type: "pong" }`
- If no pong received within 5 seconds, consider connection dead
- Force-close the socket and trigger reconnect

**Visibility-change fast recovery:**

- Listen for `document.visibilitychange`
- When tab becomes visible: immediately send a ping
- If pong doesn't arrive within 3 seconds, force reconnect
- This catches the common case of returning to a backgrounded tab

**Reconnect improvements:**

- Add exponential backoff: 1s, 2s, 4s, 8s, max 16s
- Reset backoff on successful connection
- Cap at max 60 retries before stopping (show reconnect button)

**Message queue:**

- Buffer outgoing messages while disconnected (max 50 messages, 30s TTL)
- Replay queued messages in order after reconnection
- Drop messages older than 30s (stale by that point)

### 2. Connection Health Hook (`useConnectionHealth.ts`)

New hook that exposes connection state to UI:

```typescript
type ConnectionState = "connected" | "reconnecting" | "disconnected";
```

- `connected`: WebSocket open and last ping/pong succeeded
- `reconnecting`: actively trying to reconnect (show subtle indicator)
- `disconnected`: gave up reconnecting (show reconnect button)

UI indicator: small dot in the top bar or status area. Green = connected, yellow pulse = reconnecting, red = disconnected with "Reconnect" action.

### 3. Terminal Path Restoration Fix (`Desktop.tsx`)

Fix the layout restore to match terminal windows by prefix:

```typescript
// Before (broken):
const savedTerminal = layoutMap.get("__terminal__");

// After (works with unique paths):
const savedTerminals = savedWindows.filter(w => w.path.startsWith("__terminal__"));
for (const saved of savedTerminals) {
  layoutToLoad.push(saved);
}
```

This restores all terminal windows (multiple instances) with their original unique paths.

### 4. Terminal WebSocket Heartbeat (`TerminalPane.tsx`)

Apply the same heartbeat pattern to the terminal's separate WebSocket:

- Send `{ type: "ping" }` every 30 seconds on the `/ws/terminal` connection
- Gateway terminal handler responds with `{ type: "pong" }` 
- On dead connection: reconnect and re-attach with `sessionId` + `fromSeq` for seamless resume
- On `visibilitychange`: immediate health check

This means a running Claude Code session survives both page refresh (session reattachment via layout) and background tab idling (heartbeat keeps connection alive or fast reconnect resumes it).

### 5. Canvas Interaction Safety (`CanvasWindow.tsx`)

**Auto-clear stale `interacting` state:**

- Set a 5-second safety timer when `interacting` becomes true
- If no `onPointerUp` fires within 5 seconds, auto-clear the state
- Also listen for `pointercancel` event (fires when pointer capture is lost)
- Also clear on `blur` event (user switched away from browser)

**Zoom overlay safety (`CanvasTransform.tsx`):**

- On `visibilitychange` becoming visible: reset `spaceDown` ref and overlay `pointerEvents` to `none`
- On `window.blur`: same reset
- Prevents the overlay from staying stuck after Cmd+Tab

### 6. Gateway Ping/Pong Support (`server.ts`)

Add ping/pong handling to both WebSocket endpoints:

**Main `/ws` handler:**
- In `onMessage`: if `type === "ping"`, respond with `{ type: "pong" }`

**Terminal `/ws/terminal` handler:**
- In `onMessage`: if `type === "ping"`, respond with `{ type: "pong" }`
- Don't forward ping/pong to PTY sessions

## Files to Change

| File | Change |
|------|--------|
| `packages/gateway/src/server.ts` | Add ping/pong handling to both WS endpoints |
| `shell/src/hooks/useSocket.ts` | Heartbeat, visibility recovery, backoff, message queue |
| `shell/src/hooks/useConnectionHealth.ts` | New hook for connection state |
| `shell/src/components/Desktop.tsx` | Fix terminal path prefix matching in layout restore |
| `shell/src/components/terminal/TerminalPane.tsx` | Add heartbeat + visibility recovery to terminal WS |
| `shell/src/components/canvas/CanvasWindow.tsx` | Safety timer for interacting overlay + pointercancel |
| `shell/src/components/canvas/CanvasTransform.tsx` | Reset overlay on visibilitychange/blur |
| `shell/src/components/StatusBar.tsx` (or equivalent) | Show connection health indicator |

## Testing

- Unit tests for message queue (buffer, replay, TTL expiry, max size)
- Unit tests for heartbeat logic (ping sent, pong timeout, reconnect triggered)
- Unit tests for terminal path matching (single instance, multiple instances, no terminals)
- Integration test: WebSocket reconnection after simulated disconnect
- Manual test: background tab for 2+ minutes, return and verify responsiveness
- Manual test: refresh with terminal running Claude Code, verify session resumes
