# Contract: Browser Gateway API

All routes are owner-authenticated. Client-visible errors use generic messages and bounded codes. Request bodies are limited with `bodyLimit` before parsing. JSON payloads use Zod boundary validation.

## Auth

- REST routes: existing Matrix session/auth context.
- Browser stream WebSocket: same-origin request plus short-lived signed stream token in `Sec-WebSocket-Protocol`.
- Agent actions: existing Matrix owner context plus active `BrowserPermissionGrant`.
- Platform Browser handoff: existing Matrix session on the platform host plus a short-lived one-use asymmetrically signed handoff token that redirects to the owner VPS Browser route. The owner VPS verifies the token with platform public key material from the host bundle. The platform does not proxy Browser APIs, WebSockets, WebRTC, page contents, cookies, or downloads.

## Error Shape

```json
{
  "error": {
    "code": "browser_unavailable",
    "message": "Browser is unavailable right now."
  }
}
```

Allowed codes:
- `browser_unavailable`
- `unauthorized`
- `invalid_request`
- `unsafe_url`
- `blocked_redirect`
- `limit_reached`
- `profile_locked`
- `takeover_required`
- `session_not_found`
- `download_not_found`
- `deferred_feature`
- `conflict`
- `upgrade_required`
- `stale_focus`
- `media_policy`
- `internal_error`

## `GET /browser/:target*` Platform Handoff

Optional platform entrypoint for shareable URLs such as `https://app.matrix-os.com/browser/google.com`.

Behavior:
- Authenticates the Matrix session on the platform host.
- Resolves the owner's current VPS Browser hostname.
- Mints a short-lived, one-use Browser handoff token bound to owner id, device id, target, issue time, expiry, key id, and nonce.
- Returns `302` or `303` to the owner VPS route, for example `https://{owner-vps-host}/browser/google.com?handoff=...`.
- Must not proxy Browser REST APIs, WebSocket control, WebRTC media, page contents, cookies, downloads, or Chromium network traffic.
- Token is signed with the platform private key and verified by the owner VPS using pinned public key/JWKS material from the host-bundle/provisioning path.
- Shared HMAC secrets are not valid for Browser handoff tokens.

## `GET /api/browser/capability`

Returns coarse Browser capability health for the current owner.

Response:

```json
{
  "available": true,
  "capacityState": "ok",
  "activeSessionCount": 1,
  "limits": {
    "maxSessions": 1,
    "maxTabs": 12,
    "maxStreams": 3
  }
}
```

Notes:
- No internal paths, runtime package names, DNS details, or raw service errors.

## `GET /api/browser/profiles`

Lists owner profiles. v1 returns the default profile only.

Response:

```json
{
  "profiles": [
    {
      "id": "profile_default",
      "name": "default",
      "displayName": "Default",
      "state": "available",
      "activeSessionId": null
    }
  ]
}
```

## `POST /api/browser/profiles/:profileId/clear`

Closes active sessions and clears selected profile scopes.

Request:

```json
{
  "scopes": {
    "cookies": true,
    "indexedDb": true,
    "localStorage": true,
    "cacheStorage": true,
    "sitePermissions": true,
    "savedFormData": false,
    "savedPasswords": false,
    "browsingHistory": false,
    "downloads": false
  }
}
```

Response:

```json
{
  "profileId": "profile_default",
  "state": "available",
  "clearedScopes": ["cookies", "indexedDb", "localStorage", "cacheStorage", "sitePermissions"]
}
```

## `GET /api/browser/sessions`

Lists resumable sessions for the owner.

Response:

```json
{
  "sessions": [
    {
      "id": "browser_session_123",
      "profileId": "profile_default",
      "state": "active",
      "currentTabId": "tab_123",
      "lastActiveAt": "2026-05-12T12:00:00.000Z",
      "surfaceCount": 1
    }
  ]
}
```

## `POST /api/browser/sessions`

Creates or resumes the single live session for a profile.

Request:

```json
{
  "profileName": "default",
  "targetUrl": "https://example.com",
  "handoffToken": "optional-one-use-platform-token",
  "surface": "canvas",
  "deviceId": "server-bound-device_abc"
}
```

Response:

```json
{
  "session": {
    "id": "browser_session_123",
    "profileId": "profile_default",
    "state": "active",
    "currentTabId": "tab_123",
    "takeoverRequired": false,
    "mediaMode": "webrtc",
    "protocolVersion": 1
  },
  "streamToken": "short-lived-token",
  "wsUrl": "/ws/browser/browser_session_123"
}
```

Validation:
- `targetUrl` is optional. When present, it is normalized and server-preflighted before runtime navigation.
- `deviceId` MUST be server-issued or bound to the authenticated Matrix session/device before profile lock decisions. Clients may echo the bound id, but raw client-chosen device ids are not trusted for same-device lock reuse.
- `handoffToken` is optional and only accepted on owner VPS session bootstrap. When present, the owner VPS verifies the platform signature, owner binding, expiry, key id, nonce, and replay store before consuming the token exactly once. The verified token target overrides any client-supplied `targetUrl`.
- Handoff token TTL MUST NOT exceed 60 seconds. The replay store keeps consumed nonces until token expiry plus 30 seconds, caps at 10,000 entries per owner VPS process, evicts oldest entries first, and treats process restart inside the TTL window as an accepted residual replay risk unless a durable nonce store is configured.
- If another physical device holds the profile lock, response is `409 takeover_required`.

