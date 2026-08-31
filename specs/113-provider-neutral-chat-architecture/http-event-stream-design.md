# Canonical Chat HTTP Event Stream Design

**Approved direction:** 2026-08-31  
**Parent specification:** `specs/113-provider-neutral-chat-architecture/spec.md`  
**Scope:** Replace the canonical Chat WebSocket invalidation transport with an authenticated HTTP SSE stream.

## Purpose

Canonical Chat already persists owner-scoped state in PostgreSQL and publishes
safe invalidations through its transactional outbox. Desktop currently opens a
raw WebSocket for those invalidations, but still needs canonical HTTP snapshots
for transcript content. The transport should converge on normal authenticated
HTTP streaming while preserving outbox replay, owner isolation, bounded
resources, and reconnect parity.

This is an HTTP event stream, not an MCP endpoint. MCP Streamable HTTP requires
MCP JSON-RPC messages, POST/GET behavior, protocol initialization, and optional
MCP session management. Canonical Chat has its own domain contract, uses REST
for client mutations, and needs only a server-to-client invalidation stream.

## Decisions

1. Replace `GET /ws/chats/events` with authenticated
   `GET /api/chats/events`.
2. Return `text/event-stream` and encode each existing validated
   `CanonicalChatStreamServerFrame` as one SSE `data` event.
3. Keep PostgreSQL snapshots as the source of truth. The stream carries safe
   invalidation metadata only; it never becomes a transcript store.
4. Keep the transactional outbox, monotonic cursor, attach buffering, replay
   gap, subscriber caps, failed-sender eviction, and shutdown drain.
5. Use the standard request-principal bearer path. Remove the Chat WebSocket
   query-token exception and the Desktop WebSocket-token request.
6. Resume with `Last-Event-ID`; accept the bounded `cursor` query parameter as
   a compatibility fallback when the header is absent. A valid
   `Last-Event-ID` takes precedence.
7. Add SSE comment heartbeats without exposing a new application frame.
8. Remove the Chat client `ping`/`detach` frames and server `pong` frame. HTTP
   cancellation owns detach; SSE heartbeats own idle liveness.
9. Preserve the Desktop connection-state contract: only
   `chat.stream.attached` marks the stream healthy.
10. Preserve bounded 2-10 second active-Run snapshot polling only while the
    stream is unavailable, attaching, or reconnecting.

## Alternatives Rejected

### Literal MCP Streamable HTTP

Rejected because Chat is not an MCP client/server exchange. Adding JSON-RPC
envelopes, initialization, protocol-version headers, POST message handling, and
MCP session IDs would duplicate the existing REST and outbox contracts without
adding interoperability.

### WebSocket and HTTP dual transport

Rejected because it doubles auth, replay, shutdown, and test surfaces. During
a rolling version mismatch, an older Desktop can continue through its existing
polling fallback, while a newer Desktop connected to an older Gateway can do
the same until both sides update.

### Transcript content streaming in this change

Rejected as a separate data-contract decision. This transport continues to
invalidate bounded canonical snapshots; it does not send provider deltas or
transcript content.

## Gateway Contract

### Request

```http
GET /api/chats/events
Accept: text/event-stream
Authorization: Bearer <existing principal credential>
Last-Event-ID: <optional canonical outbox cursor>
```

- `Accept` must include `text/event-stream`.
- The standard Gateway auth middleware derives the owner principal.
- `Last-Event-ID` and the optional `cursor` query value use
  `CanonicalChatEventCursorSchema`.
- Invalid headers or query values return a generic bounded `400` response
  before the stream attaches.
- Auth failures remain standard `401`/`403` responses and never open a stream.

### Response

```http
Content-Type: text/event-stream
Cache-Control: no-store
X-Accel-Buffering: no
```

Application frames use this form:

```text
id: 42
data: {"type":"chat.event","event":{"cursor":42,...}}

```

- `id` is emitted for `chat.event` frames and equals the canonical outbox
  cursor.
- Non-event control frames omit `id` but still use one bounded JSON `data`
  value.
- Heartbeats are SSE comments and are ignored by the frame parser.
- Every JSON payload is validated with
  `CanonicalChatStreamServerFrameSchema` before enqueue.

## Gateway Data Flow

1. Authenticate and validate the request before creating the response stream.
2. Create a bounded per-response SSE sink and register it with the canonical
   Chat event hub.
3. Subscribe before replay so committed events cannot fall between replay and
   live delivery.
