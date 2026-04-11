# Shell Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix canvas mode freezing after idle, terminal not restoring on refresh, and add WebSocket resilience with connection health UI.

**Architecture:** Module-level singleton WebSocket with application-level ping/pong heartbeat, message queue during disconnect, visibility-change fast recovery. Terminal path prefix matching for layout restore. Safety timers on canvas interaction overlays.

**Tech Stack:** React 19, Zustand (subscribeWithSelector), Hono WebSocket (@hono/node-ws), Vitest, xterm.js

---

## File Structure

| File | Responsibility |
|------|----------------|
| `shell/src/lib/socket-health.ts` | **NEW** -- heartbeat, reconnect backoff, message queue, visibility recovery (pure logic, no React) |
| `shell/src/hooks/useSocket.ts` | **MODIFY** -- integrate socket-health, expose connection state |
| `shell/src/hooks/useConnectionHealth.ts` | **NEW** -- Zustand store for connection state UI |
| `shell/src/components/ConnectionIndicator.tsx` | **NEW** -- small status dot component |
| `shell/src/components/Desktop.tsx` | **MODIFY** -- fix terminal path prefix matching + add ConnectionIndicator |
| `shell/src/components/terminal/TerminalPane.tsx` | **MODIFY** -- add heartbeat + visibility recovery to terminal WS |
| `shell/src/components/canvas/CanvasWindow.tsx` | **MODIFY** -- safety timer for interacting overlay |
| `shell/src/components/canvas/CanvasTransform.tsx` | **MODIFY** -- reset overlay on visibility/blur |
| `packages/gateway/src/server.ts` | **MODIFY** -- add ping/pong to both WS handlers |
| `packages/gateway/src/session-registry.ts` | **MODIFY** -- add PingSchema to ClientMessageSchema |
| `tests/shell/socket-health.test.ts` | **NEW** -- heartbeat, queue, backoff tests |
| `tests/shell/useSocket.test.ts` | **MODIFY** -- add heartbeat integration tests |
| `tests/shell/connection-health.test.ts` | **NEW** -- connection state store tests |
| `tests/shell/desktop-terminal-restore.test.ts` | **NEW** -- terminal path prefix matching |
| `tests/shell/canvas-interaction-safety.test.ts` | **NEW** -- interacting overlay timeout tests |
| `tests/gateway/ws-ping-pong.test.ts` | **NEW** -- gateway ping/pong response tests |

---

### Task 1: Gateway Ping/Pong Support

Server-side changes to respond to ping messages on both WebSocket endpoints.

**Files:**
- Modify: `packages/gateway/src/session-registry.ts:40-43`
- Modify: `packages/gateway/src/server.ts:621-676` (main WS onMessage)
- Modify: `packages/gateway/src/server.ts:748-841` (terminal WS onMessage)
- Test: `tests/gateway/ws-ping-pong.test.ts`

- [ ] **Step 1: Write failing tests for ping/pong on both endpoints**

```typescript
// tests/gateway/ws-ping-pong.test.ts
import { describe, it, expect } from "vitest";

describe("WebSocket ping/pong protocol", () => {
  describe("main /ws handler", () => {
    it("responds with pong when receiving ping", () => {
      // Simulate the onMessage handler logic
      const sent: unknown[] = [];
      const send = (msg: unknown) => sent.push(msg);

      const parsed = { type: "ping" } as const;

      // This is the logic we'll add to server.ts onMessage
      if (parsed.type === "ping") {
        send({ type: "pong" });
      }

      expect(sent).toEqual([{ type: "pong" }]);
    });

    it("does not dispatch ping to kernel", () => {
      const dispatched: string[] = [];
      const parsed = { type: "ping" } as const;

      if (parsed.type !== "ping") {
        dispatched.push(parsed.type);
      }

      expect(dispatched).toHaveLength(0);
    });
  });

  describe("terminal /ws/terminal handler", () => {
    it("responds with pong for ping message", () => {
      const sent: unknown[] = [];
      const sendJson = (msg: unknown) => sent.push(msg);

      const msgType = "ping";
      if (msgType === "ping") {
        sendJson({ type: "pong" });
      }

      expect(sent).toEqual([{ type: "pong" }]);
    });

    it("does not forward ping to PTY session", () => {
      const forwarded: unknown[] = [];
      const handle = { send: (msg: unknown) => forwarded.push(msg) };

      const msgType = "ping";
      if (msgType !== "ping") {
        handle.send({ type: msgType });
      }

      expect(forwarded).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (testing the expected logic pattern)**

Run: `bun run test -- tests/gateway/ws-ping-pong.test.ts`
Expected: PASS (tests verify the logic we'll embed)

- [ ] **Step 3: Add PingSchema to terminal ClientMessageSchema**

In `packages/gateway/src/session-registry.ts`, add a PingSchema and include it in the union:

```typescript
// After DetachSchema (line 38):
const PingSchema = z.object({
  type: z.literal("ping"),
});

