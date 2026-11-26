---
status: active
date: 2026-09-30
---

# One Matrix Slack app: personal agents and a Company Brain

## Outcome and agreed experience

One native Matrix Slack app is installed once per workspace. An employee links their verified Slack identity to their Matrix account. App DMs use their personal agent; explicitly configured company channels use a named company agent and Company Brain. Replies remain in the invoking thread. Read a message/thread, answer with evidence, and react to progress. Arbitrary sends require a separately authorized destination/action. A workspace installation creates neither Matrix membership nor resource grants.

The first release is an owner-hosted company context pilot: the host owner supplies storage, the Pi model access source, and funding. Do not advertise organization-owned durability or employee-departure recovery. Organization-owned principal, billing, source transfer, and failover need a subsequent ownership feature. Every employee remains a distinct requester; no fake Clerk user or impersonation is permitted.

## Owner-private Slack summary rules

The PR-preview personal context path is a separate audience from company-channel answers. An explicitly enrolled public channel/thread may supply passive reference context to one owner's selected private bot. A user may configure durable automatic summaries by talking to that bot in a private Matrix Chat: choose all new human messages or genuine mentions of the owner, explicit immediate or bounded per-thread grouping cadence, report focus and language. The agent saves and acknowledges a revisioned executable policy in owner Postgres; a prompt or memory note alone is not a rule. The same Chat supports inspecting, changing, pausing, resuming and deleting the policy. One-shot history requests remain one-shot.

Rules cannot enroll another source, widen Slack scopes, change payer/model authority or publish back to Slack. Ordinary messages remain passive unless an active owner policy matches. Automatic output is private Matrix text with suggested to-dos, one inference and zero tools; it does not execute the to-dos. Paused/deleted policy cannot fall back to the legacy environment mention pilot. Resumption does not backfill history. The bounded implementation and qualification gates are specified in [chat-defined-summary-rules-plan.md](chat-defined-summary-rules-plan.md) and the executable Slack context contract. This local implementation is not evidence of live activation, CI qualification or release availability.

The owner manages the behavior in the Agent's private Chat. The service verifies the owner's direct instruction, saves the revision in owner Postgres and admits new Slack events against the active rule. “Every new message” includes messages with or without mentions. The default report focus is key points. The deployment binding identifies which Slack installation, channel and private Chat the gateway can trust. The rule chooses when to summarize that authorized source and what the private recipient should see.

Show a compact confirmation with the channel, whether the summary is on or paused, and what happens next. Private summaries lead with the main update, decisions and next steps when present. Keep provider IDs, internal tool names, attempts and raw receipts in diagnostics. The initial Dev installation remains a scoped pilot. For product-wide enrollment, offer channels that the current owner and installation can verify, then share the existing signed ingress and owner job pipeline. A channel selection needs separate authority from the rule that consumes it.

## Agent workflow gaps and delivery order (ENG-85)

The support/education scenario exercises scratch and Recipe setup, explicit Create and Save, and recovery in the same private Chat. The onboarding scenario combines approved work mail and calendar, a selected prior Chat and confirmed Memory in a first-week brief. The [comparison and validation record](agent-workflow-gap.md) distinguishes public competitor evidence, Matrix implementation, automated regression and live acceptance.

### P1 for first use

