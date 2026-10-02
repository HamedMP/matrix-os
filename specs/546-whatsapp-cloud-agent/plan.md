---
status: active
---

# Direct WhatsApp access to Matrix

One Matrix-owned Cloud API number accepts a user's message, replies with a short-lived linking URL, and links that WhatsApp sender to a Clerk-authenticated Matrix owner after a second proof delivered in WhatsApp. Subsequent text messages reach one persistent general Matrix Chat on that owner's primary VPS. Each owner's agent, data, permissions, and funding remain private. The transport does not provision the upcoming Matrix Pi worker; the currently available system-agent catalog is authoritative and the restricted Pi coding harness is not a substitute.

## Scope and decisions

- Direct Meta Cloud API, no intermediary and no personal-account QR session.
- Pilot admits an explicit configured sender allowlist. General AI availability follows recipient market eligibility, not the operator's location. Start with EEA-number recipients, keep policy admission explicit.
- Text first. Other message types receive a clear text-only response. No proactive messages outside Meta's 24-hour reply window, no template or media implementation in this change.
- One canonical Chat per linked owner and runtime. Use existing owner-authenticated Chat APIs and stable request IDs. Do not add an alternative conversation store.
- Account linking is not inferred from profile phone numbers. Token possession plus Clerk login plus a code delivered to WhatsApp are required. Expiring, single-use tokens and bounded attempts prevent replay and forwarded-link hijacking. Existing associations cannot be reassigned silently.
- Platform Postgres holds identity/routing, encrypted transient jobs, and deduplication metadata. Canonical transcripts live in owner Postgres. Content is erased on completion and recurring expiry cleanup. Disconnect revokes pending work.
- Durable jobs use database leases and fencing. Agent requests are idempotent; ambiguous outbound sends are recorded and not automatically resent. Per-sender order is serialized. Shutdown stops claims and drains active work before closing the shared pool.

## Auth matrix

| Route | Auth | Public |
| --- | --- | --- |
| GET /whatsapp/webhook | Constant-time Meta verify-token comparison | Challenge only |
| POST /whatsapp/webhook | Raw-body HMAC with Meta app secret, matching configured phone ID, bounded body | Signed Meta events |
| GET /whatsapp/connect | Public branded login page; token grants no owner access | Yes |
| POST /api/whatsapp/claim | Clerk Bearer token, exact configured Origin, bounded token schema | No |
| POST /api/whatsapp/confirm | Same plus token and bounded code | No |
| GET /api/whatsapp/connection | Clerk Bearer | No |
| DELETE /api/whatsapp/connection | Clerk Bearer, exact Origin, bodyLimit | No |
| Owner VPS canonical Chat APIs | Fresh owner-scoped sync JWT, authoritative running primary VPS, runtime policy | No |

All mutating routes have bodyLimit before reads. Responses use generic errors. Every external request has a timeout and rejects redirects. Phone numbers, message IDs, Graph versions, and tokens are validated. No user-controlled outbound URLs. New functionality is extracted into focused modules; main.ts and platform-startup.ts receive only registration/lifecycle calls rather than inline behavior.

## Review stack

Ship two dependent PRs, each below the repository's 3,000-added-line limit:

1. `feat(platform): add durable WhatsApp Cloud API foundation`: U1/U2 configuration, transport, encryption, repository, migrations and their matching tests. No active endpoint or worker wiring.
2. `feat(platform): connect WhatsApp to private Matrix agents`: U3/U4 client, linking surface, lifecycle, deployment contract and cross-layer tests, based on the foundation. Includes the reserved `matrix_pi` contract identifier so a future runtime-advertised general Pi route parses without activating that harness.

Deleted owner Chats are replaced only after the owner-authenticated gateway returns the canonical `chat_not_found` response. Generation-specific create keys and connection/runtime/previous-Chat compare-and-swap protect retry and association races. Failed persistence responses retain the lease for recovery rather than overwriting an uncertain committed checkpoint. Malformed webhook events return 400; operational parser/read failures are logged privately and return retryable 503; body limits remain 413.

## Implementation units