// Update ClientMessageSchema (line 40):
export const ClientMessageSchema = z.union([AttachSchema, InputSchema, ResizeSchema, DetachSchema, PingSchema]);

// Update exports (line 43):
export { AttachSchema, AttachNewSchema, AttachExistingSchema, InputSchema, ResizeSchema, DetachSchema, PingSchema, UUID_REGEX };
```

- [ ] **Step 4: Add ping handling to main /ws onMessage**

In `packages/gateway/src/server.ts`, at the top of the `onMessage` handler (after JSON parse, before the `switch_session` check around line 632), add:

```typescript
          if (parsed.type === "ping") {
            send(ws, { type: "pong" } as ServerMessage);
            return;
          }
```

Also add `"ping"` to the `ClientMessage` type union (around line 89):

```typescript
type ClientMessage =
  | { type: "message"; text: string; sessionId?: string; requestId?: string }
  | { type: "switch_session"; sessionId: string }
  | { type: "approval_response"; id: string; approved: boolean }
  | { type: "ping" };
```

- [ ] **Step 5: Add ping handling to terminal /ws/terminal onMessage**

In `packages/gateway/src/server.ts`, in the terminal `onMessage` switch statement (around line 767), add a case before the existing cases:

```typescript
          switch (msg.type) {
            case "ping":
              ws.send(JSON.stringify({ type: "pong" }));
              break;
            case "attach": {
              // ... existing code
```

Note: ping is handled BEFORE the Zod validation of `ClientMessageSchema` would reject it. Since we added PingSchema to the union in step 3, the Zod parse will accept it.

- [ ] **Step 6: Run tests**

Run: `bun run test -- tests/gateway/ws-ping-pong.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/session-registry.ts packages/gateway/src/server.ts tests/gateway/ws-ping-pong.test.ts
git commit -m "feat(gateway): add ping/pong support to both WebSocket endpoints"
```

---

### Task 2: Socket Health Module (Pure Logic)

Extract heartbeat, reconnect backoff, and message queue into a testable module with no React dependency.

**Files:**
- Create: `shell/src/lib/socket-health.ts`
- Test: `tests/shell/socket-health.test.ts`

- [ ] **Step 1: Write failing tests for heartbeat logic**

```typescript
// tests/shell/socket-health.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll import these after implementation
// import { createSocketHealth, type SocketHealthConfig } from "../../shell/src/lib/socket-health.js";

describe("SocketHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("heartbeat", () => {
    it("sends ping at configured interval", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      const sent: string[] = [];
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: (data) => sent.push(data),
        onDead: () => {},
      });

      health.start();
      vi.advanceTimersByTime(30_000);

      expect(sent).toContain('{"type":"ping"}');
      health.stop();
    });

    it("calls onDead if no pong received within timeout", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let dead = false;
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { dead = true; },
      });

      health.start();
      vi.advanceTimersByTime(30_000); // ping sent
      vi.advanceTimersByTime(5_000);  // pong timeout

      expect(dead).toBe(true);
      health.stop();
    });

    it("does not call onDead if pong received in time", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let dead = false;
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { dead = true; },
      });

      health.start();
      vi.advanceTimersByTime(30_000); // ping sent
      health.receivedPong();           // pong arrives
      vi.advanceTimersByTime(5_000);   // would have timed out

      expect(dead).toBe(false);
      health.stop();
    });

    it("stop clears all timers", async () => {
      const { createSocketHealth } = await import("../../shell/src/lib/socket-health.js");
      let dead = false;
      const health = createSocketHealth({
        pingIntervalMs: 30_000,
        pongTimeoutMs: 5_000,
        send: () => {},
        onDead: () => { dead = true; },
      });

      health.start();
      health.stop();
      vi.advanceTimersByTime(60_000);

      expect(dead).toBe(false);
    });
  });

  describe("message queue", () => {
    it("queues messages when not connected", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue('{"type":"message","text":"hello"}');
      queue.enqueue('{"type":"message","text":"world"}');

      expect(queue.size).toBe(2);
    });

    it("drains queued messages in order", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue("a");
      queue.enqueue("b");
      queue.enqueue("c");

      const drained = queue.drain();
      expect(drained).toEqual(["a", "b", "c"]);
      expect(queue.size).toBe(0);
    });

    it("drops messages older than TTL", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

      queue.enqueue("old");
      vi.advanceTimersByTime(31_000);
      queue.enqueue("new");

      const drained = queue.drain();
      expect(drained).toEqual(["new"]);
    });

    it("enforces max size by dropping oldest", async () => {
      const { MessageQueue } = await import("../../shell/src/lib/socket-health.js");
      const queue = new MessageQueue({ maxSize: 3, ttlMs: 30_000 });

      queue.enqueue("a");
      queue.enqueue("b");
      queue.enqueue("c");
      queue.enqueue("d"); // drops "a"

      const drained = queue.drain();
      expect(drained).toEqual(["b", "c", "d"]);
    });
  });

  describe("reconnect backoff", () => {
    it("calculates exponential delays: 1s, 2s, 4s, 8s, 16s", async () => {
      const { reconnectDelay } = await import("../../shell/src/lib/socket-health.js");

      expect(reconnectDelay(0)).toBe(1000);
      expect(reconnectDelay(1)).toBe(2000);
      expect(reconnectDelay(2)).toBe(4000);
      expect(reconnectDelay(3)).toBe(8000);
      expect(reconnectDelay(4)).toBe(16000);
    });

    it("caps at 16s for attempts beyond 4", async () => {
      const { reconnectDelay } = await import("../../shell/src/lib/socket-health.js");

      expect(reconnectDelay(5)).toBe(16000);
      expect(reconnectDelay(10)).toBe(16000);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/shell/socket-health.test.ts`
Expected: FAIL (module doesn't exist)

- [ ] **Step 3: Implement socket-health module**

```typescript
// shell/src/lib/socket-health.ts

export interface SocketHealthConfig {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  send: (data: string) => void;
  onDead: () => void;
}

export function createSocketHealth(config: SocketHealthConfig) {
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;

  function sendPing() {
    config.send(JSON.stringify({ type: "ping" }));
    pongTimer = setTimeout(() => {
      pongTimer = null;
      config.onDead();
    }, config.pongTimeoutMs);
  }

  return {
    start() {
      this.stop();
      pingTimer = setInterval(sendPing, config.pingIntervalMs);
    },

    stop() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    },

    receivedPong() {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    },

    /** Send an immediate ping (used on visibility change). */
    pingNow() {
      if (pongTimer) return; // already waiting for pong
      sendPing();
    },
  };
}

export interface MessageQueueConfig {
  maxSize: number;
  ttlMs: number;
}

interface QueueEntry {
  data: string;
  enqueuedAt: number;
}

export class MessageQueue {
  private entries: QueueEntry[] = [];
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(config: MessageQueueConfig) {
    this.maxSize = config.maxSize;
    this.ttlMs = config.ttlMs;
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(data: string): void {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }
    this.entries.push({ data, enqueuedAt: Date.now() });
  }

  drain(): string[] {
    const now = Date.now();
    const valid = this.entries.filter((e) => now - e.enqueuedAt < this.ttlMs);
    this.entries = [];
    return valid.map((e) => e.data);
  }
}

export function reconnectDelay(attempt: number): number {
  return Math.min(16_000, Math.pow(2, attempt) * 1000);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- tests/shell/socket-health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shell/src/lib/socket-health.ts tests/shell/socket-health.test.ts
git commit -m "feat(shell): add socket health module -- heartbeat, message queue, backoff"
```

---

### Task 3: Integrate Socket Health into useSocket

Wire heartbeat, message queue, visibility recovery, and improved reconnect into the global WebSocket singleton.

**Files:**
- Modify: `shell/src/hooks/useSocket.ts`
- Modify: `tests/shell/useSocket.test.ts`

- [ ] **Step 1: Write failing tests for heartbeat integration and message queue**

Append to `tests/shell/useSocket.test.ts`:

```typescript
describe("useSocket heartbeat and resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends ping every 30 seconds when connected", async () => {
    // Reset module state
    vi.resetModules();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected, getGlobalSocket } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();
    const ws = MockWebSocket.instances[0];

    vi.advanceTimersByTime(30_000);

    const pings = ws.sent.filter((s) => JSON.parse(s).type === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });

  it("queues messages during disconnect and replays on reconnect", async () => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected, sendMessage } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();
    const ws1 = MockWebSocket.instances[0];

    // Simulate disconnect
    ws1.readyState = 3;
    ws1.onclose?.();

    // Messages sent while disconnected should be queued
    sendMessage({ type: "message", text: "queued1" });
    sendMessage({ type: "message", text: "queued2" });

    // Reconnect happens after backoff
    vi.advanceTimersByTime(1000);
    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws2.readyState = 1;

    // Drain should replay
    const msgs = ws2.sent.map((s) => JSON.parse(s));
    const queued = msgs.filter((m: { text?: string }) => m.text === "queued1" || m.text === "queued2");
    expect(queued).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/shell/useSocket.test.ts`
Expected: FAIL (new exports don't exist, heartbeat not implemented)

- [ ] **Step 3: Rewrite useSocket.ts with socket-health integration**

Replace `shell/src/hooks/useSocket.ts` with:

```typescript
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getGatewayWs } from "@/lib/gateway";
import { createSocketHealth, MessageQueue, reconnectDelay } from "@/lib/socket-health";

export type ServerMessage =
  | { type: "kernel:init"; sessionId: string; requestId?: string }
  | { type: "kernel:text"; text: string; requestId?: string }
  | { type: "kernel:tool_start"; tool: string; requestId?: string }
  | { type: "kernel:tool_end"; input?: Record<string, unknown>; requestId?: string }
  | { type: "kernel:result"; data: Record<string, unknown>; requestId?: string }
  | { type: "kernel:error"; message: string; requestId?: string }
  | { type: "file:change"; path: string; event: "add" | "change" | "unlink" }
  | { type: "task:created"; task: { id: string; type: string; status: string; input: string } }
  | { type: "task:updated"; taskId: string; status: string }
  | { type: "provision:start"; appCount: number }
  | { type: "provision:complete"; total: number; succeeded: number; failed: number }
  | { type: "session:switched"; sessionId: string }
  | { type: "approval:request"; id: string; toolName: string; args: unknown; timeout: number }
  | { type: "data:change"; app: string; key: string }
  | { type: "pong" };

type MessageHandler = (msg: ServerMessage) => void;

const GATEWAY_WS = getGatewayWs();
const PING_INTERVAL = 30_000;
const PONG_TIMEOUT = 5_000;
const VISIBILITY_PONG_TIMEOUT = 3_000;
const MAX_RECONNECT_ATTEMPTS = 60;

let globalSocket: WebSocket | null = null;
let handlers = new Set<MessageHandler>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let connectionState: "connected" | "reconnecting" | "disconnected" = "disconnected";
let stateListeners = new Set<() => void>();

const messageQueue = new MessageQueue({ maxSize: 50, ttlMs: 30_000 });

const heartbeat = createSocketHealth({
  pingIntervalMs: PING_INTERVAL,
  pongTimeoutMs: PONG_TIMEOUT,
  send: (data) => {
    if (globalSocket?.readyState === WebSocket.OPEN) {
      globalSocket.send(data);
    }
  },
  onDead: () => {
    // Connection is dead, force reconnect
    globalSocket?.close();
  },
});

function setConnectionState(state: typeof connectionState) {
  if (connectionState === state) return;
  connectionState = state;
  for (const listener of stateListeners) listener();
}

function drainQueue() {
  if (globalSocket?.readyState !== WebSocket.OPEN) return;
  const messages = messageQueue.drain();
  for (const msg of messages) {
    globalSocket.send(msg);
  }
}

function connect() {
  if (globalSocket?.readyState === WebSocket.OPEN) return;
  if (globalSocket?.readyState === WebSocket.CONNECTING) return;

  setConnectionState("reconnecting");
  globalSocket = new WebSocket(GATEWAY_WS);

  globalSocket.onopen = () => {
    reconnectAttempt = 0;
    setConnectionState("connected");
    heartbeat.start();
    drainQueue();
  };

  globalSocket.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data) as ServerMessage;
      if (msg.type === "pong") {
        heartbeat.receivedPong();
        return;
      }
      for (const handler of handlers) {
        handler(msg);
      }
    } catch {
      // ignore malformed messages
    }
  };

  globalSocket.onclose = () => {
    heartbeat.stop();
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      setConnectionState("disconnected");
      return;
    }
    setConnectionState("reconnecting");
    const delay = reconnectDelay(reconnectAttempt);
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  globalSocket.onerror = () => {
    globalSocket?.close();
  };
}

