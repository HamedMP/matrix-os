# Gmail Pipedream attempt receipts

ENG-355: https://linear.app/matrix-os/issue/ENG-355/prepare-gmail-oauth-verification-and-casa-evidence

## Boundary and evidence

Gmail-only continuation of U3/U5. Preserve direct Matrix OAuth and every other legacy integration. Do not infer fresh consent from an upsert clock, account `updated_at`, health, a browser redirect, or a previously active connection. Each supported Gmail Pipedream start returns its own opaque `attemptId`; clients observe only that receipt.

Official sources:
- https://pipedream.com/docs/connect/api-reference/create-connect-token: `webhook_uri`, user-scoped token and expiry.
- https://pipedream.com/docs/connect/webhooks: `CONNECTION_SUCCESS`, `connect_token`, environment and nested account identity. The documented HMAC section concerns trigger webhooks; it does not establish connection-webhook authentication.
- https://pipedream.com/docs/connect/managed-auth/tokens: user/environment scope and single-use tokens.
- https://pipedream.com/docs/connect/managed-auth/connect-link: redirects are navigation, not signed completion receipts.

Installed `@pipedream/sdk` 2.4.3 exposes `webhookUri`; `tokens.validate()` proves validity, not completion. Account metadata has no consent revision. An intercepted SDK serialization spike passed on 2026-10-21 without network or real credentials before implementation (permanent regression: `tests/integrations/pipedream-sdk-webhook-serialization.test.ts`). This is wire serialization evidence, not live Pipedream delivery evidence. Ignore `connect_session_id`; its documented numeric example exceeds JavaScript integer precision and is not an identity source.

## Auth and route design

| Route | Authority | Public |
|---|---|---|
| Existing `POST /api/integrations/connect` for Gmail Pipedream | Existing authenticated owner and deletion mutation guard | No |
| `GET /api/integrations/gmail/pipedream/attempts/:attemptId` | Existing authenticated owner; exact UUID; coarse receipt only | No |
| `POST /api/integrations/gmail/pipedream/callback` | Separate server-only 256-bit nonce + token hash; owner/external-user/app/environment binding; provider account verification; existing deletion admission | Exact POST only |

`GMAIL_PIPEDREAM_ATTEMPTS_ENABLED=true` opts the platform into this protocol. Startup also requires `GMAIL_PIPEDREAM_CALLBACK_LOGGING_EXCLUDED=true`, a trusted operator attestation after verifying infrastructure exclusions for the exact callback path in Cloud Run request logs and every access/trace sink. This environment value is not evidence itself. No current exclusion is verified; both flags default false and pilot activation remains blocked until root obtains the configuration evidence. Require a trusted HTTPS `PLATFORM_PUBLIC_URL` origin configured for the platform app domain. Construct the exact callback path from that origin; never derive it from request headers, a user redirect, or a VPS URL. A configured but invalid origin fails startup. An unconfigured legacy/local runtime keeps its existing protocol and returns no receipt; clients use existing reconciliation there.

Return the public UUID separately from the webhook nonce. The callback URI sent only to Pipedream contains both the attempt ID and secret proof. Never return that URI, proof, raw token or hashes from metadata/status endpoints or tool results; application logs omit them. Cloud Run request logs can automatically record the URL: application redaction alone is insufficient. The browser already receives the provider Connect URL; possession of its token alone must not authenticate the callback.

## Durable state and atomicity

Use the shared platform-owned PostgreSQL/Kysely integration database. Store a nonce hash, token hash, owner/external-user, app (`gmail`), environment, optional explicit label, expiry and terminal receipt. Prepare before issuing a provider token; activate before returning the Connect URL. Limit pending/retained attempts per owner and globally, expire them and sweep periodically. Timers and in-flight sweeps drain before the owning database closes. Tokens never persist in plaintext.

The authenticated callback must match stored nonce and token in constant time, validate the modern bounded payload and verify the exact provider account via credentials-free account metadata (owner, Gmail app, healthy and not dead). Provider calls have timeouts and no retries. An invalid callback does not consume an attempt. A duplicate completed callback is idempotent. An old attempt can update only its own receipt, never a later attempt.

Run persistence through existing account-deletion webhook admission. If admission declines a late grant, retain no account projection and end the receipt safely. Complete receipt and canonical connection upsert in one database transaction with row locks, preserving IDs and existing labels unless this exact attempt supplied an explicit label. Unknown scopes preserve existing scopes. No raw credential fetch, provider write, new bot grant or action approval is introduced. Status returns only `pending`, `succeeded` with canonical account ID, `failed` or `expired` for its authenticated owner.

## Client and agent behavior

When an attempt ID exists, Web Canvas, Web Desktop and Web Mobile (shared web screen), Electron Desktop, Native Mobile and owner agent helpers must poll/read that exact attempt. Account timestamps cannot complete it. Keep current runtime/identity, cancellation and attempt-generation guards. Native Matrix connections and legacy responses without receipts retain their existing behavior. Reconcile inventory after success and identify the returned canonical account; report failed/expired attempts with safe generic copy.

## Verification and remaining live gate

Test first: SDK wire serialization; exact public routing; real PostgreSQL receipt lifecycle; owner/app/environment/token/nonce mismatches; duplicate and stale callbacks; two simultaneous attempts; expiry/caps/cleanup; provider error/unhealthy account; atomic rollback; deletion admission; same-ID active reconnect without fabricated timestamps; all client receipt paths. Run relevant regression tests and type checks, React Doctor for changed React projects, and canonical production shell build.

The store migrates and sweeps expired records on every platform startup, including when receipt creation is disabled. Retention is capped at ten minutes plus the five-minute sweep interval while the service is running; startup immediately removes expired rows after downtime. Disabling the flag removes the receipt routes and rejects callbacks/status; clients already holding an attempt ID must report unavailable/expired rather than fall back to inventory or timestamp completion.

No live Connect token, OAuth, mailbox, account mutation, deployment or publication is authorized in this unit. Exact-version modern callback delivery (including server-only URI handling), user-completed OAuth and five-surface screenshots/recordings remain required before release qualification. Existing [public-site PR287](https://github.com/FinnaAI/matrix-os-site/pull/287) documents the connection/reconnect journey; this internal receipt implementation does not require a separate site change. Root owns the final Google evidence packet.