| User path | Completion check |
| --- | --- |
| Open the owner-only Preview | An ordinary browser loads the complete shell at its machine-qualified URL, including lazy JavaScript and CSS. The test client uses the URLs emitted by the build. Exercise an Agent entry after a fresh load without substituting asset paths. |
| Focus the Agent setup conversation | The active turn shows one short model-generated question and a few short suggested replies. A custom answer is always available. After a proposal, the summary highlights just what changed in that turn. Expand full instructions, Skills, sources and access when needed. Nothing persists until the user chooses Create or Save. Verify both a new Agent and a one-field edit. |
| Manage a saved Agent | Its card opens saved management with an archive action. Its own Chat reuses the saved binding and can propose changes to the owner. Opening or archiving its card uses zero model Runs. |
| Choose setup resources | During scratch or Recipe setup, open the existing skill and integration pickers in place. Keep preselected Recipe resources visible and let the owner add and remove choices before confirming the draft. Connecting an app uses Settings and a separate consent step. MCP setup follows existing Settings; Agent-level MCP needs a supported saved-assignment contract. |
| Start a connection from Chat | In guided setup or a saved Agent's private Chat, ask to connect an app available in the existing integration catalog, or ask to add an MCP server. A Chat action opens the existing Settings after a click. When the owner returns, show a catalog app as connected only if the current owner inventory reports an active connection. The owner can explicitly select an eligible source for the Agent afterward. |
| Include a specific prior Chat in an onboarding brief | An owner explicitly chooses a personal source for a turn in their private Agent Chat. Eligible context reaches the brief alongside granted mail/calendar and confirmed Memory. Omitting or removing the selection supplies no prior Chat. Foreign, shared or inaccessible sources supply no content. The Agent gains no standing access. |
| Deliver the English Slack summary | On the original binding, observe an authorized natural channel message, its automatic job and Run, and a single result in the originating private Chat. Check duplicate delivery, pause/resume without backfill, and zero Slack posts. First use read-only checks to match the exact original instance, Agent, direct Chat and callback route. The runtime owner must confirm recovery of the model ledger and callback, with an active authorized spending window. Preserve the event, job, Run and private result receipts and a recording of the natural delivery. |

The four real setup Runs recorded at `a947d2c3` are the historical baseline. For this iteration, record the existing owner-only Preview at its ordinary entry URL using its installed candidate and zero model calls. Label any local scripted-model UX recording separately.

Existing connectors, scheduled routines, approval interactions, stop controls and task status have separate acceptance work. Use a scoped account to verify read access and revocation; observe a scheduled Run, approve or deny a requested action, stop pending work, and follow its final status in Chat. Keep the source, permission, Run and resulting delivery distinguishable in the evidence. Failed live qualification is recorded against the specific path.

### Owner-private PR Reviewer

The owner creates a named Agent through the existing setup chat and explicitly chooses Create. The Agent can guide the owner to an app connection from Chat. In its private Chat, **Details → Apps** lets the owner select and revoke an approved read-only source. The owner can reopen the Agent to see the saved scope. The server stores the source against the current owner, Agent and private Chat binding. A connection shown in Settings does not by itself grant the Agent access.

- **P0 — exact source assignment.** Allow at most one Slack channel and one GitHub repository per reviewer. The gateway takes the current private Agent and Chat binding from owner state and resolves a server-supplied candidate again on confirmation. Resource assignments have their own revisions and do not satisfy connected-account tools. In Dev, repository discovery is limited to the operator-approved stable GitHub repository ID and name on the owner's current connection. A Slack candidate requires an independently qualified test-channel installation, membership and callback. The existing summary enrollment remains bound to its original source and private Chat.
- **P1 — automatic private review.** Admit one signed test-channel message from an approved sender and match its PR URL against the registered repository. Verify both current assignments, read bounded diff data at exact commits, and persist the source and a file-specific English verdict in the originating private Chat. Recheck the active revisions before admitting work and publishing the result. Keep reviewer handoff and Slack-thread replies separate. The existing private-summary Run remains tool-free.
- **Live acceptance.** Record Create, the persisted source assignments, one automatic Slack-triggered Run, the exact diff read, and the reopened result on one pinned Dev build. Then pause the rule and verify no jobs remain active. A fixture or a separate summary recording supports only its own step.

### P2 follow-up commitments

These items remain in the ENG-85 product backlog after first-use qualification. Each has an observable completion check for the eventual delivery.

| Follow-up | User outcome and acceptance |
| --- | --- |
| Broader onboarding context | An owner can opt a defined set of prior Chats or work sources into future briefs, inspect what contributed, and remove a source. A later brief excludes the removed source and evidence from an unapproved mailbox. Reuse the source inventory and consent controls from Project Agent Context where applicable. |
| Shared team Agents and ownership changes | A team owner can define who may use a shared Agent and which sources the team owns. Exercise joining, leaving, revocation and owner departure with two users. A colleague never inherits the creator’s private inbox, Chat, Memory or personal grants. |
| Outbound actions and replies | An owner explicitly selects a destination and allowed action and can withhold or revoke consent. Verify an authorized delivery once, duplicate suppression on retry, and zero deliveries after denial or revocation. Owner-private Slack summaries keep their original private destination. |
| Activity and recovery across tasks | From one view, the owner can find a pending, blocked, failed or completed task, inspect its existing job/Run receipt, and take an available recovery action. A retry cannot repeat a committed result. Use the existing usage/speed interface wherever metrics are displayed. |

