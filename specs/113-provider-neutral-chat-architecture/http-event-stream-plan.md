# Canonical Chat HTTP Event Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canonical Chat WebSocket invalidation path with a bearer-authenticated HTTP SSE stream while preserving outbox replay and bounded polling fallback.

**Architecture:** The owner-scoped outbox hub remains transport-neutral and writes validated canonical frames into a bounded sink. A Hono GET route adapts that sink to SSE with heartbeats, cursor IDs, cancellation cleanup, and normal request-principal auth. Desktop opens the stream through its typed API client, incrementally parses bounded SSE records, and keeps the existing connection-state and fallback-polling behavior.

**Tech Stack:** Node.js 24, TypeScript strict, Hono, Web `ReadableStream`, React 19, Zod 4, Vitest, pnpm/bun through Flox.

**Spec:** `specs/113-provider-neutral-chat-architecture/http-event-stream-design.md`

## Global Constraints

- PostgreSQL snapshots remain the canonical Chat source of truth; SSE carries invalidation metadata only.
- `GET /api/chats/events` uses the existing verified bearer principal and never accepts a user-supplied owner ID.
- `Last-Event-ID` is primary; bounded `cursor` query input is the compatibility fallback.
- Application frames and incomplete Desktop parser state are capped at 16 KiB.
- Preserve existing global/per-owner subscriber caps, replay limit, attach buffer, stale eviction, failed-sender isolation, and shutdown drain.
- The SSE response queue is bounded; slow consumers are evicted.
- Heartbeat interval is 15 seconds; Desktop inactivity timeout is 45 seconds; connection rotation is 5 minutes.
- Desktop reconnect backoff remains exponential from 250 ms through 10 seconds.
- Active-Run snapshot fallback remains 2-10 seconds and runs only while the stream is not server-attached.
- Do not add MCP JSON-RPC, MCP initialization, MCP session IDs, provider payloads, transcript content, or changes to non-Chat WebSockets.
- Use TDD for every behavior change and keep the working tree scoped to this plan.

---

## File Structure

- `packages/contracts/src/canonical-chat-api.ts`: server-to-client canonical frame schema; remove WebSocket-only client frames and `pong` across Tasks 1-2.
- `packages/gateway/src/chat/event-stream.ts`: transport-neutral owner-scoped subscription/replay hub using a bounded frame sink.
- `packages/gateway/src/chat/event-http-route.ts`: Hono request validation, bounded SSE encoding/queueing, heartbeat, and cancellation adapter.
- `packages/gateway/src/chat/event-websocket-route.ts`: delete after the HTTP route is wired.
- `packages/gateway/src/chat/routes.ts`: keep lifecycle exports; remove WebSocket route registration seam.
- `packages/gateway/src/auth.ts`: remove only `/ws/chats/events` from the WebSocket query-token allowlist.
- `packages/gateway/src/server.ts`: register the HTTP event route instead of the Chat WebSocket route.
- `desktop/src/renderer/src/lib/api.ts`: expose a typed long-lived authenticated streaming GET that preserves runtime routing and unauthorized handling.
- `desktop/src/renderer/src/lib/canonical-chat-sse.ts`: bounded incremental SSE parser with no React or transport state.
- `desktop/src/renderer/src/lib/canonical-chat-client.ts`: replace WebSocket construction/token acquisition with streaming fetch consumption.
- `desktop/src/renderer/src/features/work/WorkTab.tsx`: inject `ApiClient.openStream`; remove Chat WebSocket token and constructor wiring.
- `tests/gateway/chat-event-stream.test.ts`: transport-neutral hub tests and HTTP route/auth/SSE regression coverage.
- `tests/desktop/canonical-chat-event-source.test.ts`: streaming response, parsing, reconnect, health, cursor, and disposal coverage.
- `tests/desktop/api-client.test.ts`: authenticated stream URL/runtime/status/timeout behavior.
- Existing route-controller and Work rail tests continue to prove invalidation-primary refresh and bounded fallback polling.

