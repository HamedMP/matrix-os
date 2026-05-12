# Contract: Browser Stream WebSocket

Endpoint:

```text
GET /ws/browser/:sessionId
```

Authentication:
- Same-origin with owner VPS hostname.
- Existing Matrix session must be valid.
- `Sec-WebSocket-Protocol` includes a short-lived signed Browser stream token.
- Token is bound to owner id, session id, profile id, surface, device id, issue time, expiry, and nonce.
- Unauthenticated, expired, wrong-origin, wrong-session, or replayed upgrades are rejected.
- Replay rejection uses a server-side nonce store scoped to the owner VPS gateway process. The store keeps used nonces until token expiry plus 30 seconds, caps entries at 10,000, and evicts oldest entries first. Token TTL MUST NOT exceed 60 seconds.

Transport split:
- WebSocket is the authenticated control, input, status, and WebRTC signaling channel.
- WebRTC is the production media plane for viewport video and audio output.
- The Browser service is the WebRTC offerer; clients answer with receive-only audio/video transceivers.
- v1 uses relay-only ICE. Local, loopback, link-local, and private host candidates are filtered from signaling.
- `viewport.frame` is a bounded diagnostic/fallback message only, not the primary production media transport.

## Server Message Envelope

```json
{
  "type": "stream.ready",
  "requestId": "optional-client-request-id",
  "sentAt": "2026-05-12T12:00:00.000Z",
  "payload": {}
}
```

All messages are schema-validated. Unknown types close the connection with a generic policy error.

## Client -> Server Messages

### `stream.hello`

Initial client handshake after WebSocket open.

```json
{
  "type": "stream.hello",
  "payload": {
    "protocolVersion": 1,
    "surfaceId": "surface_canvas_abc",
    "surface": "canvas",
    "deviceId": "device_abc",
    "viewport": {
      "width": 1280,
      "height": 720,
      "deviceScaleFactor": 1
    },
    "media": {
      "preferredMode": "webrtc",
      "audio": true,
      "fallbackFrames": false,
      "iceTransportPolicy": "relay"
    }
  }
}
```

If `protocolVersion` is unsupported, the server sends `stream.error` with `upgrade_required` and closes.

### `viewport.resize`

```json
{
  "type": "viewport.resize",
  "payload": {
    "width": 1280,
    "height": 720,
    "deviceScaleFactor": 1
  }
}
```

### `input.pointer`

```json
{
  "type": "input.pointer",
  "payload": {
    "kind": "down",
    "x": 120,
    "y": 240,
    "button": "left",
    "modifiers": []
  }
}
```

Allowed `kind`: `move`, `down`, `up`, `wheel`.

Input messages are accepted only from the focused surface.

### `input.keyboard`

```json
{
  "type": "input.keyboard",
  "payload": {
    "kind": "keydown",
    "key": "Enter",
    "code": "Enter",
    "text": "",
    "modifiers": []
  }
}
```

Allowed `kind`: `keydown`, `keyup`, `text`.

### `input.ime`

```json
{
  "type": "input.ime",
  "payload": {
    "kind": "compositionstart",
    "text": ""
  }
}
```

Allowed `kind`: `compositionstart`, `compositionupdate`, `compositionend`.

### `input.paste`

```json
{
  "type": "input.paste",
  "payload": {
    "text": "bounded clipboard text"
  }
}
```

Paste input is bounded and accepted only from the focused surface. Clipboard write remains deferred.

### `surface.focus`

Requests the input focus lease for this surface.

```json
{
  "type": "surface.focus",
  "payload": {
    "surfaceId": "surface_canvas_abc",
    "reason": "pointer"
  }
}
```

### `tab.focus`

```json
{
  "type": "tab.focus",
  "payload": {
    "tabId": "tab_123"
  }
}
```

### `stream.ping`

```json
{
  "type": "stream.ping",
  "payload": {
    "lastFrameId": "frame_123"
  }
}
```

### `media.answer`

Carries the WebRTC answer from the client after receiving the Browser service offer.

```json
{
  "type": "media.answer",
  "payload": {
    "sdp": "bounded-sdp-answer"
  }
}
```

### `media.ice`

Carries a bounded relay ICE candidate for the Browser media peer connection.