### U1: Durable linking and delivery repository

Goal: Persist sender proof, owner association, bounded encrypted jobs, replay protection and fenced leases.
Files: Create packages/platform/src/whatsapp/repository.ts, repository-types.ts, crypto.ts; database/migrations/whatsapp.ts. Modify database/migrate.ts and migration-revision.ts. Test tests/platform/whatsapp-repository.test.ts and migration revision suite.
Approach: Kysely using platform's injected shared connection (never close it). Transaction/row locks for linking and disconnect. Unique sender and owner links. AES-GCM content encryption with configured 32-byte key. Job ID is Meta message ID (or deterministic control reply ID); stored payload is JSON ciphertext. Lease ready jobs in sender order with fencing token; terminal states erase content. Expiry sweep deletes challenges and old dedup records, caps active backlog.
Execution note: test-first; write tests, request orchestrator's red run, then implement. Do not run the shared suite yourself.
Patterns to follow: database/migrations/checkout.ts; tests/platform/platform-db-test-helper.ts; Kysely transaction wrappers.
Test scenarios: forwarded token cannot finish without code; token expiry and replay; five wrong codes block; owner/sender reassignment conflict; concurrent claim and confirm; duplicate Meta ID; sender ordering; expired lease recovery; stale fence cannot update; disconnect revokes; ciphertext contains no message; completion clears payload; bounded backlog and cleanup.
Verification: actual PGlite-backed migrations/repository tests including rollback and concurrent claims.
Interface: export createWhatsAppRepository(db,key,now?) with enqueue({id,sender,payload,expiresAt}), lease(), checkpoint(id,fence,payload), finish(id,fence,status), retry(id,fence,delayMs), cleanup(), getConnection(owner), disconnect(owner), startLink(sender,requestId), claim(token,owner), confirm(token,owner,code). startLink returns raw token only to its caller; claim returns maskedSender plus a code only internally for delivery; confirm never returns the sender except internal connection. Jobs expose {id,sender,payload,fence,attempts,expiresAt}. Connection has {owner,sender,chatId,machineId}; bindChat(owner,sender,machineId,chatId) compares existing runtime and association.

### U2: Meta Cloud transport

Goal: Verify and normalize official incoming events and send bounded text replies.
Files: Create packages/platform/src/whatsapp/cloud-api.ts and config.ts. Test tests/platform/whatsapp-cloud-api.test.ts.
Approach: Typed config from env requiring app secret, verify token, access token, phone number ID, Graph version, encryption key, public URL and allowed senders. Missing config disables feature; partial config is an error. Verify raw HMAC before JSON. Parse bounded Zod envelopes, ignore status updates, handle multiple messages, match phone_number_id, validate sender/IDs/timestamp/type. Export normalized {id,sender,text,type,timestamp} messages. sendText handles API errors generically and distinguishes definitive rejection from ambiguous outcome; never retry automatically.
Execution note: test-first; request orchestrator red before implementation. Do not run shared suite.
Patterns: Hono webhook routes' raw body validation; Zod v4; bounded fetch with AbortSignal.timeout and redirect:error.
Test scenarios: wrong/missing/malformed HMAC, unicode payload bytes, other number rejected, status-only event, multiple messages, text limits, old/future timestamps, denied sender, malformed upstream response, timeout, no secret in errors, Graph version validation, incomplete config.
Verification: targeted transport tests using recorded-schema fixtures and fetch doubles, no live send.
Interface: readWhatsAppConfig(env) returns undefined or config; verifyWhatsAppSignature(raw:string,signature:string|undefined,secret:string):boolean; parseWhatsAppMessages(raw,phoneNumberId) yields normalized events; sendWhatsAppText(config,to,text,fetchImpl?) returns message ID; class WhatsAppSendError has ambiguous:boolean. Config fields use appSecret,verifyToken,accessToken,phoneNumberId,graphVersion,encryptionKey,publicUrl,allowedSenders (array). Export admission helper to check allowed sender and reply-window timestamp.

### U3: General agent canonical Chat client