---

### Task 1: Remove WebSocket-only contract frames

**Files:**
- Modify: `packages/contracts/src/canonical-chat-api.ts`
- Test: `tests/contracts/canonical-chat-api.test.ts`

**Interfaces:**
- Produces: `CanonicalChatStreamServerFrameSchema` containing `chat.stream.attached`, `chat.event`, `chat.replay.end`, `chat.replay.gap`, `chat.stream.error`, and `chat.stream.closing` only.
- Removes: the server `pong` variant. The still-consumed client-frame schema is removed atomically with the Gateway inbound-message path in Task 2.

- [ ] **Step 1: Write a failing contract test**

Add assertions that canonical event/control frames parse while `{ type: "pong" }` does not:

```ts
expect(CanonicalChatStreamServerFrameSchema.safeParse({ type: "pong" }).success).toBe(false);
expect(CanonicalChatStreamServerFrameSchema.parse({
  type: "chat.event",
  event: { cursor: 4, chatId: "chat_4", revision: 4, eventType: "run.message", createdAt: ISO },
})).toMatchObject({ type: "chat.event" });
```

- [ ] **Step 2: Run the contract test and verify red**

Run: `flox activate -- bunx vitest run tests/contracts/canonical-chat-api.test.ts`

Expected: FAIL because `pong` is still accepted.

- [ ] **Step 3: Remove WebSocket-only schemas**

Delete the `pong` member from `CanonicalChatStreamServerFrameSchema`. Do not change safe event metadata or cursor bounds yet.

- [ ] **Step 4: Run the contract test and typecheck affected packages**

Run:

```bash
flox activate -- bunx vitest run tests/contracts/canonical-chat-api.test.ts
flox activate -- pnpm --filter '@matrix-os/contracts' exec tsc --noEmit
```

Expected: PASS. The commit stays independently type-correct because the client-frame contract remains until Task 2.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/canonical-chat-api.ts tests/contracts/canonical-chat-api.test.ts
git commit -m "refactor(chat): remove websocket-only stream frames"
```

---

### Task 2: Make the outbox event hub transport-neutral

**Files:**
- Modify: `packages/contracts/src/canonical-chat-api.ts`
- Modify: `packages/gateway/src/chat/event-stream.ts`
- Modify: `tests/contracts/canonical-chat-api.test.ts`
- Modify: `tests/gateway/chat-event-stream.test.ts`

**Interfaces:**
- Consumes: `CanonicalChatStreamServerFrameSchema` from Task 1.
- Removes: `CanonicalChatStreamClientFrameSchema`, its inferred type, and the matching inbound-message handling in one commit.
- Produces:

```ts
export interface CanonicalChatEventStreamSink {
  send(frame: CanonicalChatStreamServerFrame): boolean;
  close(): void;
}

export interface CanonicalChatEventStreamSession {
  touch(): void;
  onClose(): void;
}