```json
{
  "type": "media.ice",
  "payload": {
    "candidate": "bounded-candidate",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

Candidates that expose local, loopback, link-local, private, multicast, or direct host addresses are rejected with a generic media policy error.

## Server -> Client Messages

### `stream.ready`

```json
{
  "type": "stream.ready",
  "payload": {
    "protocolVersion": 1,
    "sessionId": "browser_session_123",
    "profileId": "profile_default",
    "currentTabId": "tab_123",
    "focusedSurfaceId": "surface_canvas_abc",
    "media": {
      "mode": "webrtc",
      "audio": true,
      "muted": true,
      "maxWidth": 1280,
      "maxHeight": 720,
      "maxFrameRate": 30,
      "maxBitrateKbps": 2500,
      "iceTransportPolicy": "relay",
      "turnCredentialExpiresAt": "2026-05-12T12:05:00.000Z",
      "turnRefreshAt": "2026-05-12T12:04:00.000Z"
    },
    "limits": {
      "maxFrameQueue": 3,
      "maxPendingInput": 128
    }
  }
}
```

Clients MUST reconnect media before `turnCredentialExpiresAt`. The server sends a fresh `media.offer`
with new TURN credentials when the client reconnects or when the current credentials are within the
`turnRefreshAt` window. If refresh cannot complete, the server falls back to the bounded WS frame
transport or sends `stream.error` with `media_policy`.

### `media.offer`

```json
{
  "type": "media.offer",
  "payload": {
    "sdp": "bounded-sdp-offer",
    "iceServers": [
      {
        "urls": ["turns:turn.matrix-os.com:5349"],
        "username": "short-lived-session-user",
        "credential": "short-lived-session-credential"
      }
    ],
    "iceTransportPolicy": "relay"
  }
}
```

### `media.ice`

```json
{
  "type": "media.ice",
  "payload": {
    "candidate": "bounded-candidate",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

### `surface.focused`

Broadcast whenever the input focus lease changes.

```json
{
  "type": "surface.focused",
  "payload": {
    "surfaceId": "surface_canvas_abc",
    "tabId": "tab_123"
  }
}
```

### `viewport.frame`

```json
{
  "type": "viewport.frame",
  "payload": {
    "frameId": "frame_123",
    "tabId": "tab_123",
    "encoding": "jpeg",
    "width": 1280,
    "height": 720,
    "data": "base64-frame-data"
  }
}
```

Fallback frame buffers are capped. If the client falls behind, old frames are dropped in favor of latest frame. Production clients should use WebRTC media instead.

### `tab.updated`

```json
{
  "type": "tab.updated",
  "payload": {
    "tab": {
      "id": "tab_123",
      "title": "Example",
      "currentUrl": "https://example.com/",
      "faviconUrl": "https://example.com/favicon.ico",
      "state": "ready"
    }
  }
}
```

### `navigation.blocked`

```json
{
  "type": "navigation.blocked",
  "payload": {
    "tabId": "tab_123",
    "category": "unsafe_url",
    "message": "This destination is blocked."
  }
}
```

No DNS details, internal route names, upstream statuses, or redirect chains are included.

### `download.updated`

```json
{
  "type": "download.updated",
  "payload": {
    "downloadId": "download_123",
    "filename": "report.pdf",
    "state": "complete",
    "sizeBytes": 12345
  }
}
```

### `permission.requested`

```json
{
  "type": "permission.requested",
  "payload": {
    "tabId": "tab_123",
    "feature": "camera",
    "state": "deferred",
    "message": "This site feature is unavailable in Matrix Browser v1."
  }
}
```

### `stream.error`

```json
{
  "type": "stream.error",
  "payload": {
    "code": "profile_locked",
    "message": "Browser is open somewhere else."
  }
}
```

Allowed codes include:
- `browser_unavailable`
- `profile_locked`
- `takeover_required`
- `taken_over`
- `stale_focus`
- `upgrade_required`
- `media_policy`
- `invalid_request`
- `internal_error`

### `stream.taken_over`

Sent to streams attached to a session that has been taken over by another physical device.

```json
{
  "type": "stream.taken_over",
  "payload": {
    "message": "Browser was opened on another device."
  }
}
```

The server sends this best-effort before closing the stream.

### `stream.pong`

```json
{
  "type": "stream.pong",
  "payload": {
    "serverTime": "2026-05-12T12:00:00.000Z"
  }
}
```

## Resource Rules

- Message size is capped.
- WebRTC signaling payloads are size capped and schema validated.
- Fallback frame queue is latest-frame only with a small bounded backlog.
- Pending input queue is capped and drops/rejects excess with safe error.
- Non-focused input is rejected with `stale_focus`.
- Heartbeat timeout marks stream stale and triggers eviction.
- Broadcast/send failures remove the dead stream after the loop.
- Shutdown sends `stream.error` with `browser_unavailable`, marks session recoverable, clears subscribers, and releases runtime handles.
