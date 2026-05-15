# Contract: Hermes Manager REST API

Base path: `/api/hermes`

All routes require a Matrix request principal. Owner-only routes are marked explicitly. All errors use:

```json
{ "error": { "code": "hermes_request_failed", "message": "Hermes request failed" } }
```

Messages are generic and never contain provider names, secrets, raw command output, stack traces, or filesystem paths.

## Auth Matrix

| Route | Method | Auth Method | Access | Public? |
| --- | --- | --- | --- | --- |
| `/status` | GET | Matrix request principal | Owner or authorized operator | No |
| `/config` | GET | Matrix request principal | Owner or authorized operator | No |
| `/config` | POST | Matrix request principal | Owner only by default | No |
| `/credentials/model` | POST | Matrix request principal | Owner only | No |
| `/channels` | GET | Matrix request principal | Owner or authorized operator | No |
| `/channels/:channelId/action` | POST | Matrix request principal | Owner or authorized operator, allowlisted P1 channels only | No |
| `/sessions` | GET | Matrix request principal | Owner or authorized operator | No |
| `/sessions` | POST | Matrix request principal | Owner or authorized operator | No |
| `/sessions/:sessionId/prompt` | POST | Matrix request principal plus session ownership | Owner or authorized operator for that installation | No |
| `/approvals/:approvalId/decision` | POST | Matrix request principal plus approval ownership | Owner or authorized operator for that installation | No |
| `/capabilities` | GET | Matrix request principal | Owner or authorized operator | No |
| `/gateway/action` | POST | Matrix request principal | Owner only by default | No |
| `/recover` | POST | Matrix request principal | Owner only by default | No |
| `/events` | GET | Matrix request principal | Owner or authorized operator | No |
| `/audit` | GET | Matrix request principal | Owner or authorized operator | No |
| `/export` | GET | Matrix request principal | Owner only by default | No |

`Owner only by default` is intentionally fixed for P1. P1 has no delegation override for installation config, model credentials, gateway restart/update, or export; future delegation requires an explicit reviewed permission field in `POST /config` or a separate owner-managed delegation contract.

## GET /status

Auth: owner or authorized operator.

Response:

```json
{
  "installationId": "hermes_owner",
  "readiness": "ready",
  "gatewayStatus": "healthy",
  "version": "1.2.3",
  "defaultProfileId": "default",
  "defaultModelId": "claude-opus-4.6",
  "counts": {
    "channels": 2,
    "connectedChannels": 1,
    "activeSessions": 1,
    "pendingApprovals": 0,
    "needsAttention": 0
  },
  "lastCheckedAt": "2026-05-15T00:00:00.000Z"
}
```

## GET /config

Auth: owner or authorized operator.

Response:

```json
{
  "installation": {},
  "modelProviders": [],
  "channels": [],
  "capabilities": [],
  "setupSteps": []
}
```

All fields are public DTOs with secrets and raw paths redacted.

## POST /config

Auth: owner only by default. Body limit: 32 KiB.

Request:

```json
{
  "homeMode": "default",
  "hermesPath": "/home/deploy/hermes-agent",
  "defaultProfileId": "default",
  "defaultModelId": "claude-opus-4.6",
  "authorizedOperators": ["user_123"]
}
```

`authorizedOperators` is capped at 50 entries. Requests above that cap are rejected with `400 invalid_request`; the server must not silently truncate operator lists.

Response: same shape as `GET /config`.

`homeMode` is an enum. `"default"` means the gateway uses its configured Hermes installation root (`HERMES_REPO_PATH` or the packaged owner-home default) and ignores `hermesPath`. `"custom"` means the owner is selecting an alternate Hermes checkout under an allowed owner-controlled installation root, and `hermesPath` is required.

`hermesPath`, when supplied, is never used directly. The server resolves and validates it against the allowed owner-controlled Hermes installation roots before persisting a redacted label or passing a resolved path to the bridge. Invalid, absolute-outside-root, traversal, symlink-escape, or non-Hermes paths are rejected with a generic validation error.

## POST /credentials/model

Auth: owner only. Body limit: 32 KiB.

Request:

```json
{
  "providerId": "anthropic",
  "secret": "server-side-only"
}
```

Response:

```json
{ "configured": true, "providerId": "anthropic", "status": "healthy" }
```

The bridge returns model-provider metadata as `ModelCredentialResult` with canonical key `id`. This route deliberately maps that bridge `id` to `providerId` in the one-shot save response because the client just submitted a provider credential. `GET /config` keeps provider metadata in `modelProviders[]` with `id`.

## GET /channels

Auth: owner or authorized operator.

Response:

```json
{ "channels": [] }
```

## POST /channels/:channelId/action

Auth: owner or authorized operator. Body limit: 32 KiB.

Supported P1 `channelId`: `telegram`, `whatsapp`. Unknown `channelId` values are rejected before action parsing with `400 invalid_request`; future channels may be listed read-only by `GET /channels` but cannot receive mutating actions until they are explicitly allowlisted.

Request discriminated union. Payload schemas are per action and per P1 channel:

```json
{ "type": "connect", "payload": { "botToken": "server-side-only", "allowedSenders": ["123456"], "homeChannel": "owner-home" } }
```

Action types:

- `connect`
  - `telegram` payload: `{ "botToken": string, "allowedSenders": string[], "homeChannel"?: string }`
  - `whatsapp` payload: `{ "pairingLabel"?: string, "allowedSenders"?: string[], "homeChannel"?: string }`
- `verify`: `{ "type": "verify" }`
- `disable`: `{ "type": "disable" }`
- `enable`: `{ "type": "enable" }`
- `recover`: `{ "type": "recover" }`
- `start_pairing`
  - `whatsapp` payload: `{ "pairingLabel"?: string }`
  - `telegram` is rejected for `start_pairing`