## `POST /api/browser/sessions/:sessionId/takeover`

Requests takeover of a profile locked by another physical device.

Takeover MUST be atomic at the profile-lock source of truth: the old active session is marked recoverable/closed, `session.taken_over` is audited, and the replacement active session with the new `lockDeviceId` is installed in one repository transaction or equivalent compare-and-swap critical section. Stale, already-closed, or recoverable session ids are rejected.

Request:

```json
{
  "deviceId": "device_abc",
  "confirm": true
}
```

Response:

```json
{
  "session": {
    "id": "browser_session_456",
    "profileId": "profile_default",
    "state": "active"
  },
  "streamToken": "short-lived-token",
  "wsUrl": "/ws/browser/browser_session_456"
}
```

Server behavior:
- Sends `stream.taken_over` to streams attached to the previous session before closing them.
- Marks the previous session recoverable/closed according to whether durable tab metadata can be restored.
- Keeps the old profile lock held until the replacement session and new `lockDeviceId` are committed in the same transaction or compare-and-swap critical section.

## `POST /api/browser/sessions/:sessionId/close`

Closes a runtime session and releases its profile lock.

Request:

```json
{
  "reason": "user"
}
```

Response:

```json
{
  "sessionId": "browser_session_123",
  "state": "closed"
}
```

## `GET /api/browser/sessions/:sessionId/tabs`

Lists tabs for a session.

Response:

```json
{
  "tabs": [
    {
      "id": "tab_123",
      "index": 0,
      "title": "Example",
      "currentUrl": "https://example.com/",
      "state": "ready"
    }
  ]
}
```

## `POST /api/browser/sessions/:sessionId/tabs`

Creates a new tab and optionally navigates it.

Request:

```json
{
  "targetUrl": "https://example.com"
}
```

Response:

```json
{
  "tab": {
    "id": "tab_456",
    "index": 1,
    "state": "loading"
  }
}
```

## `POST /api/browser/sessions/:sessionId/tabs/:tabId/navigate`

Navigates a tab to a normalized, validated URL.

Request:

```json
{
  "targetUrl": "google.com"
}
```

Response:

```json
{
  "tab": {
    "id": "tab_123",
    "currentUrl": "https://google.com/",
    "state": "loading"
  }
}
```

## `POST /api/browser/sessions/:sessionId/tabs/:tabId/action`

Runs a bounded tab action.

Request:

```json
{
  "type": "refresh"
}
```

Allowed action types:
- `back`
- `forward`
- `refresh`
- `close`
- `focus`

Response:

```json
{
  "tabId": "tab_123",
  "state": "ready"
}
```

## `GET /api/browser/downloads`

Lists owner Browser downloads that completed or failed.

Query:
- `limit`: 1-100, default 50
- `cursor`: opaque cursor returned by the prior page

Response:

```json
{
  "downloads": [
    {
      "id": "download_123",
      "filename": "report.pdf",
      "state": "complete",
      "sizeBytes": 12345,
      "filePath": "/Downloads/report.pdf",
      "completedAt": "2026-05-12T12:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## `DELETE /api/browser/downloads/:downloadId`

Deletes a completed or failed download record and associated owner file/partial file.

Response:

```json
{
  "downloadId": "download_123",
  "state": "deleted"
}
```

## `GET /api/browser/audit`

Returns bounded owner-visible audit events.

Query:
- `limit`: 1-100
- `cursor`: opaque cursor
- `type`: optional event type filter

Response:

```json
{
  "events": [
    {
      "id": "audit_123",
      "eventType": "navigation.blocked",
      "category": "unsafe_url",
      "createdAt": "2026-05-12T12:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## `POST /api/browser/grants`

Creates a scoped Browser Permission Grant for an app or agent.

Request:

```json
{
  "requesterType": "agent",
  "requesterId": "matrix-agent",
  "profileId": "profile_default",
  "scope": "screenshot",
  "domainSet": ["example.com"],
  "expiresAt": "2026-05-12T13:00:00.000Z"
}
```

Validation:
- `expiresAt` is optional. If omitted, the server uses the earlier of the bound Matrix web session expiry or 8 hours from creation.
- Requested expiry cannot exceed the configured maximum grant duration.
- `domainSet` must be explicit and bounded; wildcard-all grants are rejected.

Response:

```json
{
  "grant": {
    "id": "grant_123",
    "scope": "screenshot",
    "revokedAt": null
  }
}
```

## `DELETE /api/browser/grants/:grantId`

Revokes a Browser Permission Grant.

Response:

```json
{
  "grantId": "grant_123",
  "revokedAt": "2026-05-12T12:30:00.000Z"
}
```