## Direct-user agent parity with WhatsApp Cloud API

The personal Slack DM and the Direct WhatsApp access flow in spec 546 share the same user promise: a verified person can message Matrix from a channel they already use, get a private agent response in that same channel, and continue their private Matrix-owned conversation without entering a company conversation. They should share acceptance scenarios and failure semantics, while retaining channel-specific identity proof and the currently qualified agent runtime.

| Scenario | Shared behavior | Slack channel behavior | WhatsApp Cloud API behavior |
|---|---|---|---|
| Link identity | Prove control of the external sender and authenticate the Matrix owner; never infer identity from email, display name, or a caller-supplied ID. | An employee links the Slack sender from a signed private DM using a one-time challenge and an authenticated Matrix session. | A sender claims a short-lived link while signed in to Matrix, then proves the association with a code delivered back to WhatsApp. |
| Route a private message | Attribute each inbound event to exactly one owner and one stable personal conversation; keep it isolated from other users and company scopes. | A Slack DM maps to that employee's durable direct bot Chat and personal `matrix_bot`/Pi route. | The linked sender maps to the owner's persistent general Matrix Chat on the primary runtime. |
| Respond | Return only the committed result for that inbound request to the same sender/conversation; deduplicate event retries and do not blindly replay uncertain sends. | Reply in the invoking Slack DM/thread as the Matrix agent. | Reply to the originating WhatsApp sender within Meta's supported reply window. |
| Needs user action | Keep approvals, questions, or unavailable-runtime status truthful and private; do not claim a reply was sent before delivery is confirmed. | Surface any required action through the private Slack/Matrix path supported by the canonical Chat. | Direct the user to their authenticated Matrix Chat when the canonical run needs approval or input. |
| Disconnect or revoke | Stop admitting future messages and cancel or fence pending work for that link without affecting another user's private agent or company context. | Remove the verified Slack-user link under current Matrix authority. | Disconnect the linked WhatsApp sender under the authenticated Matrix owner. |

This parity does not make the transports or conversation stores interchangeable. The Slack app also supports explicitly configured company channels and a Company Brain; those requests use a separate shared agent and scope. The WhatsApp Cloud API flow is direct-user only, text-first, and constrained by Meta's reply window. Neither flow is the WhatsApp personal-account bridge in spec 077, where conversations are mirrored into Matrix rooms and AI access defaults off until granted per room. Keep these three scopes distinct. Do not change a route's agent, funding source, memory, or conversation authority merely to make channel behavior look alike.

## Compatibility baseline

- Latest inspected main: `3f4ec7b90`; spec 124 supplies home authority, organization membership leases, scoped resource grants, canonical shared queues and revocation fences.
- Pi baseline: PR #2048 `bab5658e4`, atop spec 536 layers #1940–#2022. Stack this feature above that branch; do not duplicate or replace the Matrix-owned Pi loop or inference broker.
- Collaboration preview PR #2055 supplies pending spec 535 account-only entry/recipient views and organization creation/invitations. Slack linking must allow account-only employees to use a company agent without buying a personal computer. Personal execution still requires their configured runtime.
- Company OS proposal #1839 / spec 528 and Personal Brain spec 114 are related work, not evidence of an implemented company knowledge backend.
- Baseline bot admission is private/direct only. Shared Pi must be explicitly qualified; private sessions, memory, workspace artifacts, and integration grants must never be inherited by a company run.

## Requirements