open(input: {
  sink: CanonicalChatEventStreamSink;
  principal: RequestPrincipal;
  cursor?: number;
}): Promise<CanonicalChatEventStreamSession>;
```

- [ ] **Step 1: Convert the hub harness test to a frame sink**

Replace the JSON-string socket fake with a sink that stores already-validated frames:

```ts
function sink(onClose?: () => void) {
  return {
    sent: [] as CanonicalChatStreamServerFrame[],
    closed: false,
    failSend: false,
    send(frame: CanonicalChatStreamServerFrame) {
      if (this.failSend) return false;
      this.sent.push(frame);
      return true;
    },
    close() { this.closed = true; onClose?.(); },
  };
}
```

Update tests to call `stream.open({ sink, principal, cursor })`. Replace ping/detach coverage with `session.touch()` lease renewal and `session.onClose()` cleanup assertions.

- [ ] **Step 2: Run the Gateway test and verify red**

Run: `flox activate -- bunx vitest run tests/gateway/chat-event-stream.test.ts`

Expected: FAIL because `open` still requires `ws` and sessions expose `onMessage`.

- [ ] **Step 3: Refactor the hub around the sink interface**

In `event-stream.ts`:

- rename subscriber `ws` to `sink`;
- validate every outgoing frame before `sink.send`;
- treat `false` or a thrown send as a failed sender and evict it;
- remove inbound byte parsing, ping/detach handling, and WebSocket helper exports;
- implement `touch()` by updating `lastTouched` only while the subscriber exists;
- keep subscribe-before-replay, cursor dedupe, bounded attach buffering, owner isolation, caps, stale eviction, and shutdown ordering unchanged.

The safe-send core should have this shape:

```ts
function sendFrame(subscriber: Subscriber, frame: unknown): boolean {
  try {
    return subscriber.sink.send(CanonicalChatStreamServerFrameSchema.parse(frame));
  } catch (error: unknown) {
    console.warn("[chat/event-stream] Send failed:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}
```

In `canonical-chat-api.ts`, now remove `CanonicalChatStreamClientFrameSchema` and its inferred type export. Update the contract test so no WebSocket client-frame contract remains.

- [ ] **Step 4: Run hub tests**

Run:

```bash
flox activate -- bunx vitest run tests/contracts/canonical-chat-api.test.ts tests/gateway/chat-event-stream.test.ts
flox activate -- pnpm --filter '@matrix-os/contracts' exec tsc --noEmit
flox activate -- pnpm --filter '@matrix-os/gateway' exec tsc --noEmit
```

Expected: hub ordering, replay, bounds, owner isolation, touch, cleanup, and shutdown tests PASS. Route/auth tests remain red until Task 3.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/canonical-chat-api.ts packages/gateway/src/chat/event-stream.ts tests/contracts/canonical-chat-api.test.ts tests/gateway/chat-event-stream.test.ts
git commit -m "refactor(chat): decouple event hub from websocket"
```

---

### Task 3: Add the authenticated bounded HTTP SSE route

**Files:**
- Create: `packages/gateway/src/chat/event-http-route.ts`
- Delete: `packages/gateway/src/chat/event-websocket-route.ts`
- Modify: `packages/gateway/src/chat/routes.ts`
- Modify: `packages/gateway/src/auth.ts`
- Modify: `packages/gateway/src/server.ts`
- Modify: `tests/gateway/chat-event-stream.test.ts`
- Test: `tests/gateway/auth.test.ts`

**Interfaces:**
- Consumes: transport-neutral `stream.open({ sink, principal, cursor })` from Task 2.
- Produces:

```ts
export function registerCanonicalChatEventHttpRoute(options: {
  app: Hono;
  stream: Pick<ReturnType<typeof createCanonicalChatEventStream>, "open">;
  getPrincipal(context: Context): RequestPrincipal;
  heartbeatIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): void;
```

- [ ] **Step 1: Write failing HTTP route tests**

Cover:

```ts
expect(await app.request("/api/chats/events", { headers: { accept: "application/json" } }))
  .toMatchObject({ status: 406 });

const response = await app.request("/api/chats/events?cursor=7", {
  headers: { accept: "text/event-stream", "last-event-id": "12" },
});
expect(response.status).toBe(200);
expect(response.headers.get("content-type")).toContain("text/event-stream");
expect(open).toHaveBeenCalledWith(expect.objectContaining({ principal: principalA, cursor: 12 }));
```

Also assert invalid cursors return `400`, cancellation calls `session.onClose`, heartbeats call `session.touch`, event frames include `id: <cursor>`, slow-consumer overflow closes the sink, and auth middleware no longer accepts a query token for `/ws/chats/events`.

For every successful streaming response test, acquire the response reader, assert only the bounded prefix needed by the test, and call `await reader.cancel()` in `finally` so the intentionally open response cannot leave Vitest waiting.

- [ ] **Step 2: Run route/auth tests and verify red**

Run:

```bash
flox activate -- bunx vitest run tests/gateway/chat-event-stream.test.ts tests/gateway/auth.test.ts
```

Expected: FAIL because the HTTP route does not exist and the old query-token exception remains.

- [ ] **Step 3: Implement bounded SSE encoding**

Create `event-http-route.ts` with:

- strict `Accept` and cursor/header validation;
- `ReadableStream<Uint8Array>` using a `CountQueuingStrategy` with a hard queue cap;
- `TextEncoder` output in `id: ...\ndata: ...\n\n` form;
- 15-second `: heartbeat\n\n` comments;
- `cancel()` cleanup that clears the timer and calls `session.onClose()`;
- safe single-close behavior when attach, encoding, enqueue, or heartbeat fails;
- `cache-control: no-store`, `content-type: text/event-stream`, and `x-accel-buffering: no` headers.

Before `enqueue`, reject any encoded application frame over 16 KiB. Check `controller.desiredSize`; when it is non-positive, return `false` from the sink so the hub evicts the slow subscriber.

- [ ] **Step 4: Replace route wiring**

- delete `event-websocket-route.ts`;
- remove `registerCanonicalChatEventRoute` from `routes.ts` while retaining `closeCanonicalChatEventLifecycle`;
- replace the import/call in `server.ts` with `registerCanonicalChatEventHttpRoute` and do not pass `upgradeWebSocket`;
- remove only `/ws/chats/events` from `WS_QUERY_TOKEN_PATHS` in `auth.ts`.

- [ ] **Step 5: Run Gateway tests and typecheck**

Run:

```bash
flox activate -- bunx vitest run tests/gateway/chat-event-stream.test.ts tests/gateway/auth.test.ts
flox activate -- pnpm --filter '@matrix-os/gateway' exec tsc --noEmit
```

Expected: PASS with no Chat WebSocket route or query-token path remaining.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/chat/event-http-route.ts packages/gateway/src/chat/event-stream.ts packages/gateway/src/chat/routes.ts packages/gateway/src/auth.ts packages/gateway/src/server.ts tests/gateway/chat-event-stream.test.ts tests/gateway/auth.test.ts
git add -u packages/gateway/src/chat/event-websocket-route.ts
git commit -m "feat(chat): stream invalidations over authenticated http"
```

---

### Task 4: Replace the Desktop WebSocket with streaming fetch

**Files:**
- Create: `desktop/src/renderer/src/lib/canonical-chat-sse.ts`
- Modify: `desktop/src/renderer/src/lib/api.ts`
- Modify: `desktop/src/renderer/src/lib/canonical-chat-client.ts`
- Modify: `desktop/src/renderer/src/features/work/WorkTab.tsx`
- Modify: `tests/desktop/api-client.test.ts`
- Rewrite: `tests/desktop/canonical-chat-event-source.test.ts`
- Verify: `tests/desktop/canonical-chat-route-controller.test.tsx`
- Verify: `tests/desktop/work-rail.test.tsx`
- Verify: `tests/desktop/work-tab.test.tsx`

**Interfaces:**
- Produces from `api.ts`:

```ts
export interface StreamRequestOptions extends RequestTimeoutOptions {
  accept: "text/event-stream";
  headers?: Record<string, string>;
}

openStream(path: string, options: StreamRequestOptions): Promise<Response>;
```

- Produces from `canonical-chat-sse.ts`:

```ts
export function createCanonicalChatSseParser(options: {
  maxEventChars?: number;
  onData(data: string, id?: string): void;
  onActivity(): void;
}): { push(chunk: Uint8Array): void; finish(): void };
```

- `createCanonicalChatEventSource` consumes:

```ts
openStream(input: { cursor?: number; signal: AbortSignal }): Promise<Response>;
```

- [ ] **Step 1: Write failing parser tests**

In `canonical-chat-event-source.test.ts`, exercise the pure parser with:

- one event split across UTF-8 and line boundaries;
- multiple events in one chunk;
- comment heartbeat and blank-line dispatch;
- `id` capture;
- CRLF and LF;
- data/event buffer overflow at 16 KiB;
- invalid JSON deferred to canonical frame validation.

Example:

```ts
parser.push(bytes('id: 8\ndata: {"type":"chat.'));
parser.push(bytes('stream.attached"}\n\n'));
expect(frames).toEqual([{ id: "8", data: '{"type":"chat.stream.attached"}' }]);
```

- [ ] **Step 2: Run the Desktop event-source test and verify red**

Run: `flox activate -- bunx vitest run tests/desktop/canonical-chat-event-source.test.ts`

Expected: FAIL because the parser module and streaming fetch seam do not exist.

- [ ] **Step 3: Implement the bounded pure SSE parser**

Implement incremental `TextDecoder` parsing without a new dependency. Ignore comment lines, join multiple `data:` lines with `\n`, keep the latest `id:`, dispatch on a blank line, and throw `ChatEventFrameTooLarge` before buffered characters exceed 16 KiB. `finish()` flushes the decoder but does not dispatch an incomplete record.

- [ ] **Step 4: Add the typed API streaming request**

Write failing `api-client.test.ts` assertions that `openStream`:

- uses `buildGatewayUrl`, including non-primary `runtime` routing;
- sends `GET` plus `Accept: text/event-stream` and optional `Last-Event-ID`;
- uses the supplied lifecycle signal plus a five-minute timeout;
- invokes `onUnauthorized` on `401`;
- returns the unconsumed `Response` body.

Then implement `ApiClient.openStream` through the existing private `send` path. Do not call `.json()`, `.text()`, or `.arrayBuffer()`.

- [ ] **Step 5: Rewrite the event source harness around `Response.body`**

Replace `FakeSocket` with controllable streaming responses:

```ts
function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(next) { controller = next; } });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    emit(raw: string) { controller.enqueue(new TextEncoder().encode(raw)); },
    close() { controller.close(); },
  };
}
```

Assert server attachment health, event metadata, replay cursor, reconnect with cursor, retryable error, inactivity abort, five-minute rotation, invalid status/content type, malformed/oversized frames, bounded consumers, and disposal.

- [ ] **Step 6: Implement streaming fetch consumption**

In `canonical-chat-client.ts`:

- remove `DesktopCanonicalChatWebSocket`, token schema, URL protocol rewriting, socket callbacks, and socket close logic;
- open the injected HTTP stream with a lifecycle `AbortController`;
- validate `response.ok`, `text/event-stream`, and `response.body`;
- read chunks through `getReader()` and the pure SSE parser;
- validate each data event with `CanonicalChatStreamServerFrameSchema`;
- preserve dedupe, safe event metadata, replay/full-refresh behavior, server-attached health, bounded consumer registries, and reconnect backoff;
- reset a 45-second inactivity timer on every parser activity callback;
- rotate each connection after five minutes using an explicit timeout signal;
- abort/release the reader on reconnect and disposal.

- [ ] **Step 7: Rewire WorkTab**

Replace token and WebSocket injection with:

```ts
openStream: ({ cursor, signal }) => api.openStream("/api/chats/events", {
  accept: "text/event-stream",
  signal,
  timeoutMs: 5 * 60 * 1000,
  ...(cursor === undefined ? {} : { headers: { "last-event-id": String(cursor) } }),
}),
```

Keep event-source sharing/disposal and runtime-scope recreation unchanged.

- [ ] **Step 8: Run focused Desktop tests and typecheck**

Run:

```bash
flox activate -- bunx vitest run tests/desktop/api-client.test.ts tests/desktop/canonical-chat-event-source.test.ts tests/desktop/canonical-chat-route-controller.test.tsx tests/desktop/work-rail.test.tsx tests/desktop/work-tab.test.tsx
flox activate -- pnpm --filter desktop run typecheck
```

Expected: PASS. No Desktop code requests `/api/auth/ws-token` for canonical Chat or constructs a Chat WebSocket.

- [ ] **Step 9: Commit**

```bash
git add desktop/src/renderer/src/lib/api.ts desktop/src/renderer/src/lib/canonical-chat-sse.ts desktop/src/renderer/src/lib/canonical-chat-client.ts desktop/src/renderer/src/features/work/WorkTab.tsx tests/desktop/api-client.test.ts tests/desktop/canonical-chat-event-source.test.ts
git commit -m "refactor(chat): consume invalidations over http streaming"
```

---

### Task 5: Remove stale seams and complete exact-head verification

**Files:**
- Modify as required by exact compiler/search output only.
- Modify: `specs/113-provider-neutral-chat-architecture/http-event-stream-design.md` only if implementation revealed an approved contract correction.
- Modify: PR #1479 body.

**Interfaces:**
- Consumes: all Tasks 1-4.
- Produces: one clean branch with no canonical Chat WebSocket seam, current-head review evidence, and restored `ready-for-ci` only after Greptile 5/5.

- [ ] **Step 1: Prove stale Chat WebSocket seams are gone**

Run:

```bash
rg -n 'ws/chats/events|fetchWebSocketToken|DesktopCanonicalChatWebSocket|CanonicalChatStreamClientFrameSchema|event-websocket-route' packages desktop tests specs
```

Expected: no implementation/test/spec matches. Unrelated non-Chat WebSocket routes remain untouched.

- [ ] **Step 2: Run focused exact-head tests**

Run:

```bash
flox activate -- bunx vitest run tests/contracts/canonical-chat-api.test.ts tests/gateway/chat-event-stream.test.ts tests/gateway/auth.test.ts tests/desktop/api-client.test.ts tests/desktop/canonical-chat-event-source.test.ts tests/desktop/canonical-chat-route-controller.test.tsx tests/desktop/work-rail.test.tsx tests/desktop/work-tab.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run repository gates**

