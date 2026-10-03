# Direct WhatsApp Cloud API pilot

Matrix uses one business-owned WhatsApp Cloud API number. A user messages that number, receives a linking URL, signs into Matrix, and confirms a separate code delivered in WhatsApp. Subsequent text messages reach one persistent canonical Matrix Chat on that owner's running primary VPS. The Chat remains available through Matrix's usual clients.

The deployment is opt-in. Operator residence does not establish recipient eligibility: this pilot requires an explicitly admitted EEA phone number or EEA business-scoped user ID (BSUID). Review current [WhatsApp Business Solution terms](https://www.whatsapp.com/legal/business-solution-terms) and [messaging policy](https://business.whatsapp.com/policy) before expanding availability. Text is supported; media, groups, templates, and proactive messages are outside this pilot. Free-form replies stop when the inbound message's 24-hour customer-service window expires.

## Secret Manager and deployment

Provision the following secrets in the platform's Google Cloud project. Grant the existing Cloud Run runtime service account `roles/secretmanager.secretAccessor` on each secret. Keep secret values out of GitHub variables, source files, commands recorded in support tickets, and public documentation.

| Runtime name | Secret Manager name | Version |
| --- | --- | --- |
| `WHATSAPP_APP_SECRET` | `whatsapp-app-secret` | `latest` |
| `WHATSAPP_VERIFY_TOKEN` | `whatsapp-verify-token` | `latest` |
| `WHATSAPP_ACCESS_TOKEN` | `whatsapp-access-token` | `latest` |
| `WHATSAPP_PHONE_NUMBER_ID` | `whatsapp-phone-number-id` | `latest` |
| `WHATSAPP_GRAPH_API_VERSION` | `whatsapp-graph-api-version` | `latest` |
| `WHATSAPP_ENCRYPTION_KEY` | `whatsapp-encryption-key` | Pinned numeric version |
| `WHATSAPP_PUBLIC_URL` | `whatsapp-public-url` | `latest` |
| `WHATSAPP_ALLOWED_SENDERS` | `whatsapp-allowed-senders` | `latest` |

`WHATSAPP_PUBLIC_URL` is the HTTPS Matrix application origin serving both account linking and owner-authenticated runtime proxy requests. Do not use an internal worker URL, a different Clerk environment, a path, or a URL with credentials. `WHATSAPP_GRAPH_API_VERSION` must explicitly match the supported Graph version selected for the Meta app; Matrix supplies no default. The phone number ID is Meta's numeric resource ID, distinct from the display phone number.

The encryption key is exactly 32 random bytes encoded as 64 hexadecimal characters. Set the GitHub deployment environment variable `WHATSAPP_ENCRYPTION_KEY_VERSION` to its numeric Secret Manager version; it defaults to `1`. Retain that version while encrypted jobs remain. This change does not implement concurrent key rotation or key-ring decryption. Rotate only through a separately reviewed drain/migration procedure.

The allowed-sender secret contains at most 100 comma-separated identifiers. Phone identifiers use international digits, with an optional leading `+` in configuration. BSUID identifiers use an uppercase ISO country code, a period, and up to 128 alphanumeric characters. Only EEA identifiers pass pilot admission. An incoming signed event can associate an eligible BSUID with an explicitly admitted phone number. Subsequent events from an existing verified BSUID association remain usable when WhatsApp no longer supplies the phone number. Do not treat a WhatsApp username or a Matrix profile phone field as account proof.

Set GitHub environment variable `WHATSAPP_ENABLED=true` only for the reviewed deployment environment. It defaults to `false` everywhere. When disabled, the workflow mounts none of the eight configuration secrets; absence disables the feature. Partial configuration fails startup. An enabled deployment preflights all eight secrets, validates configuration without printing values, and verifies runtime access. Updating only the live Cloud Run service is insufficient: preserve the opt-in GitHub variable and Secret Manager entries so the next normal deployment retains the integration.

The web service validates and enqueues incoming events with background workers disabled. The private singleton platform worker inherits the same candidate image, database, and secret bindings, enables background workers, and keeps CPU allocated outside HTTP requests. Candidate, production, and worker revisions verify the complete configuration before promotion. The deployment shell logic lives in `scripts/ci/platform-whatsapp-env.sh` to keep new behavior out of the already large workflow composition file.

## Meta setup and a live test

1. Select the Matrix-owned Meta developer app and business portfolio. Add WhatsApp Cloud API and use its test number initially.
2. Store the app secret and a random webhook verification token in Secret Manager. Use an access token with the required WhatsApp messaging permission. Dashboard-generated temporary tokens expire; replace them with an appropriately scoped durable business credential before treating the integration as continuously available. Publish a new secret version and deploy the reviewed revision to refresh mounted credentials.
3. Configure the callback as `https://<application-origin>/whatsapp/webhook` and use the stored verification token. Subscribe the app/business account to the `messages` webhook field. GET verification proves callback ownership; POST deliveries require `X-Hub-Signature-256` computed with the app secret over the original request body.
4. Add the pilot recipient to Meta's test-number recipient list and complete Meta's recipient verification. Admission also requires the separate Matrix allowed-sender secret. A Meta test number is restricted to configured recipients; a production number, business setup, applicable verification, and app readiness are needed before wider access.
5. Message the test number from the admitted WhatsApp account. Open the returned Matrix link, sign in, read the agent-access disclosure, and enter the six-digit code delivered in WhatsApp. Successful confirmation queues a WhatsApp acknowledgement with the connection in the same transaction. It confirms account linking; agent readiness is checked when a fresh request arrives. The link expires after ten minutes and confirmation locks after five wrong attempts. A forwarded URL alone cannot establish another owner's association.
6. Send a fresh text request. Verify that the reply arrives from the business number and the same turn appears in the linked owner's canonical Matrix Chat. Verify another owner cannot view that Chat. Replay the same signed webhook and verify it does not create another turn or send another reply.
7. Send `STOP` or `/disconnect`, then verify the association is removed and queued work cannot start new agent actions for it. The existing Matrix Chat remains available. `HELP` provides human-support information. The authenticated connection page also supports disconnecting.

Linking records explicit versioned owner consent (`whatsapp-general-agent-v1`). The disclosure covers the owner's general Matrix agent and the access it may have to files, commands, tools, and changes on the primary VPS. A request initiated through WhatsApp follows the selected runtime's supported permissions; full access is considered only after this consent is persisted. Waiting approvals or questions return the user to Matrix. Channel code cannot create a general-purpose capability merely by selecting a coding harness.

The upcoming Matrix Pi general agent is a separate runtime feature. Delivery selects a ready `system_agent` from the authoritative runtime catalog. A restricted Pi coding harness does not qualify. Missing agent readiness, entitlement, or primary runtime availability fails closed; no other owner's machine or credential supplies a fallback.

The existing Chat remains bound to its harness after its first turn; introducing a different general agent requires an explicit supported migration rather than silently changing its binding. WhatsApp and Matrix clients read the same canonical Chat. The current Telegram adapter still keeps a channel-specific session, so this pilot does not establish one shared conversation across every messaging channel.

## Delivery, retention, and recovery

Incoming message IDs deduplicate in platform Postgres. Message/control payloads are encrypted with AES-GCM while queued; canonical Chat history remains in the owner's runtime database. Terminal jobs erase encrypted content. Jobs expire no later than the 24-hour reply window, expired challenges are removed, and terminal deduplication records are removed after seven days during recurring cleanup. Platform queue metadata is operational delivery state, not a second conversation history.

Connection acknowledgements use the same durable delivery queue. They have up to ten minutes after confirmation for delivery, capped by the original reply window retained in the encrypted proof. Proofs issued before this deadline was persisted conservatively retain their challenge expiry. Delivery rechecks the verified association; disconnect suppresses pending acknowledgements. A persistence or queue-capacity failure rolls back confirmation, leaving the unexpired proof retryable; the capacity response asks users to retry the current step. A confirmation already handed to Meta may still arrive after disconnect, and an ambiguous send is not replayed.

Leases and fences prevent stale workers from acknowledging newer claims. The sender's queue preserves order. Disconnect revokes the association and invalidates pending work. Dispatch checks consent and refreshes its fence after preparing the Chat and model catalog, immediately before submitting the turn. Admission already in progress at that final check can continue: the platform database and remote runtime cannot commit atomically, and disconnect cannot undo an accepted tool action. Future replies for the revoked connection are suppressed. Replaying an inbound event uses stable canonical Chat request IDs to avoid a duplicate turn.

Processing reactions use Meta's reaction-message API on the original inbound message ID. A current fenced job sends `👀` before agent admission; after the completed text reply is accepted and the job finishes, it sends `✅`, or `❌` for attention/exhausted failures. Incoming reaction events do not create agent turns. Reaction calls have a 1.5-second deadline, no transport retries, and logged nonfatal failures. The current association is checked again before each reaction. Disconnect suppresses future updates but cannot retract a reaction already handed to Meta. A crash after text completion or an unsuccessful reaction call may leave an earlier emoji visible; cosmetic recovery must never replay a response or restart agent work.

An HTTP rejection from Meta is a definitive send failure. A timeout, broken connection, or malformed successful response leaves delivery uncertain: Meta may already have accepted the message. Matrix records an ambiguous outcome and does not blindly resend it. Use the canonical Matrix Chat to inspect an agent result, or send a new message deliberately. Do not promise exactly-once delivery at the external network boundary.

Before declaring a pilot live, verify the public callback, recipient setup, token validity, both Cloud Run roles, owner linking, canonical Chat appearance, reply delivery, and disconnect behavior. Unit tests with fetch doubles establish contracts; they do not prove Meta permissions, webhook subscription, or production delivery.
