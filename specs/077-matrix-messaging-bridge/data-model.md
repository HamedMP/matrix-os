# Data Model: Matrix Messaging Bridge

## Ownership Boundary

All records belong to one Matrix OS owner on one customer VPS unless explicitly extended to org scope in a later feature. Platform services may route, provision, or trigger upgrades, but message content, bridge state, permissions, audit events, and recoverable mappings live in owner-controlled storage.

## Entities

### MessagingNetwork

Represents a supported external messaging network.

| Field | Type | Rules |
|-------|------|-------|
| `slug` | string | Allowlisted slug. First values: `telegram`, `whatsapp`. |
| `displayName` | string | User-facing name. |
| `status` | enum | `available`, `disabled`, `spike-only`, `unsupported`. |
| `setupMode` | enum | `code`, `qr`, `callback`, `manual-relink`. |
| `supportsMedia` | boolean | True only after media path limits are defined. |
| `supportsBackfill` | boolean | True only when capped/resumable backfill is proven. |

### ConnectedAccount

Owner-linked account on Telegram or WhatsApp.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Server-generated. |
| `ownerId` | string | Canonical Matrix OS owner principal. |
| `networkSlug` | string | `telegram` or `whatsapp` in first scope. |
| `userVisibleLabel` | string | Sanitized, max 120 chars. No phone/email leakage unless user explicitly supplied it as label. |
| `status` | enum | `setup_pending`, `connected`, `relink_required`, `disconnecting`, `disconnected`, `unhealthy`. |
| `bridgeRuntimeId` | string | Internal bridge instance reference, not exposed raw to clients. |
| `lastSyncAt` | timestamp | Nullable. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |
| `disconnectedAt` | timestamp | Nullable. |
| `revision` | integer | Optimistic concurrency for status and retention updates. |

### SetupSession

Short-lived owner-bound linking session.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Public setup id; not sufficient as secret. |
| `ownerId` | string | Must match current request principal. |
| `networkSlug` | string | Allowlisted. |
| `secretHash` | string | Stored hash only. Raw setup secret never logged or returned after creation. |
| `state` | enum | `pending`, `completed`, `expired`, `cancelled`, `failed`. |
| `expiresAt` | timestamp | 10 minutes after creation. |
| `completedAt` | timestamp | Nullable. |
| `metadata` | JSONB | Network-specific, schema-validated, redacted. |

State transitions:

```text
pending -> completed
pending -> expired
pending -> cancelled
pending -> failed
failed -> expired
```

### MatrixConversation

Owner-visible Matrix room representing a direct or group conversation from a connected account.

| Field | Type | Rules |
|-------|------|-------|
| `roomId` | string | Matrix room id, validated at route boundary. |
| `ownerId` | string | Owner principal. |
| `connectedAccountId` | UUID | FK to ConnectedAccount. |
| `networkSlug` | string | Duplicated for query/index efficiency. |
| `displayName` | string | Sanitized, max 160 chars. |
| `conversationType` | enum | `direct`, `group`, `channel`, `unknown`. |
| `externalConversationId` | string | Bridge-provided id, stored redacted from clients unless safe. |
| `lastProcessedEventId` | string | Idempotency cursor. |
| `lastMessageAt` | timestamp | Nullable. |
| `retentionState` | enum | `active`, `disconnected_retained`, `delete_pending`, `deleted`. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |

Unique constraint: `(ownerId, networkSlug, connectedAccountId, externalConversationId)`.

### ConversationMapping

Durable bridge mapping between Matrix and external network identifiers.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Server-generated. |
| `ownerId` | string | Owner principal. |
| `roomId` | string | FK to MatrixConversation. |
| `networkSlug` | string | `telegram` or `whatsapp`. |
| `externalConversationId` | string | Required. |
| `bridgeGhostUserIds` | string[] | Bridge-controlled Matrix users; capped length. |
| `bridgeBotUserId` | string | Nullable. |
| `lastExternalCursor` | string | Nullable; redacted in exports unless needed for recovery. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |

### HermesPermission

Room-level policy for AI and automation access.

| Field | Type | Rules |
|-------|------|-------|
| `ownerId` | string | Owner principal. |
| `roomId` | string | Matrix room id. |
| `readEnabled` | boolean | Defaults false. |
| `replyEnabled` | boolean | Defaults false. |
| `automationEnabled` | boolean | Defaults false. |
| `mentionOnly` | boolean | Defaults true when read is enabled unless user chooses always-on. |
| `grantedBy` | string | Owner principal that made change. |
| `revokedAt` | timestamp | Nullable. |
| `revision` | integer | Required optimistic concurrency. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |

Rules:

- New conversations create no effective Hermes access.
- Reply requires read or explicit reply approval flow.
- Automation requires `automationEnabled`; read-only permission is insufficient.
- All updates must be transactional with audit event creation.

### AutomationRule

User-created rule that observes permitted messages and performs Matrix OS actions.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Server-generated. |
| `ownerId` | string | Owner principal. |
| `name` | string | Max 120 chars. |
| `scope` | enum | `room`, `network`, `account`, `all-permitted`. |
| `roomId` | string | Required for room scope. |
| `trigger` | JSONB | Schema-validated; bounded. |
| `action` | JSONB | Discriminated union by action type. |
| `status` | enum | `enabled`, `paused`, `disabled`. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |

### MessagingAuditEvent