Goal: Route incoming text to the existing general Matrix system agent and project final replies without a second transcript store.
Files: Create packages/platform/src/whatsapp/agent-client.ts. Test tests/platform/whatsapp-agent-client.test.ts.
Approach: Inject authoritative owner target resolver returning {machineId,gatewayUrl,token}; gatewayUrl is server-owned and JWT freshly minted. Validate provider/detail/admission using contracts. Only runnable system-agent driver descriptors, never infer full Pi capability from a coding harness. Persist one Chat using deterministic clientRequestId and stable turn request IDs. Before admission, durably save the validated request and original machine/Chat generation in the encrypted job. After uncertainty, replay the original hash-bearing fields through canonical indexed admission recovery; only the revision may refresh. Do not reselect a model, scan unbounded history, or replace a missing Chat for an uncertain admission. An unknown checkpoint response leaves the lease for recovery before any dispatch. start request returns checkpoint {machineId,chatId,runId}; poll only that run's resulting assistant messages. Revisions obtained fresh before admission. Permission/interaction modes derive from runtime catalog; do not grant bypass/auto approval. Waiting approvals/user questions point to Matrix Chat. All requests bounded, no redirects, no raw error output.
Execution note: test-first; request red before implementation. Do not run shared suite.
Patterns: contracts/canonical-chat.ts and canonical-chat-provider.ts; gateway/chat/routes.ts; sync-jwt.ts.
Test scenarios: kernel route selected; coding Pi rejected; unavailable catalog fails closed; idempotent retries; owner/runtime mismatch; only current run replies; waiting input; aborted/failed run; no provider errors leaked; timeout/response limits.
Verification: client tests with exact contract fixtures. Root integration test crosses webhook, repository and this client, fake external boundaries only.
Interface: createWhatsAppAgentClient(resolveTarget,fetchImpl?) exposing start({owner,sender,messageId,text,chatId?,machineId?}) -> {machineId,chatId,runId}; poll(owner,checkpoint) -> {state:'pending'|'complete'|'attention',text?}. User-visible attention text uses public Matrix URL from root.

### U4: Integration, linking surface and lifecycle (orchestrator)

Goal: Wire verified webhook -> durable repository -> private canonical Chat -> WhatsApp reply, plus secure account linking.
Files: packages/platform/src/whatsapp/{service,routes,connect-page,startup}.ts; small hooks main.ts/platform-startup.ts; tests/platform/whatsapp-integration.test.ts. Operator setup under docs/dev/ and env sample names.
Approach: Routes mount before session-routing middleware. Public branded Clerk page uses Bearer-only calls with exact Origin, code confirmation and disconnect. Claim queues verification code with deterministic outbox ID transactionally. Worker ticks with bounded serial concurrency, no overlapping intervals, fenced checkpoints before side effects, old events rejected, unsupported types and support contact handled, logged generic failures. Start in production bootstrap, shutdown before DB destruction. Config gated pilot remains off until secrets/setup and review are complete.
Execution note: test-first integration and route/lifecycle tests.
Patterns: device-approval-page.ts and auth-routes.ts brand/Clerk setup; platform-startup shutdown resource owners.
Test scenarios: signed bot message returns linking URL; authenticated linking + WhatsApp code; next message creates canonical Chat and reply; replay yields no second reply; unauth/foreign Origin denied; disconnected jobs never reach agent; 24h expiry stops replies; disabled routes don't affect platform; cleanup and shutdown.
Verification: targeted new tests, relevant existing platform migration/auth/startup tests, platform typecheck, live Meta test after configured number and reviewed deployment.

### U5: Shipping and public documentation

Goal: Reviewable implementation PR and separate public docs PR in FinnaAI/matrix-os-site content/docs.
Files: Public doc source in that repository only; this spec and private-free operator instructions here.
Approach: Conventional PR with invariants, tests and exact remaining live setup requirements. Greptile 5/5 and ready-for-ci label. No fleet rollout or pretend live success. Document shared-number linking, supported markets/text limits, disconnect, owner Chat and Matrix Pi transition.
Verification: source PR tests green and review state reported; public docs PR attached; live pilot only when credential and recipient setup are available.