1. Native OAuth installation pins the Matrix actor, organization, Slack app, workspace and redirect. State is single-use, hashed, bounded and expiring. A consumed state remains a durable callback permit until installation commits. Uninstall and callback commit serialize under the same app lock; uninstall invalidates existing permits. Before a workspace has been recorded, its organization is unknown, so a signed uninstall conservatively cancels all pending installs for that app. A fresh explicit installation after cancellation remains allowed, and duplicate uninstall receipts cannot cancel it. Explicit authenticated administrator removal also cancels pending reinstall permits for an already-revoked workspace, including consumed callbacks awaiting provider exchange; only signed provider duplicates take the no-op path. Only current organization admins can install/configure the company binding. Encrypt Slack credentials; never expose them to the model, UI or repository.
2. Account linking proves possession through a challenge sent only to the Slack-signed DM sender, then consumed by an authenticated Matrix account. Never bind a caller-supplied Slack ID or infer identity from matching email/display name.
3. Raw-body Slack signatures and timestamps are verified before parsing. Body limits apply before buffering. Ignore bot messages and unsupported events; signed URL verification is supported. At-least-once events must enqueue at the home before acknowledgement, deduplicate by workspace/event ID and payload digest, and return retryable failure on enqueue failure. Platform receipts contain metadata only.
4. Channel configuration names one exact existing shared Matrix Project and explicitly approves that channel as the publication destination. A dedicated company recipe bot is provisioned per Project; each Slack thread becomes an inherited canonical shared Chat. Existing Matrix membership/resource authority is checked at configuration, ingress, dispatch, source retrieval, broker operations, and publication. Slack membership alone grants nothing. Slack Connect guests remain denied unless qualified by the guest authority stack.
5. Each Slack thread has an isolated canonical Chat binding. Each company Pi run starts with a fresh transcript containing that run’s authorized thread/Brain evidence; prior retrieved source text is never silently reused after deletion or correction. A first-thread owner initialization goes through real canonical admission to establish the provider binding; no binding or turn ID is fabricated. Canonical run identity, session generations and execution roots fence tool continuation. Personal and company modes cannot share Chat/session state. One canonical active run per Chat; request IDs derive from workspace/event identity. Pending or uncertain side effects are not blindly replayed after a crash.
6. Company Pi runs use the existing no-network `bot_agent` workload, a separately qualified group scope handle/root, existing provider routing and bounded funding admission. Group integrations require explicit group grants. No personal bot memory, private artifacts or account inventories are injected. Missing dependencies fail closed. `MATRIX_COMPANY_BOT_MODEL` is a concrete model within the Project owner’s explicit execution policy; the company route never borrows the personal default.
7. Company sources live on the host's Postgres/Kysely database with exact owner/organization/scope keys, durable revisions and original citations. A source is visible only within its explicit Matrix scope; retrieval and publication must respect that ceiling. Approved company mentions and bounded thread evidence are automatically captured as source-linked, idempotent company records. Existing scoped evidence is retrieved for each request; both retrieved and captured source incarnations and revisions are persisted and checked in a final batch before admission and publication. Erase/recreate cannot reuse an old proof. Receipt-bound publication authorization checks the owner’s stored canonical answer after Slack metadata latency. This is distinct from full-history provider synchronization.
8. Search, export and normal reads exclude deleted sources. Source mutations and revision/evidence writes are atomic. Export/delete are owner-controlled. Existing source text is data, never agent instruction; retrieval context is bounded and carries citations/freshness.
9. Solicited replies are bound to the invoking destination and attributed to Matrix. A public/company reply never uses a personal answer as its draft. Mention/broadcast markup is escaped from model output. Recheck authority and receipt-bound canonical/evidence identity after provider metadata waits and before each publication; uncertain delivery has a durable recorded status and requires deliberate reconciliation; it is never blindly replayed.
10. Settings/configuration APIs and canonical Chat are shared headless services. Native setup currently uses APIs; no new settings UI is delivered. The existing onboarding `/readiness` and `/context` demo endpoints do not populate this durable scoped Brain. No alternate collaboration timeline, permission store, composer mode or Slack-only Pi implementation. Existing Web Canvas, Web Desktop and Electron Desktop observe the same canonical records; mobile has the same underlying authority. Native Slack is itself the channel surface.

## Auth matrix