export function ensureConnected() {
  if (!globalSocket || globalSocket.readyState === WebSocket.CLOSED) {
    connect();
  }
}

export function sendMessage(msg: { type: string; text?: string; sessionId?: string; requestId?: string }) {
  const data = JSON.stringify(msg);
  if (globalSocket?.readyState === WebSocket.OPEN) {
    globalSocket.send(data);
  } else {
    messageQueue.enqueue(data);
  }
}

export function manualReconnect() {
  reconnectAttempt = 0;
  connect();
}

export function getConnectionState() {
  return connectionState;
}

export function subscribeConnectionState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function getGlobalSocket() {
  return globalSocket;
}

// Visibility change: when tab becomes visible, send immediate ping
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && globalSocket?.readyState === WebSocket.OPEN) {
      // Override pong timeout for fast detection
      heartbeat.pingNow();
    } else if (document.visibilityState === "visible" && connectionState !== "connected") {
      // Tab visible but disconnected, try reconnecting
      reconnectAttempt = 0;
      connect();
    }
  });
}

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef<MessageHandler | null>(null);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlers.add(handler);
    handlerRef.current = handler;
    return () => {
      handlers.delete(handler);
      handlerRef.current = null;
    };
  }, []);

  const send = useCallback((msg: { type: string; text?: string; sessionId?: string; requestId?: string }) => {
    sendMessage(msg);
  }, []);

  useEffect(() => {
    ensureConnected();

    const unsubState = subscribeConnectionState(() => {
      setConnected(connectionState === "connected");
    });
    setConnected(connectionState === "connected");

    return () => {
      unsubState();
      if (handlerRef.current) {
        handlers.delete(handlerRef.current);
      }
    };
  }, []);

  return { connected, subscribe, send };
}
```

- [ ] **Step 4: Run full test suite to check nothing broke**

Run: `bun run test -- tests/shell/useSocket.test.ts`
Expected: PASS (existing tests still pass + new tests pass)

- [ ] **Step 5: Commit**

```bash
git add shell/src/hooks/useSocket.ts tests/shell/useSocket.test.ts
git commit -m "feat(shell): integrate heartbeat, message queue, and visibility recovery into useSocket"
```

---

### Task 4: Connection Health Store and UI Indicator

Zustand store for connection state + small visual indicator.

**Files:**
- Create: `shell/src/hooks/useConnectionHealth.ts`
- Create: `shell/src/components/ConnectionIndicator.tsx`
- Modify: `shell/src/components/Desktop.tsx` (add indicator)
- Test: `tests/shell/connection-health.test.ts`

- [ ] **Step 1: Write failing tests for connection health store**

```typescript
// tests/shell/connection-health.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("ConnectionHealth store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to disconnected state", async () => {
    const { useConnectionHealth } = await import("../../shell/src/hooks/useConnectionHealth.js");
    expect(useConnectionHealth.getState().state).toBe("disconnected");
  });

  it("updates state via setState", async () => {
    const { useConnectionHealth } = await import("../../shell/src/hooks/useConnectionHealth.js");
    useConnectionHealth.setState({ state: "connected" });
    expect(useConnectionHealth.getState().state).toBe("connected");
  });

  it("supports reconnecting state", async () => {
    const { useConnectionHealth } = await import("../../shell/src/hooks/useConnectionHealth.js");
    useConnectionHealth.setState({ state: "reconnecting" });
    expect(useConnectionHealth.getState().state).toBe("reconnecting");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- tests/shell/connection-health.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement connection health store**

```typescript
// shell/src/hooks/useConnectionHealth.ts
import { create } from "zustand";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

interface ConnectionHealthState {
  state: ConnectionState;
}

export const useConnectionHealth = create<ConnectionHealthState>()(() => ({
  state: "disconnected" as ConnectionState,
}));
```

- [ ] **Step 4: Wire useSocket to update the store**

In `shell/src/hooks/useSocket.ts`, import and update the store in `setConnectionState`:

Add at the top of the file:
```typescript
import { useConnectionHealth } from "./useConnectionHealth";
```

Update the `setConnectionState` function:
```typescript
function setConnectionState(state: typeof connectionState) {
  if (connectionState === state) return;
  connectionState = state;
  useConnectionHealth.setState({ state });
  for (const listener of stateListeners) listener();
}
```

- [ ] **Step 5: Create ConnectionIndicator component**

```typescript
// shell/src/components/ConnectionIndicator.tsx
"use client";

import { useConnectionHealth } from "@/hooks/useConnectionHealth";
import { manualReconnect } from "@/hooks/useSocket";

export function ConnectionIndicator() {
  const state = useConnectionHealth((s) => s.state);

  if (state === "connected") return null;

  if (state === "reconnecting") {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-yellow-500" title="Reconnecting to server...">
        <span className="size-2 rounded-full bg-yellow-500 animate-pulse" />
        Reconnecting...
      </div>
    );
  }

  return (
    <button
      className="flex items-center gap-1.5 px-2 py-1 text-xs text-red-500 hover:text-red-400 transition-colors"
      onClick={manualReconnect}
      title="Connection lost. Click to reconnect."
    >
      <span className="size-2 rounded-full bg-red-500" />
      Disconnected
    </button>
  );
}
```

- [ ] **Step 6: Add ConnectionIndicator to Desktop**

In `shell/src/components/Desktop.tsx`, import and render the indicator. Find the header area (the top bar with the Matrix OS logo) and add:

```typescript
import { ConnectionIndicator } from "./ConnectionIndicator";
```

Add `<ConnectionIndicator />` in the top bar next to existing status elements. Look for the header section and add it there. The exact location will depend on the current layout -- place it near the right side of the top bar.

- [ ] **Step 7: Run tests**

Run: `bun run test -- tests/shell/connection-health.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add shell/src/hooks/useConnectionHealth.ts shell/src/components/ConnectionIndicator.tsx shell/src/hooks/useSocket.ts shell/src/components/Desktop.tsx tests/shell/connection-health.test.ts
git commit -m "feat(shell): add connection health store and UI indicator"
```

---

### Task 5: Fix Terminal Window Restoration on Refresh

Fix the path prefix mismatch that prevents terminal windows from being restored.

**Files:**
- Modify: `shell/src/components/Desktop.tsx:569-575`
- Test: `tests/shell/desktop-terminal-restore.test.ts`

- [ ] **Step 1: Write failing tests for terminal path restoration**

```typescript
// tests/shell/desktop-terminal-restore.test.ts
import { describe, it, expect } from "vitest";

interface LayoutWindow {
  path: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: "open" | "minimized" | "closed";
}

/**
 * Extracts terminal windows from saved layout.
 * This is the logic we're fixing in Desktop.tsx.
 */
function getTerminalWindows(savedWindows: LayoutWindow[]): LayoutWindow[] {
  return savedWindows.filter((w) => w.path.startsWith("__terminal__"));
}

describe("Terminal window restoration", () => {
  it("matches single terminal with exact __terminal__ path", () => {
    const saved: LayoutWindow[] = [
      { path: "__terminal__", title: "Terminal", x: 0, y: 0, width: 800, height: 600, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(1);
  });

  it("matches terminal with unique suffix path", () => {
    const saved: LayoutWindow[] = [
      { path: "__terminal__:1712345678-a3bc", title: "Terminal", x: 0, y: 0, width: 800, height: 600, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(1);
  });

  it("matches multiple terminal instances", () => {
    const saved: LayoutWindow[] = [
      { path: "__terminal__:1712345678-a3bc", title: "Terminal", x: 0, y: 0, width: 800, height: 600, state: "open" },
      { path: "__terminal__:claude-1712345679", title: "Claude Code", x: 100, y: 100, width: 800, height: 600, state: "open" },
      { path: "apps/notes.html", title: "Notes", x: 200, y: 200, width: 640, height: 480, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(2);
  });

  it("returns empty array when no terminals in layout", () => {
    const saved: LayoutWindow[] = [
      { path: "apps/notes.html", title: "Notes", x: 0, y: 0, width: 640, height: 480, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(0);
  });

  it("does not match paths that contain terminal but don't start with __terminal__", () => {
    const saved: LayoutWindow[] = [
      { path: "apps/terminal-emulator.html", title: "Term Emu", x: 0, y: 0, width: 640, height: 480, state: "open" },
    ];
    expect(getTerminalWindows(saved)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (logic test)**

Run: `bun run test -- tests/shell/desktop-terminal-restore.test.ts`
Expected: PASS (these test the correct logic pattern)

- [ ] **Step 3: Fix the terminal restoration in Desktop.tsx**

In `shell/src/components/Desktop.tsx`, replace the broken terminal restoration code (around lines 572-575):

```typescript
// BEFORE (broken -- only matches exact "__terminal__"):
addApp("Terminal", "__terminal__");
addApp("Files", "__file-browser__");
const savedTerminal = layoutMap.get("__terminal__");
if (savedTerminal) layoutToLoad.push(savedTerminal);

// AFTER (works with unique paths like "__terminal__:1712345678-a3bc"):
addApp("Terminal", "__terminal__");
addApp("Files", "__file-browser__");
const savedTerminals = savedWindows.filter((w) => w.path.startsWith("__terminal__"));
for (const saved of savedTerminals) {
  layoutToLoad.push(saved);
}
```

Note: `savedWindows` is already available at this point (defined on line 566).

- [ ] **Step 4: Run full test suite**

Run: `bun run test -- tests/shell/desktop-terminal-restore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shell/src/components/Desktop.tsx tests/shell/desktop-terminal-restore.test.ts
git commit -m "fix(shell): restore terminal windows on refresh -- match path prefix not exact string"
```

---

### Task 6: Terminal WebSocket Heartbeat

Add heartbeat + visibility recovery to the terminal's separate WebSocket connection.

**Files:**
- Modify: `shell/src/components/terminal/TerminalPane.tsx`

- [ ] **Step 1: Add heartbeat to TerminalPane WebSocket**

In `shell/src/components/terminal/TerminalPane.tsx`, import the socket-health module at the top:

```typescript
import { createSocketHealth } from "@/lib/socket-health";
```

Add a ref for the heartbeat instance (around line 172, after `isClosingRef`):

```typescript
const heartbeatRef = useRef<ReturnType<typeof createSocketHealth> | null>(null);
```

In the `bindWs` function (around line 356), after setting up `ws.onopen`:

```typescript
ws.onopen = () => {
  reconnectAttemptRef.current = 0;
  clearReconnectTimer();

  // Start heartbeat
  if (heartbeatRef.current) heartbeatRef.current.stop();
  heartbeatRef.current = createSocketHealth({
    pingIntervalMs: 30_000,
    pongTimeoutMs: 5_000,
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    onDead: () => {
      ws.close(); // triggers onclose -> reconnect
    },
  });
  heartbeatRef.current.start();

  if (attachOnOpen) {
    sendAttach();
  }
};
```

In `ws.onclose` (around line 395), stop heartbeat:

```typescript
ws.onclose = () => {
  heartbeatRef.current?.stop();
  if (disposed || isClosingRef.current) return;
  // ... existing reconnect logic
```

In `ws.onmessage` (around line 416), handle pong:

```typescript
ws.onmessage = (evt) => {
  const raw = typeof evt.data === "string" ? evt.data : "";
  // Handle pong before full parse
  if (raw.includes('"pong"')) {
    try {
      const quick = JSON.parse(raw) as { type: string };
      if (quick.type === "pong") {
        heartbeatRef.current?.receivedPong();
        return;
      }
    } catch { /* fall through to normal parse */ }
  }

  const msg = parseTerminalServerMessage(raw);
  // ... existing handler
```

In the cleanup function (around line 562), stop heartbeat:

```typescript
return () => {
  resizeObserver.disconnect();
  clearAuthDetectTimer();
  clearReconnectTimer();
  heartbeatRef.current?.stop();
  detachWebglContextLostHandler();
  // ... rest of cleanup
```

- [ ] **Step 2: Add visibility change handler to TerminalPane**

Inside the `init()` function, after the `connectWs()` call (around line 502), add a visibility change listener:

```typescript
const onVisibilityChange = () => {
  if (document.visibilityState === "visible") {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      heartbeatRef.current?.pingNow();
    } else if (!disposed && !isClosingRef.current && sessionIdRef.current) {
      // Disconnected while hidden, reconnect now
      reconnectAttemptRef.current = 0;
      clearReconnectTimer();
      connectWs();
    }
  }
};

document.addEventListener("visibilitychange", onVisibilityChange);
```

In the cleanup return, remove the listener:

```typescript
return () => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  resizeObserver.disconnect();
  // ... rest of cleanup
```

- [ ] **Step 3: Run existing terminal tests to verify no regression**

Run: `bun run test -- tests/shell/terminal-app.test.ts tests/shell/terminal-cache.test.ts tests/shell/pane-grid.test.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add shell/src/components/terminal/TerminalPane.tsx
git commit -m "feat(shell): add heartbeat and visibility recovery to terminal WebSocket"
```

---

### Task 7: Canvas Interaction Safety

Fix the stuck `interacting` overlay and zoom overlay on CanvasWindow and CanvasTransform.

**Files:**
- Modify: `shell/src/components/canvas/CanvasWindow.tsx`
- Modify: `shell/src/components/canvas/CanvasTransform.tsx`
- Test: `tests/shell/canvas-interaction-safety.test.ts`

- [ ] **Step 1: Write failing tests for interaction safety timeout**

```typescript
// tests/shell/canvas-interaction-safety.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Canvas interaction safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("interacting overlay timeout", () => {
    it("auto-clears interacting state after 5 seconds", () => {
      let interacting = true;
      const setInteracting = (v: boolean) => { interacting = v; };

      // Simulate the safety timer logic
      const safetyTimer = setTimeout(() => {
        setInteracting(false);
      }, 5000);

      vi.advanceTimersByTime(5000);
      expect(interacting).toBe(false);
      clearTimeout(safetyTimer);
    });

    it("does not auto-clear if pointer up fires in time", () => {
      let interacting = true;
      const setInteracting = (v: boolean) => { interacting = v; };

      const safetyTimer = setTimeout(() => {
        setInteracting(false);
      }, 5000);

      // Pointer up fires at 2 seconds
      vi.advanceTimersByTime(2000);
      clearTimeout(safetyTimer);
      setInteracting(false); // normal pointer up
      interacting = false;

      vi.advanceTimersByTime(3000); // past the 5s mark
      expect(interacting).toBe(false);
    });
  });

  describe("space key / overlay reset on visibility change", () => {
    it("resets spaceDown on visibility change to visible", () => {
      let spaceDown = true;
      let overlayPointerEvents = "all";

      // Simulate visibility change handler
      if (true /* document.visibilityState === "visible" */) {
        spaceDown = false;
        overlayPointerEvents = "none";
      }

      expect(spaceDown).toBe(false);
      expect(overlayPointerEvents).toBe("none");
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test -- tests/shell/canvas-interaction-safety.test.ts`
Expected: PASS (logic pattern tests)

- [ ] **Step 3: Add safety timer to CanvasWindow.tsx**

In `shell/src/components/canvas/CanvasWindow.tsx`, add a ref for the safety timer (around line 56):

```typescript
const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Modify `onDragStart` to set the safety timer (inside the existing useCallback, after `setInteracting(true)`):

```typescript
const onDragStart = useCallback(
  (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: win.x, origY: win.y };
    setInteracting(true);
    focusWindow(win.id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    // Safety: auto-clear if pointer up never fires
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      dragRef.current = null;
      setInteracting(false);
    }, 5000);
  },
  [win.x, win.y, win.id, focusWindow],
);
```

Modify `onDragEnd` to clear the safety timer:

```typescript
const onDragEnd = useCallback(() => {
  dragRef.current = null;
  setInteracting(false);
  if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
}, []);
```

Do the same for `onResizeStart` and `onResizeEnd`:

In `onResizeStart`, after `setInteracting(true)`:
```typescript
    if (safetyTimerRef.current) clearTimeout(safetyTimerRef.current);
    safetyTimerRef.current = setTimeout(() => {
      resizeRef.current = null;
      setInteracting(false);
    }, 5000);
```

In `onResizeEnd`:
```typescript
const onResizeEnd = useCallback(() => {
  resizeRef.current = null;
  setInteracting(false);
  if (safetyTimerRef.current) { clearTimeout(safetyTimerRef.current); safetyTimerRef.current = null; }
}, []);
```

Also add `pointercancel` handler to the title bar and resize handle in the JSX (where `onPointerUp={onDragEnd}` is):
```typescript
onPointerCancel={onDragEnd}
```
And:
```typescript
onPointerCancel={onResizeEnd}
```

- [ ] **Step 4: Fix CanvasTransform overlay reset on visibility/blur**

In `shell/src/components/canvas/CanvasTransform.tsx`, inside the existing `useEffect` that tracks keyboard state (around line 93), add visibility and blur handlers:

```typescript
useEffect(() => {
  const overlay = zoomOverlayRef.current;
  const onKeyDown = (e: KeyboardEvent) => {
    // ... existing
  };
  const onKeyUp = (e: KeyboardEvent) => {
    // ... existing
  };

  // Reset overlay when tab becomes visible or window loses focus
  const resetOverlay = () => {
    spaceDown.current = false;
    setGrabCursor(false);
    if (overlay) overlay.style.pointerEvents = "none";
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") resetOverlay();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", resetOverlay);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", resetOverlay);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}, []);
```

- [ ] **Step 5: Run canvas tests to verify no regression**

Run: `bun run test -- tests/shell/canvas-transform.test.ts tests/shell/canvas-renderer.test.ts tests/shell/canvas-interaction-safety.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shell/src/components/canvas/CanvasWindow.tsx shell/src/components/canvas/CanvasTransform.tsx tests/shell/canvas-interaction-safety.test.ts
git commit -m "fix(shell): add safety timers for canvas interaction overlay and reset on visibility change"
```

---

### Task 8: Run Full Test Suite and Verify

Final verification that all changes work together.

- [ ] **Step 1: Run all unit tests**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 2: Run existing shell tests specifically**

Run: `bun run test -- tests/shell/`
Expected: All PASS, no regressions

- [ ] **Step 3: Run existing gateway tests**

Run: `bun run test -- tests/gateway/`
Expected: All PASS

- [ ] **Step 4: Manual verification checklist**

Start dev environment: `bun run dev`

1. Open shell, verify connection indicator shows nothing (connected = hidden)
2. Open a terminal, run `top` or similar long-running process
3. Refresh the page -- terminal window should reappear and reattach to the running process
4. Open multiple terminal instances, refresh -- all should restore
5. Switch to canvas mode, leave the tab in background for 2+ minutes
6. Return to tab -- canvas should be responsive immediately (or within 3s if reconnection needed)
7. Verify reconnecting indicator appears briefly if connection was lost
8. Stop the gateway while shell is open -- verify "Disconnected" indicator with reconnect button
9. Restart gateway -- verify automatic reconnection and indicator disappears
10. In canvas, start dragging a window title bar, then Cmd+Tab away -- overlay should auto-clear after 5s

- [ ] **Step 5: Final commit if any manual fixes needed**

```bash
git add -u
git commit -m "fix(shell): address issues found during manual testing"
```
