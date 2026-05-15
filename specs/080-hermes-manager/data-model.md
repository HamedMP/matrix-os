# Data Model: Hermes Manager

## HermesInstallation

- `id`: stable owner-scoped installation ID.
- `ownerId`: Matrix owner user ID.
- `homePath`: redacted owner-scoped Hermes home reference.
- `hermesPath`: redacted Hermes repository/CLI reference.
- `version`: detected Hermes version or `null`.
- `readiness`: `missing | installed | configuring | degraded | ready | updating | needs_attention`.
- `gatewayStatus`: `unknown | stopped | starting | healthy | degraded | failed`.
- `defaultProfileId`: selected Hermes profile ID.
- `defaultModelId`: selected model ID.
- `authorizedOperators`: bounded list of Matrix user IDs, maximum 50.
- `createdAt`, `updatedAt`, `lastCheckedAt`: ISO timestamps.

Validation:

- Owner/operator IDs are bounded Matrix-safe strings.
- Paths are resolved within allowed Matrix owner/Hermes roots and are never returned raw to the browser.
- Readiness transitions must be monotonic for one action result: action start sets `configuring`/`updating`, action finish sets `ready` or `needs_attention`.

## HermesSetupStep

- `id`: stable setup step key.
- `installationId`: parent installation.
- `status`: `pending | active | complete | failed | skipped`.
- `required`: boolean.
- `title`: short display label.
- `detail`: redacted display detail.
- `recoveryAction`: optional action key.
- `updatedAt`: ISO timestamp.

Validation:

- Step IDs are allowlisted by contract.
- Failed steps use generic detail and server logs hold raw diagnostics.

## ModelProviderConnection

- `id`: provider key.
- `installationId`: parent installation.
- `credentialRef`: server-side reference only.
- `configured`: boolean.
- `status`: `unknown | validating | healthy | failed`.
- `defaultModelId`: optional selected model.
- `availableModels`: bounded list of redacted model options.
- `lastCheckedAt`: ISO timestamp or `null`.

Validation:

- Model IDs are bounded provider-safe strings.
- Credentials are never serialized into public DTOs.

## MessagingChannel

- `id`: channel key.
- `installationId`: parent installation.
- `platform`: `telegram | whatsapp | discord | slack | matrix | other`.
- `enabled`: boolean.
- `configured`: boolean.
- `status`: `disconnected | pairing | connected | degraded | disabled | failed`.
- `allowedSenderPolicy`: redacted channel-specific policy summary.
- `homeChannel`: optional redacted target summary.
- `credentialRef`: server-side reference only.
- `lastCheckedAt`: ISO timestamp or `null`.
- `updatedAt`: ISO timestamp.

Validation:

- P1 write actions are limited to Telegram and WhatsApp.
- Unknown future platforms may be listed read-only when reported by Hermes.
- Channel IDs and action payloads are schema-validated at the route boundary.
- Public DTOs keep `id` as the channel resource key and `platform` as the provider family. For P1, mutating route `channelId` values are exactly `telegram` and `whatsapp`; future read-only channel rows may have different `id` values with `platform` set to `discord`, `slack`, `matrix`, or `other`.

## HermesSession

- `id`: Matrix-side session ID.
- `hermesSessionId`: upstream Hermes session reference.
- `installationId`: parent installation.
- `ownerId`: Matrix owner.
- `operatorId`: Matrix operator who started or resumed the session.
- `profileId`: Hermes profile.
- `modelId`: model used by session.
- `status`: `idle | starting | streaming | waiting_approval | stopped | failed | recoverable`.
- `lastEventId`: last retained event ID.
- `clientRequestIds`: last 50 idempotency keys for session creation and prompt submission retries, evicted oldest-first.
- `eventCount`: retained event count.
- `createdAt`, `updatedAt`, `lastActiveAt`: ISO timestamps.

Validation:

- Session references are owner-scoped.
- `clientRequestIds` are bounded to 50 safe IDs per session and retained oldest-first so duplicate creates/prompts can be deduplicated or rejected within the retention window.
- Read paths reconcile stale live stream references and mark sessions recoverable.
- Event retention is capped per session.

## ApprovalPrompt

- `id`: Matrix-side approval ID.
- `hermesApprovalId`: upstream approval reference.
- `sessionId`: parent Hermes session.
- `status`: `pending | approved | denied | expired | failed`.
- `description`: redacted operator-facing action summary.
- `requestedTool`: optional redacted tool name.
- `decisionBy`: Matrix operator ID or `null`.
- `decisionAt`: ISO timestamp or `null`.
- `createdAt`: ISO timestamp.

Validation:

- Pending approval can be resolved once.
- Duplicate decisions are rejected or treated as idempotent if identical and already persisted.

## HermesCapability

- `id`: capability key.
- `installationId`: parent installation.
- `kind`: `profile | skill | toolset | gateway | channel`.
- `name`: display name.
- `enabled`: boolean.
- `status`: `available | missing_setup | disabled | failed`.
- `description`: redacted bounded string.
- `updatedAt`: ISO timestamp.

Validation:

- Capability lists are bounded and sanitized before display.

## OperatorEvent

- `id`: event ID.
- `installationId`: parent installation.
- `actorId`: Matrix actor ID.
- `category`: `setup | credential | channel | session | approval | gateway | update | recovery`.
- `targetId`: optional target ID.
- `severity`: `info | warning | error`.
- `message`: generic redacted message.
- `createdAt`: ISO timestamp.

Validation:

- Retention capped per owner.
- No secret, path, raw provider error, stack trace, or command output fields are allowed.

## Relationships

- One `HermesInstallation` belongs to one Matrix owner.
- One installation has many setup steps, model provider connections, messaging channels, sessions, capabilities, and operator events.
- One session has many retained stream events and approval prompts.
- Credential references point to server-side owner storage and are never dereferenced by app clients.
