# Contract: Hermes Manager Events

Hermes Manager exposes browser-facing events through `/api/hermes/events`.

## Common Fields

```json
{
  "id": "evt_123",
  "type": "session.event",
  "installationId": "hermes_owner",
  "createdAt": "2026-05-15T00:00:00.000Z"
}
```

Every event merges these common fields with the type-specific fields below. The examples focus on type-specific payloads, but `id`, `installationId`, and `createdAt` are required on the wire for every event, including `heartbeat`. All payloads are bounded and redacted.

## Visibility

Events are installation-scoped. Owners and authorized operators receive the same redacted event stream for the Hermes installation they operate; `session.event` and `approval.updated` are not per-operator private streams. Payloads must include actor/session identifiers where relevant so the app can make shared operator visibility clear.

## Event Types

### status.updated

```json
{
  "type": "status.updated",
  "readiness": "ready",
  "gatewayStatus": "healthy"
}
```

### channel.updated

```json
{
  "type": "channel.updated",
  "id": "whatsapp",
  "platform": "whatsapp",
  "status": "connected",
  "configured": true,
  "enabled": true,
  "allowedSenderPolicy": "Owner + allowlisted contacts",
  "lastCheckedAt": "2026-05-15T00:04:00.000Z",
  "updatedAt": "2026-05-15T00:04:00.000Z",
  "pairing": {
    "kind": "qr",
    "displayValue": "short-lived-code",
    "expiresAt": "2026-05-15T00:05:00.000Z"
  }
}
```

`channel.updated` uses the same channel identity key as `MessagingChannelDto.id`; it never emits a separate `channelId`. The payload includes this redacted subset of `MessagingChannelDto`: `id`, `platform`, `status`, `configured`, `enabled`, `allowedSenderPolicy`, `lastCheckedAt`, and `updatedAt`. `pairing` is present only for WhatsApp pairing flows. It is short-lived display data and must not be persisted as a channel secret.

### session.event

```json
{
  "type": "session.event",
  "sessionId": "ses_123",
  "event": {
    "kind": "assistant_delta",
    "text": "Hello"
  }
}
```

Allowed `event.kind` values:

- `assistant_delta`
- `assistant_message`
- `tool_start`
- `tool_result`
- `approval_requested`
- `session_status`
- `error`

Payload schemas by `event.kind`:

- `assistant_delta`: `{ "kind": "assistant_delta", "text": string }`, where `text` is bounded to 8 KiB per event.
- `assistant_message`: `{ "kind": "assistant_message", "messageId": string, "text": string }`, where `text` is bounded to 32 KiB and redacted before broadcast.
- `tool_start`: `{ "kind": "tool_start", "toolCallId": string, "toolName": string, "displayName"?: string }`; arguments, paths, tokens, and raw command lines are never included.
- `tool_result`: `{ "kind": "tool_result", "toolCallId": string, "status": "complete" | "failed", "summary": string }`; `summary` is bounded to 1 KiB and must not include raw stdout, stderr, stack traces, filesystem paths, or provider errors.
- `approval_requested`: `{ "kind": "approval_requested", "approvalId": string, "requestedTool"?: string, "description": string }`; `requestedTool` matches the optional `ApprovalPrompt.requestedTool` field when Hermes provides a safe tool display name. `description` is bounded and redacted.
- `session_status`: `{ "kind": "session_status", "status": "idle" | "starting" | "streaming" | "waiting_approval" | "stopped" | "failed" | "recoverable" }`.
- `error`: `{ "kind": "error", "code": "unavailable" | "timeout" | "invalid_upstream_response" | "operation_failed" | "conflict", "message": string }`; `message` is a generic client-safe string and never contains upstream/provider names, raw errors, or paths.

### approval.updated

```json
{
  "type": "approval.updated",
  "approvalId": "appr_123",
  "sessionId": "ses_123",
  "status": "pending",
  "decisionBy": null
}
```

Emitted when an approval is created and on each status transition to `approved`, `denied`, `expired`, or `failed`; `status` always reflects the new state and `decisionBy` is set for operator decisions.

### operator.event

```json
{
  "type": "operator.event",
  "actorId": "user_123",
  "category": "channel",
  "targetId": "telegram",
  "severity": "info",
  "message": "Channel updated"
}
```

### heartbeat

```json
{ "type": "heartbeat" }
```

## Resource Rules

- Per-owner subscribers are capped.
- Per-session retained events are capped.
- Failed sends evict subscribers after the broadcast loop.
- Shutdown drains all subscribers with a final generic event.