Run:

```bash
flox activate -- bun run typecheck
flox activate -- bun run check:patterns:diff
flox activate -- bun run test
```

Expected: changed-area tests and typecheck PASS. Record full-suite failures by exact file/test and prove whether they reproduce on `origin/main`; never describe a focused pass as a full-suite pass.

- [ ] **Step 4: Review the final diff**

Inspect:

```bash
git diff --check
git diff --stat origin/main...HEAD
git status --short --branch
```

Review for auth bypasses, unbounded parser/response buffers, duplicate replay, reader/timer leaks, raw error exposure, and accidental changes to non-Chat WebSockets.

- [ ] **Step 5: Commit any scoped review fixes**

Use a Conventional Commit matching the correction, for example:

```bash
git add <only-scoped-files>
git commit -m "fix(chat): bound http event stream lifecycle"
```

- [ ] **Step 6: Push and update PR #1479**

Update the English PR summary/tests/invariants to state:

- authenticated HTTP SSE replaces the Chat WebSocket;
- canonical snapshots and outbox cursors remain authoritative;
- no MCP JSON-RPC or transcript payload streaming is introduced;
- exact focused, typecheck, pattern, and full-suite evidence.

Push with `git push`.

- [ ] **Step 7: Restore review gates**

- monitor current-head Claude review and all unresolved review threads;
- reach current-head Greptile 5/5 with zero unresolved comments;
- verify the `ready-for-ci` label exists, then add it;
- wait for all label-triggered CI to complete;
- if triggered CI fails, remove the label before changing code and repeat current-head review.

- [ ] **Step 8: Report review-ready status without merging**

Report PR URL, branch/worktree, exact SHA, focused/full validation, Greptile 5/5, zero unresolved threads, `ready-for-ci`, and triggered CI. Do not merge without explicit user authorization.
