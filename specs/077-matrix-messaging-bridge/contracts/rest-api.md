# Contract: Matrix Messaging Bridge APIs

All routes are owner-scoped. Mutating routes must use Hono `bodyLimit`, validate with Zod 4, return generic safe errors, and avoid exposing provider internals.

## Common Rules

- Auth source: Matrix OS request principal.
- Body content type: `application/json` unless noted.
- Response content type: `application/json`.
- Network slug allowlist for first scope: `telegram`, `whatsapp`.
- Setup session TTL: 10 minutes.
- Health timeout: 5 seconds.
- Default initial visible backfill: latest 100 messages per room.
- Recovery boundary: 1 hour RPO, 15 minute RTO after reachable VPS, WhatsApp relink may be required after restoring from a snapshot older than 24 hours or after paired-device rejection.
- Queue caps: 10,000 queued events per owner, 2,000 per network, 500 per room.
- Media job caps: 100 concurrent per owner, 10 concurrent per room.
- Idempotency retention: 30 days of canonical Matrix homeserver `event_id` values.
- Client-visible errors may name the user-facing network, but must not include bridge tokens, access tokens, phone numbers, emails, QR payloads, raw upstream errors, internal service names, filesystem paths, stack traces, or database errors.
- Internal Hermes caller auth: trusted Hermes calls must use a gateway-issued internal capability token scoped to owner, room, action, and expiry. Tokens must be short-lived, rotated through Matrix OS runtime configuration, compared with constant-time helpers, and never exposed to model prompts or subagent environments.

Error shape:

```json
{
  "error": {
    "code": "safe_coarse_code",
    "message": "Safe user-facing message"
  }
}
```

## GET /api/messages/networks

List supported networks and setup availability.

Auth: Matrix OS user session.

Response 200:

```json
{
  "networks": [
    {
      "slug": "telegram",
      "displayName": "Telegram",
      "status": "available",
      "setupMode": "code",
      "supportsMedia": true,
      "supportsBackfill": true
    },
    {
      "slug": "whatsapp",
      "displayName": "WhatsApp",
      "status": "available",
      "setupMode": "qr",
      "supportsMedia": true,
      "supportsBackfill": true
    }
  ]
}
```

## POST /api/messages/accounts/setup

Start Telegram or WhatsApp linking.

Auth: Matrix OS user session.
Body limit: 8 KiB.

Request:

```json
{
  "network": "telegram",
  "label": "Personal Telegram"
}
```

Response 201:

```json
{
  "setupId": "9f730a48-6d59-4777-9462-39417e8ca78e",
  "network": "telegram",
  "expiresAt": "2026-05-12T12:10:00.000Z",
  "nextStep": {
    "type": "code",
    "instructions": "Open Telegram and confirm the login code."
  }
}
```

WhatsApp `nextStep` may use `type: "qr"` and return a short-lived QR display token. QR payloads must not be logged or stored in audit events.

## POST /api/messages/accounts/setup/{setupId}/complete

Complete network-specific setup.

Auth: Matrix OS user session plus owner-bound setup session.
Body limit: 16 KiB.
Security: compare setup secrets with constant-time comparison.

Telegram request:

```json
{
  "network": "telegram",
  "type": "telegram_code",
  "code": "12345",
  "password": "optional-2fa-password"
}
```

WhatsApp request:

```json
{
  "network": "whatsapp",
  "type": "whatsapp_pairing_confirmed",
  "displayLabel": "Personal WhatsApp"
}
```

Response 200:

```json
{
  "account": {
    "id": "2bb1df4c-4d60-4ebb-a6e8-4e986e9199e7",
    "network": "telegram",
    "label": "Personal Telegram",
    "status": "connected",
    "lastSyncAt": null
  }
}
```

## GET /api/messages/accounts

Inspect connected accounts.

Auth: Matrix OS user session.

Response 200:

```json
{
  "accounts": [
    {
      "id": "2bb1df4c-4d60-4ebb-a6e8-4e986e9199e7",
      "network": "telegram",
      "label": "Personal Telegram",
      "status": "connected",
      "lastSyncAt": "2026-05-12T12:00:00.000Z",
      "health": "ok"
    }
  ]
}
```

## DELETE /api/messages/accounts/{accountId}

Disconnect an account and stop future sync.

Auth: Matrix OS user session.
Body limit: 4 KiB.

Request:

```json
{
  "retention": "retain_existing"
}
```

`retention` values: `retain_existing`, `delete_synced_messages`.

Response 200:

```json
{
  "accountId": "2bb1df4c-4d60-4ebb-a6e8-4e986e9199e7",
  "status": "disconnected"
}
```

## GET /api/messages/conversations

List bridged conversations and permissions.

Auth: Matrix OS user session.
Query params:

- `network`: optional `telegram` or `whatsapp`.
- `accountId`: optional UUID.
- `cursor`: optional opaque cursor, max 512 chars.
- `limit`: optional integer 1-100, default 50.

Response 200:

```json
{
  "conversations": [
    {
      "roomId": "!abc123:matrix-os.com",
      "network": "telegram",
      "accountId": "2bb1df4c-4d60-4ebb-a6e8-4e986e9199e7",
      "displayName": "Project Chat",
      "conversationType": "group",
      "lastMessageAt": "2026-05-12T12:00:00.000Z",
      "permissions": {
        "readEnabled": false,
        "replyEnabled": false,
        "automationEnabled": false,
        "mentionOnly": true,
        "revision": 1
      }
    }
  ],
  "nextCursor": null
}
```

## PATCH /api/messages/conversations/{roomId}/permissions

Grant or revoke Hermes access.

Auth: Matrix OS user session.
Body limit: 4 KiB.
Concurrency: update must include base revision and enforce it in the write statement.

Request:

```json
{
  "baseRevision": 1,
  "readEnabled": true,
  "replyEnabled": false,
  "automationEnabled": false,
  "mentionOnly": true
}
```

Response 200:

```json
{
  "roomId": "!abc123:matrix-os.com",
  "permissions": {
    "readEnabled": true,
    "replyEnabled": false,
    "automationEnabled": false,
    "mentionOnly": true,
    "revision": 2,
    "updatedAt": "2026-05-12T12:00:00.000Z"
  }
}
```

On revision mismatch, return 409 with a safe `conflict` code.

## POST /api/messages/conversations/{roomId}/reply

Send a user reply or create/send a Hermes-approved reply.

Auth: Matrix OS user session, or trusted internal Hermes capability token mapped to the owner.
Body limit: 64 KiB.

Request:

```json
{
  "source": "hermes",
  "body": "I can make that time.",
  "mode": "send_if_allowed"
}
```

`mode` values: `send_if_allowed`, `draft_if_not_allowed`, `approval_required`.

Internal Hermes token claims:

```json
{
  "ownerId": "user_123",
  "roomId": "!abc123:matrix-os.com",
  "scope": "messages.reply.request",
  "jti": "unique-token-id",
  "exp": 1778587260
}
```

Rules:

- Maximum token TTL is 60 seconds.
- `ownerId` and `roomId` must match the target route and current room mapping.
- Gateway must recheck current `replyEnabled` immediately before sending.
- The token must not grant filesystem, tool, bridge, or appservice access.
- If a model/subagent runs with broad tool permissions, it still cannot bypass this route because the capability is held by the gateway-side Hermes delivery dependency, not by the prompt.

Response 202:

```json
{
  "replyId": "6c7d9e13-5744-4911-9405-c7607984871f",
  "status": "sent",
  "matrixEventId": "$event:matrix-os.com"
}
```

If reply permission is missing, response 202 may return:

```json
{
  "replyId": "6c7d9e13-5744-4911-9405-c7607984871f",
  "status": "approval_required"
}
```

## GET /api/messages/drafts

List pending Hermes or automation replies that require user review.

Auth: Matrix OS user session.
Query params:

- `roomId`: optional Matrix room id.
- `limit`: optional integer 1-100, default 50.
- `cursor`: optional opaque cursor, max 512 chars.

Response 200:

```json
{
  "drafts": [
    {
      "replyId": "6c7d9e13-5744-4911-9405-c7607984871f",
      "roomId": "!abc123:matrix-os.com",
      "source": "hermes",
      "bodyPreview": "I can make that time.",
      "status": "approval_required",
      "createdAt": "2026-05-12T12:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## POST /api/messages/drafts/{replyId}/approve

Approve and send a pending reply.

Auth: Matrix OS user session.
Body limit: 4 KiB.

Request:

```json
{
  "baseStatus": "approval_required"
}
```

Response 202:

```json
{
  "replyId": "6c7d9e13-5744-4911-9405-c7607984871f",
  "status": "sent",
  "matrixEventId": "$event:matrix-os.com"
}
```

Rules:

- Recheck room mapping and `replyEnabled` immediately before send.
- Use the stored reply `clientTxnId` for idempotent Matrix sends.
- If permission is missing, keep the draft pending or return a safe 409.

## POST /api/messages/drafts/{replyId}/cancel

Cancel a pending reply.

Auth: Matrix OS user session.
Body limit: 4 KiB.

Request:

```json
{
  "reason": "user_cancelled"
}
```

Response 200:

```json
{
  "replyId": "6c7d9e13-5744-4911-9405-c7607984871f",
  "status": "cancelled"
}
```

## POST /api/messages/appservice/{network}/events

Trusted local event ingestion path if Matrix OS owns an internal callback between the selected homeserver/bridge stack and the gateway. If the selected homeserver pushes events through a different internal mechanism, this contract still defines the validation and permission behavior.

Auth: trusted local appservice token.
Body limit: 256 KiB for event batches. Media payloads are never sent inline.
Security: appservice token comparison must be constant-time.

Request:

```json
{
  "events": [
    {
      "eventId": "$event:matrix-os.com",
      "externalEventId": "telegram-or-whatsapp-event-id",
      "roomId": "!abc123:matrix-os.com",
      "network": "telegram",
      "accountId": "2bb1df4c-4d60-4ebb-a6e8-4e986e9199e7",
      "type": "message",
      "sender": {
        "displayName": "Ada"
      },
      "content": {
        "kind": "text",
        "body": "Can you review the draft?"
      },
      "occurredAt": "2026-05-12T12:00:00.000Z"
    }
  ]
}
```

`eventId` is always the Matrix homeserver `event_id` and is the canonical idempotency key. `externalEventId` is secondary metadata only.

Response 202:

```json
{
  "accepted": 1,
  "ignored": 0
}
```

Permission behavior:

- Store/display for owner is allowed according to conversation retention policy.
- Hermes delivery requires current `readEnabled`.
- Automation requires current `automationEnabled`.
- Reply generation may create drafts without sending unless `replyEnabled` is current at send time.
- Revocation must cancel queued work and signal active Hermes turns. If a reply send already reached the homeserver before cancellation wins the race, Matrix OS records it as sent and appends a safe audit event.

## GET /api/messages/health

Show coarse homeserver and bridge health.

Auth: Matrix OS user session.
Timeout: 5 seconds.

Response 200:

```json
{
  "homeserver": "ok",
  "networks": [
    {
      "network": "telegram",
      "status": "ok",
      "accountsHealthy": 1,
      "accountsNeedingRelink": 0
    },
    {
      "network": "whatsapp",
      "status": "degraded",
      "accountsHealthy": 0,
      "accountsNeedingRelink": 1
    }
  ]
}
```

## POST /api/messages/recovery/{accountId}

Start safe recovery, restart, or relink flow.

Auth: Matrix OS user session.
Body limit: 4 KiB.

Request:

```json
{
  "action": "relink"
}
```

`action` values: `recheck`, `restart_bridge`, `relink`.

Response 202:

```json
{
  "accountId": "2bb1df4c-4d60-4ebb-a6e8-4e986e9199e7",
  "status": "recovery_started"
}
```

## Contract Tests

Required before implementation:

- Reject unknown network slugs.
- Reject oversized bodies before parsing.
- Reject invalid setup session, expired setup session, and wrong owner.
- Enforce constant-time token helper for appservice/setup secrets.
- Enforce permission revision conflict on concurrent updates.
- Verify revoked permissions prevent Hermes/automation delivery for new and queued events.
- Verify revocation signals cancellation for running Hermes work and cancels unsent drafts/replies.
- Verify in-flight send race is idempotent through `clientTxnId`.
- Verify Hermes internal capability tokens are owner/room/action scoped, expire after 60 seconds, rotate through runtime config, and are not accepted for any other route.
- Verify draft list, approve, and cancel routes are owner-scoped and recheck reply permission before send.
- Verify appservice event dedupe uses Matrix homeserver `event_id`, not external network ids.
- Verify encrypted-room events are blocked from Hermes until the selected E2EE/key-sharing posture is proven and permission-checked.
- Verify restore status can surface `relink_required` for WhatsApp without exposing raw bridge/session errors.
- Verify safe error mapper redacts provider/internal details.