| Endpoint / operation | Authentication | Authority |
|---|---|---|
| `POST /api/slack/install` | Matrix account session, same-origin cookies or bearer | Current org admin |
| `GET /api/slack/oauth/callback` | Fresh initiating Matrix session + single-use hashed state + Slack code exchange | Recheck initiating actor/admin/workspace; unauthenticated browser navigation only hands off to sign-in without consuming state |
| `GET /slack/oauth/complete` | Public brand auth shell; Clerk sign-in and fresh own-session token | No installation or runtime access until authenticated callback succeeds |
| `POST /webhooks/slack/events` | Raw-body Slack HMAC + five-minute timestamp/app/workspace | Verified link, current Matrix membership and configured Project |
| `GET /slack/link`, `POST /api/slack/link/complete` | Matrix account session + private-DM single-use challenge | One verified Slack sender; account-only employees supported |
| Channel binding `PUT`, workspace/link `DELETE` under `/api/slack/workspaces/` | Matrix account session + CSRF origin check | Current org admin; exact owner Project management and explicit output approval |
| `POST /api/internal/slack/events` on home | Path/body/timestamp-bound platform HMAC | Exact host owner; live company Project authority or exact personal DM owner |
| `POST /api/internal/slack/authorize` on home | Path/body/timestamp-bound platform HMAC | Exact Project owner/org/actor and live action; `publish_reply` also requires exact sending receipt, raw answer digest, canonical result and current source proofs |
| Pi broker | Runtime/generation/run binding | Current group authority and immutable source/model/policy/root on every frame |
| `POST /api/company-brain/scopes/:scopeId/sources` | Trusted Matrix principal | Host owner + scope publication authority |
| Brain `GET` source/search under `/scopes/:scopeId` | Trusted Matrix principal | Current actor/source scope authority |
| Brain scope/source `DELETE`, `GET /export` | Trusted Matrix principal | Host owner + scope authority; source deletion requires expected revision |
| `POST /internal/slack/context` on platform | Registered home credential + matching receipt owner and runtime ID | Fixed original receipt, current membership/scope/install; bounded untrusted page |
| `POST /internal/slack/reactions` on platform | Registered home credential + matching receipt owner and runtime ID | Fixed `eyes` reaction to the original invoking message; exact receipt and current publication authority |
| `POST /internal/slack/replies` on platform | Registered home credential + matching receipt owner and runtime ID | Fixed original receipt/destination, current publication approval/membership/scope/install |

The platform derives the runtime ID from the registered machine after validating its handle credential. A pending reply hint requires the same owner and runtime match. Legacy receipts without a runtime ID cannot authorize broker operations. Company Project authorization also checks that the current directory still resolves to the receipt's runtime before contacting the owner home.

## Resource/failure bounds

Slack ingress: 256 KiB raw body, five-minute timestamp window, home enqueue deadline below Slack's three-second acknowledgement budget. API fetches: 10 seconds, no unbounded retries. OAuth/link challenges expire in ten minutes. Leases prevent concurrent receipt processing; expired pending claims are recoverable, uncertain external effects are not replayed. Persistent receipts have recurring retention cleanup. Brain scopes cap 1,000 documents and 8 MiB of text; context retrieves at most five sources. Messages cap 40,000 characters at ingress and 8,000 in the prompt, with a truncation marker. Thread reads cap one page, 20 messages and 16 KiB; unavailable/partial context is stated truthfully. Inbox/outbox passes and retry counts are bounded. Brain export and source bodies are capped. All timers and registries drain on shutdown. Only owners destroy database resources.

Shared Gmail attachments use only the exact Chat-scoped integration read grant. The existing `integration.call` returns stateless chunks of at most 32 KiB decoded bytes and 60 KiB serialized UTF-8 result, re-fetching through the 1 MiB attachment limit on each call. The local `params.chunk` selects a bounded offset/length and requires the complete attachment SHA-256 for continuation; it is removed before the Gmail request. Every chunk rechecks the canonical run generation, Project/worktree fingerprint, source and exact grant after the read. No private artifact capability, common Project file, retained cache or automatic company-source publication is added. Attachment bytes are untrusted binary data with no inferred MIME type.