- `cancel_pairing`: `{ "type": "cancel_pairing" }`

The route validates the path `channelId` first, then validates the action with the channel-specific schema. It never accepts an arbitrary payload record for persistence.

Response:

```json
{
  "channel": {},
  "operation": {
    "id": "op_123",
    "status": "complete",
    "message": "Channel updated",
    "pairing": {
      "kind": "qr" | "code",
      "displayValue": "redacted-or-short-lived-code",
      "expiresAt": "2026-05-15T00:05:00.000Z"
    }
  }
}
```

`operation.pairing` is only returned for WhatsApp `start_pairing`, is short-lived, and is also emitted through a redacted `channel.updated` event so the app can show QR/code instructions without storing them in channel state.

## GET /sessions

Auth: owner or authorized operator.

Query:

- `status`: optional session status.
- `limit`: integer 1-100.
- `cursor`: bounded cursor.

Response:

```json
{ "sessions": [], "nextCursor": null }
```

Scope rule: owners see all installation sessions. Authorized operators see sessions for the installation they are authorized to operate; this is full operator visibility by design for the shared Hermes orchestrator, and the UI/audit trail must show the actor for each session/action.

## POST /sessions

Auth: owner or authorized operator. Body limit: 64 KiB.

Request:

```json
{ "profileId": "default", "modelId": "claude-opus-4.6", "prompt": "hello", "clientRequestId": "req_123" }
```

`clientRequestId` is required, bounded, and persisted per owner/session so retries do not create duplicate upstream Hermes sessions.

First-time session creation returns `200` with `{ "session": ... }`. If `clientRequestId` already maps to an existing session for the same owner, the route also returns `200` with the existing `{ "session": ... }` response body and does not create or enqueue a second upstream Hermes session. The route never uses `201`; clients distinguish first-time and retry responses by session identity and persisted `clientRequestIds`, not by HTTP status code.

Response:

```json
{ "session": {} }
```

## POST /sessions/:sessionId/prompt

Auth: owner or authorized operator. Body limit: 64 KiB.

Request:

```json
{ "prompt": "continue", "clientRequestId": "req_123" }
```

Duplicate `clientRequestId` for the same session is deduplicated or rejected safely.

Response:

```json
{ "session": {} }
```

## POST /approvals/:approvalId/decision

Auth: owner or authorized operator. Body limit: 8 KiB.

Request:

```json
{ "decision": "approved" | "denied" }
```

Response:

```json
{ "approval": {} }
```

## GET /capabilities

Auth: owner or authorized operator.

Response:

```json
{ "capabilities": [] }
```

## POST /gateway/action

Auth: owner only by default. Body limit: 8 KiB.

Request:

```json
{ "type": "restart" }
```

Action types:

- `restart`
- `health_check`
- `update`

Response:

```json
{
  "operation": {
    "id": "op_123",
    "status": "running",
    "message": "Gateway restart accepted",
    "patch": {
      "gatewayStatus": "starting"
    }
  }
}
```

`operation.message` is always present and client-safe. `operation.patch` is present when the bridge can return an optimistic installation-state update; routes apply the same patch to persisted installation state before returning it.

## POST /recover

Auth: owner only by default. Body limit: 4 KiB.

Request:

```json
{}
```

P1 recovery is always installation-scoped. The REST contract intentionally does not expose `sessionIds`, `channelIds`, or other targeting fields; route handlers pass `scope: "installation"` to `HermesBridge.recover()` when needed.

Response:

```json
{ "recovery": { "status": "complete", "message": "Recovery completed" } }
```

This endpoint invokes `HermesBridge.recover()` for the current installation and publishes a redacted `operator.event` with category `recovery`.

Recovery is guarded by the same owner-scoped action lock map as setup, pairing, restart, update, approval, and prompt-send actions. The lock key is `ownerId:recover`, has the standard mutating-action TTL, and returns a generic conflict response when a retry or double-click arrives while recovery is already running. P1 does not require a client idempotency key because recovery is an installation reconciliation action, not a new user-created resource.

## GET /events

Auth: owner or authorized operator.

EventSource stream. Events:

- `status.updated`
- `channel.updated`
- `session.event`
- `approval.updated`
- `operator.event`
- `heartbeat`

Subscribers are capped per owner and evicted on stale or failed sends.

Scope rule: the Hermes Manager SSE stream is installation-scoped by design. Owners and authorized operators receive the same redacted `status.updated`, `channel.updated`, `session.event`, `approval.updated`, and `operator.event` stream for the installation they are authorized to operate. Events that may contain conversation/tool context must include actor/session identifiers so shared operator visibility is explicit in the UI and audit trail.

## GET /audit

Auth: owner or authorized operator.

Query:

- `limit`: integer 1-100.
- `cursor`: bounded cursor.

Response:

```json
{ "events": [], "nextCursor": null }
```

Scope rule: owners and authorized operators see the redacted installation audit log. Events include actor/category/target/timestamp so shared operator visibility is explicit.

## GET /export

Auth: owner only by default.

Response:

```json
{
  "installation": {},
  "setupSteps": [],
  "modelProviders": [],
  "channels": [],
  "capabilities": [],
  "sessions": [],
  "approvals": [],
  "events": []
}
```

The response mirrors the redacted subset of `GET /config`. It never includes credentials, raw paths, credential references, raw errors, or command output.

Export arrays are bounded by the same retained-state caps used by the gateway: `sessions` returns at most the latest 100 redacted session summaries, `approvals` returns at most the latest 100 approval prompts, and `events` returns at most the latest 500 retained redacted events. P1 does not paginate export because the payload is intentionally capped for owner portability and operator review.