Append-only audit record for sensitive messaging actions.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Server-generated. |
| `ownerId` | string | Owner principal. |
| `type` | enum | `permission_changed`, `automation_triggered`, `ai_reply_created`, `ai_reply_sent`, `account_connected`, `account_disconnected`, `bridge_health_changed`, `setup_failed`, `recovery_started`. |
| `networkSlug` | string | Nullable. |
| `roomId` | string | Nullable. |
| `connectedAccountId` | UUID | Nullable. |
| `actor` | enum | `owner`, `hermes`, `automation`, `system`, `operator`. |
| `safeSummary` | string | Redacted, max 500 chars. |
| `metadata` | JSONB | No tokens, phone numbers, emails, QR payloads, raw provider errors, file paths, or DB errors. |
| `createdAt` | timestamp | Required. |

### BridgeEventCursor

Idempotency and replay protection for appservice events.

| Field | Type | Rules |
|-------|------|-------|
| `ownerId` | string | Owner principal. |
| `networkSlug` | string | Required. |
| `roomId` | string | Nullable for account-level events. |
| `eventId` | string | Canonical Matrix homeserver `event_id`. Required. |
| `externalEventId` | string | Bridge or external-network event id, nullable secondary metadata. |
| `eventHash` | string | Optional dedupe guard. |
| `processedAt` | timestamp | Required. |
| `effect` | enum | `stored_only`, `sent_to_hermes`, `automation_queued`, `reply_sent`, `ignored`. |

Unique constraint: `(ownerId, networkSlug, eventId)`.

Rule: the Matrix homeserver `event_id` is the primary idempotency key. Bridge-local ids, WhatsApp message ids, Telegram update ids, and content hashes are secondary diagnostics and must not replace the homeserver event id for replay protection.

### OutgoingReply

User or Hermes-generated message pending send or already sent.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Server-generated. |
| `ownerId` | string | Owner principal. |
| `roomId` | string | Required. |
| `source` | enum | `user`, `hermes`, `automation`. |
| `status` | enum | `draft`, `approval_required`, `sending`, `sent`, `failed`, `cancelled`. |
| `body` | string | Bounded text; sanitized for display. |
| `permissionRevision` | integer | Permission revision observed when reply was created. |
| `clientTxnId` | string | Stable idempotency key for Matrix send; unique per owner/reply. |
| `matrixEventId` | string | Nullable. |
| `failureCode` | enum | Nullable coarse code only. |
| `cancelReason` | enum | Nullable: `user_cancelled`, `permission_revoked`, `send_failed`, `stale_room_mapping`. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |

State transitions:

```text
draft -> approval_required -> sending -> sent
draft -> sending -> sent
sending -> failed
draft -> cancelled
approval_required -> sending
approval_required -> cancelled
sending -> cancelled
failed -> draft
```

Rules:

- `sending -> cancelled` is allowed only before the homeserver accepts the Matrix send. If the homeserver already accepted the send, the record becomes `sent` and revocation is recorded as a follow-up audit event.
- Every send uses `clientTxnId` so retry after timeout does not duplicate outbound messages.
- Every Hermes/automation reply must recheck current permission and room mapping immediately before changing to `sending`.

### HermesWorkItem

Cancelable work handed to Hermes or automation.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Server-generated. |
| `ownerId` | string | Owner principal. |
| `roomId` | string | Required. |
| `sourceEventId` | string | Canonical Matrix homeserver `event_id`. |
| `kind` | enum | `summarize`, `classify`, `draft_reply`, `automation`. |
| `status` | enum | `queued`, `running`, `completed`, `cancel_requested`, `cancelled`, `failed`. |
| `permissionRevision` | integer | Permission revision observed at enqueue time. |
| `abortTokenId` | string | Internal cancellation handle, never exposed to prompts or clients. |
| `createdAt` | timestamp | Required. |
| `updatedAt` | timestamp | Required. |

Rules:

- Permission revocation marks queued work `cancelled` and running work `cancel_requested` in the same transaction as the permission update.
- Hermes delivery must receive an abort signal keyed by `abortTokenId`, but the token itself must not be exposed to model prompts or subagents.

## Transaction Boundaries

- Account connect completion: complete setup session, create/update connected account, create audit event in one transaction after bridge confirms link success.
- Permission change: update HermesPermission with `WHERE revision = :baseRevision`, append MessagingAuditEvent, invalidate queued Hermes/automation work for revoked room in one transaction.
- Event ingestion: upsert conversation mapping, insert BridgeEventCursor, store visible message pointer, enqueue Hermes/automation work only after permission check in one transaction.
- Disconnect: mark account disconnecting/disconnected, update conversation retention state, append audit event, and stop future sync in a transaction where database state changes are local. External bridge shutdown runs outside the DB transaction and records coarse result afterward.
- Reply send: create/update OutgoingReply and reserve `clientTxnId` in a transaction, then perform the external Matrix send outside the transaction with timeout. After send returns, update status to `sent` with `matrixEventId` or `failed` with a coarse code.
- Revocation: update permission revision, append audit event, cancel queued HermesWorkItems, request cancellation for running HermesWorkItems, and cancel unsent OutgoingReply rows in one transaction. Any reply already accepted by the homeserver is not rewritten; it is audited as an accepted race.

## Export And Delete

- Export includes connected account labels/status, conversation mappings, permission records, audit events, retained message pointers, and user-selected message history.
- Delete removes active setup sessions, connected-account metadata, permissions, automations, retained message content, and media/cache records according to the selected retention policy.
- Raw bridge credentials, setup secrets, QR payloads, and internal appservice tokens are never exported as user-readable text.