The host owner retains Brain export/erasure after canonical shared Chat deletion through the exact retained scope and Brain binding. This owner-data path requires current organization evidence and accepted owner membership, rechecks tombstone identity/runtime/epochs under the existing ordered locks, and never reopens deleted scopes to participant reads or execution. A successful bounded Brain export commits an actor/scope/revision audit in the existing owner Postgres collaboration audit table before returning data; failed authorization, capacity checks or audit persistence return no dataset or completed export audit.

## Acceptance

- Two employees in one Slack thread route to the configured company agent, with recorded requester and host payer, without exposing either employee's private Brain or bot session.
- A private DM uses its linked employee's personal agent and cannot be resumed in a company channel.
- Current contributor can ask; viewer, outsider, revoked member and unqualified Slack Connect guest cannot. Revocation after enqueue or before publication prevents delivery.
- Duplicate events, two concurrent ingress workers, expired OAuth/challenge, changed workspace/app, installation removal, home outage and restart preserve truthful status and do not duplicate paid work or messages.
- Pi group sandbox/broker rejects personal memory, private artifacts and missing group integration grants; root and audience changes invalidate continuation.
- Company source citations survive restart; corrections create revisions; delete excludes data from search/export/context.
- Test mocked external HTTP only; real Postgres coverage and a live selected Slack workspace/disposable Matrix runtime must qualify production behavior. No live validation claim without actual evidence.

## Delivery and explicit exclusions

Build the reviewed stack, automated tests, public-safe operator/setup documentation, and a separate `FinnaAI/matrix-os-site/content/docs/` documentation PR. Installing the Slack app requires workspace/admin access and app credentials; the user will choose the pilot workspace/host. No automatic production deployment, fleet rollout, Marketplace approval claim or destructive history import.

Automatic full-history Gmail/Calendar/Slack/notes ingestion remains governed by spec 114 and dedicated source adapters. This release supplies explicit company source publication, automatic approved Slack mention capture, and bounded contextual reads. It does not synchronize all company data. Separate mentionable Slack handles, arbitrary autonomous sends, organization ownership transfer, cross-company federation and computer-use bots are excluded.

## Primary API references

- https://docs.slack.dev/ai/developing-agents/
- https://docs.slack.dev/authentication/installing-with-oauth/
- https://docs.slack.dev/apis/events-api/
- https://docs.slack.dev/apis/web-api/real-time-search-api/
- https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/

Before live qualification, verify installed app/token thread-reading capabilities and Slack native agent feature availability. Do not bypass history/search or Marketplace restrictions through employee credential sharing.

## Composition and extraction

Platform startup mounts native Slack routes before personal-computer routing. Only encrypted installation credentials and routing/receipt metadata live on the platform; Slack content is durably stored on the selected owner home. Gateway startup constructs shared bot hooks before Pi startup, injects the extension into existing shared AI, then mounts signed ingress and scoped Brain APIs. Ingress commits before acknowledgement; a non-overlapping five-second worker submits canonical turns and publishes committed assistant output. Shutdown stops ingress/workers before closing Chat, Pi and collaboration dependencies, without closing the borrowed database.

The large gateway entrypoint follows spec 536’s extraction plan; composition lives in focused `startup/slack-*` modules. Existing `chat/queue-repository.ts` is over 1,000 lines: this change adds narrowly scoped root validation to its established canonical admission transaction. A follow-up extraction should move shared admission/root pinning into a dedicated helper while preserving its transaction and idempotency constraints; do not split it into an alternate queue.

OAuth workspace fence: each bounded permit captures at most 512 app/org installation generations at creation under the app lock. Callback installation compares only the returned workspace generation under the same lock. Explicit administrator removal increments that workspace generation even when already revoked; duplicate provider revocations remain idempotent. Other known workspaces and first installations retain their permits. Legacy permits with no snapshot fail closed. Unknown-team revocation without a recorded organization still conservatively cancels app-wide pending permits. No source content is stored in this snapshot.

### Preview-only Slack transport override