4. Send `chat.stream.attached`, the replay window or replay-gap signal,
   `chat.replay.end`, then buffered live events in server order.
5. On each committed outbox event, deliver only to subscribers with the same
   owner scope.
6. Send a heartbeat comment every 15 seconds and touch the subscriber lease.
7. If the response queue is full, encoding fails, or the stream is cancelled,
   evict the subscriber and clean up its timer.
8. On Gateway shutdown, send `chat.stream.closing` best-effort, close every
   response stream, clear timers/subscribers, dispose the outbox sink, then
   release shared repository resources.

## Resource Bounds

- Preserve the existing global and per-owner subscriber caps.
- Preserve the existing attach buffer and replay limit.
- Preserve the existing 16 KiB application-frame bound.
- Use a bounded response queue. A slow consumer is evicted instead of growing
  memory without limit.
- Bound the Desktop parser's incomplete-event buffer to 16 KiB.
- Bound each Desktop connection lifetime to five minutes and reconnect with
  its last cursor. This gives the long-lived fetch an explicit timeout while
  preserving continuous service.
- Abort and reconnect if no frame or heartbeat arrives for 45 seconds.

## Desktop Data Flow

1. Build `/api/chats/events` through the active runtime URL and open a streaming
   `fetch` with `Accept: text/event-stream` and an abort signal.
2. Rely on the trusted Desktop network layer to inject the existing bearer
   credential, exactly like other authenticated API requests.
3. Validate HTTP status and content type before reading the body.
4. Incrementally decode UTF-8 bytes and parse SSE records across arbitrary
   chunk boundaries.
5. Validate each `data` value with the existing canonical server-frame schema.
6. Mark connection state `open` only after `chat.stream.attached`.
7. Preserve the latest canonical cursor from event frames and replay-end
   control frames.
8. Abort on disposal, invalid/oversized frames, retryable stream errors,
   inactivity, or the five-minute connection rotation.
9. Reconnect with exponential backoff capped at 10 seconds and send
   `Last-Event-ID` when a cursor exists.
10. While the stream is not open, retain the existing bounded active-Run
    snapshot fallback. When open, stream invalidations are the primary path.

## Error Handling

- Gateway logs diagnostic error categories only and sends generic safe stream
  errors where the response has already begun.
- Pre-attachment validation and auth failures use normal bounded HTTP errors.
- One subscriber failure never prevents delivery to another subscriber.
- Desktop logs allowlisted diagnostic categories, never credentials, response
  bodies, transcript content, provider names, or filesystem paths.
- A replay gap forces a full canonical list/detail refresh.
- Malformed SSE or invalid canonical frames close the response and enter the
  same bounded reconnect/fallback path.

## Compatibility

- New Desktop plus old Gateway: HTTP stream receives `404`; Desktop uses the
  bounded polling fallback until the Gateway updates.
- Old Desktop plus new Gateway: WebSocket connection fails; old Desktop uses
  its existing polling fallback until the Desktop updates.
- Matching versions: HTTP invalidations are primary and active polling stops
  once `chat.stream.attached` is received.

No database migration, outbox migration, transcript migration, or user-data
rewrite is required.

## Verification

### Gateway

- authenticated owner isolation;
- `Accept`, `Last-Event-ID`, and cursor validation;
- subscribe-before-replay ordering and replay-gap behavior;
- SSE encoding, cursor IDs, heartbeat, cancellation cleanup, and shutdown;
- bounded attach/response queues, caps, stale eviction, and failed-sender
  isolation;
- removal of the Chat WebSocket query-token path.

### Desktop

- headers, runtime routing, and no WebSocket-token request;
- fragmented and combined SSE chunks;
- heartbeat comments, event IDs, malformed/oversized frames, and bounded
  parser state;
- server-attached health, inactivity/rotation abort, reconnect cursor, and
  exponential backoff;
- no active polling while attached and 2-10 second fallback otherwise;
- coalesced message invalidations and Work rail message-only filtering.

### Gates

- focused Gateway and Desktop tests;
- full repository typecheck;
- changed-area pattern scan;
- full test suite with unrelated baseline failures reported separately;
- current-head review, Greptile 5/5, and label-gated CI before merge.

## Deferred Scope

- MCP exposure of canonical Chat;
- provider token/delta payload streaming;
- replacing snapshot invalidations with transcript content frames;
- changing the canonical Chat persistence or outbox schema;
- changing non-Chat WebSocket transports.