An isolated PR Preview may opt into the existing Slack adapter using the operator pair `MATRIX_SLACK_PLATFORM_URL` / `MATRIX_SLACK_PLATFORM_TOKEN`. Require a bare machine UUID, the true Preview marker, matching own PR handle/runtime slot, exact own tagged `matrix-platform-preview` Cloud Run HTTPS origin, no extra URL components, and a 64-hex token matching the existing Preview inbound token if configured. With neither override key configured, preserve legacy behavior; a partial or invalid pair disables Slack without fallback. All Slack owner RPCs and receiver HMAC use this one pair, including native reads and restricted automatic summaries. No new message router, enrollment permission, OAuth scope or model action is created.

The core platform URL/token and their sync, AI, routine, update and generic-integration consumers remain unchanged. Deployment must atomically change only the Slack pair on the already authorized isolated host. Synthetic signed/client/actual-bot startup tests qualify this boundary; real provider acceptance remains a separate gate.

Disabling Slack preserves the original core Preview eligibility for generic integration tools. Slack-only enrollment can use the existing unavailable-account fallback for native inventory, without creating a generic connected account or changing its transport.

### Fresh authorized source setup

A quiet, newly registered runtime may define its owner-authored Slack rule before the first channel event. The existing runtime credential can read only its exact configured owner/Bot/private-Chat grant via `POST /internal/slack/thread-context/enrollment`; input has the four target identity fields and no source selector. Current installation/link/organization/Slack membership and exact runtime are checked around provider metadata retrieval. The response contains only the unchanged access/grant identity, app/workspace/channel metadata and explicit channel/thread scope.

Gateway discovery is authoritative when configured and checks the actual private direct-Chat/Bot binding before and after await. Denial, failure or malformed metadata cannot fall back to retained events. Discovery does not seed context, copy history or create work. Native reads and rule setup reuse `enrollment()`; thread-only sources remain pinned to their enrolled root. Rule activation still requires canonical positive owner-HTTP provenance, and automatic work still requires a genuinely signed qualifying source event after enabledAfter. No grant, scope, permission, routing or output expansion is introduced.

### Dev-only read-only Slack acceptance

Keep the existing Slack app and normal runtime routing. On an explicitly isolated test control plane, configure a separate Slack App to receive public message events from one internal channel. Match the approved workspace and channel IDs at admission and again before fetching context. The install grants public channel metadata and history. App events, writes and reactions remain unavailable for other channels and ordinary Slack conversations. Verify both accounts during enrollment through the existing authenticated OAuth state and the approved Slack installer identity. Enable the channel grant only after resolving the enrolled owner and the direct private Agent Chat on the exact Dev runtime.

| Existing interface | Dev acceptance authority |
| --- | --- |
| Slack install and OAuth completion | Pinned Matrix owner with current organization admin authority and unused bound OAuth state. The provider response must match the configured app, workspace, Slack installer and permitted scopes. |
| Slack signed events | New app signing authority. Accept only the configured public channel, a current installation and an enrolled owner binding. |
| Platform-to-Dev context and Dev source reads | A dedicated Slack bridge credential and exact owner, machine, Dev slot, Bot and private Chat checks. Route only through the new isolated callback and the registered Dev destination. |
| Owner-authored rule and automatic Run | Canonical owner HTTP admission, fresh source and private Chat authority. Existing rule/job/Run/publication receipts retain the same deduplication and pause semantics. |

The isolated Platform revision uses `PLATFORM_PREVIEW=true`, the new App's `SLACK_*` credentials and `SLACK_PUBLIC_BASE_URL`, `SLACK_DEV_ACCEPTANCE` with `handle`, `machineId`, `ownerId`, `organizationId`, `teamId`, `channelId` and `ownerSlackId`, and a dedicated `SLACK_DEV_BRIDGE_TOKEN`. Use a dedicated nonproduction database and a `slack-dev-<machine UUID first eight characters>` tagged Preview Platform origin with zero default traffic. Enable `SLACK_DEV_THREAD_CONTEXT_GRANT` after OAuth returns the exact installation generation and link creation time. The grant uses the existing channel schema with the exact Dev machine UUID and private Agent Chat.

The tagged revision uses `SLACK_DEV_CALLBACK_ONLY=true`, `PLATFORM_RUNTIME_MODE=cloud_run`, `CUSTOMER_VPS_ENABLED=false` and `AUTH_SHELL_ENABLED=false`. The runtime verifies the Preview service name, the tagged `PLATFORM_PUBLIC_URL`, and a managed Postgres login and database carrying the same machine UUID prefix. The dedicated connection requires `sslmode=verify-full`. After migrations, `/health` succeeds and only the existing Slack namespace is routed on the exact tag. Its App-dependent paths return 503 until enrollment is configured. This mode starts without general Platform routes, background workers or bundle, provisioning and billing credentials.

Read the Dev Gateway's public nginx certificate through the verified owner runtime before activation. Set `SLACK_DEV_INGRESS_CA_PEM` to that one certificate. The home transport verifies `customer-vps.matrix-os.local` and the exact peer certificate before sending signed context over TLS. Absence, expiration or change of that certificate closes the path. Slack provider calls use the ordinary public TLS trust chain. Recheck the certificate on rotation and update the dedicated callback configuration from an independently verified source.

On the authorized Dev computer, set `MATRIX_SLACK_DEV_TARGET` with `ownerId`, `machineId`, `handle`, `appId`, `teamId`, `channelId`, `botId` and `chatId`. Point `MATRIX_SLACK_PLATFORM_URL` at the exact tag and set `MATRIX_SLACK_PLATFORM_TOKEN` to the dedicated bridge token. Preserve the normal platform, sync, update and model credentials. Use a legitimate Clerk owner session for both OAuth start and completion. A missing or mismatched Dev binding disables Slack for that target.

With the new App installed and joined only to the approved channel, define an English rule from the bound Dev Chat and observe one natural unmentioned message. Join the signed event, automatic job, completed Run and one committed English result in that Chat. Verify a duplicate event, a wrong-channel or wrong-runtime attempt, revocation, and pause/resume with no backfill. A failed control-plane lookup stops the operation and never chooses Main or a previous Preview. Record live and fixture evidence separately.

## Two Agents using one Slack installation

An owner maps a channel to a named Agent in **Agents → Details → Apps**. Choose a channel for summaries, or first assign an exact GitHub repository and then choose a channel for reviews. Reopening Apps shows the saved assignments. Each channel resolves to one Agent and one active, exclusively bound private Chat. The original pilot keeps its existing Chat-authored rule and destination. Apps shows that assignment to its owner. The callback never chooses a recipient from the prose in a message.

| Trigger in its mapped channel | Acceptance |
| --- | --- |
| A new ordinary message from the approved sender | Deliver one English summary to the Summary Agent's private Chat. No mention is required. |
| A request to review one canonical GitHub PR URL | Read the actual patch through the assigned GitHub connection. Deliver a verdict with a changed filename, a supporting line, the PR link and the verified SHA to the reviewer's private Chat. |
| Redelivery, unmapped channel, ambiguous binding, withdrawn authority or wrong repository | Prevent a new review, model call and private Chat result. Revalidate in-flight work before each external read, inference and publication. |

The dedicated callback reads `SLACK_DEV_AGENT_CHANNELS`. The Dev gateway opts in with `MATRIX_SLACK_DEV_AGENT_ROUTES=true`. Discovery checks the specific app installation, linked owner, channel identity and Slack membership. For review, match both `MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_ID` and `MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_FULL_NAME`. The gateway uses the general GitHub integration to read PR metadata, changed files and metadata again. Require a consistent base and head, matching repository identities, complete patch hunks and file counts. v1 accepts up to ten added or modified files and 14,000 bytes of serialized patch data. An ineligible patch ends the job before inference.

Each accepted event supplies an isolated input to a private Run. Capture two real events on the same build, reopen both Chats, then pause the pilot rule, withdraw the test route and inspect the job queue. Record the installed build and distinguish a live GitHub CLI preflight from a provider invocation under the Agent's saved grant. The following capabilities remain follow-ups. They include continuing an existing Slack thread session, multiple Agents in one channel with an explicit selector, separate visible Slack identities and Slack thread write-back.

[Claude Tag documents its app identity, channel access and per-thread sessions.](https://claude.com/docs/claude-tag/concepts/agent-identity)
