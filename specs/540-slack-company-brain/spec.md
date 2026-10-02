---
status: active
date: 2026-09-30
---

# One Matrix Slack app: personal agents and a Company Brain

## Outcome and agreed experience

One native Matrix Slack app is installed once per workspace. An employee links their verified Slack identity to their Matrix account. App DMs use their personal agent; explicitly configured company channels use a named company agent and Company Brain. Replies remain in the invoking thread. Read a message/thread, answer with evidence, and react to progress. Arbitrary sends require a separately authorized destination/action. A workspace installation creates neither Matrix membership nor resource grants.

The first release is an owner-hosted company context pilot: the host owner supplies storage, the Pi model access source, and funding. Do not advertise organization-owned durability or employee-departure recovery. Organization-owned principal, billing, source transfer, and failover need a subsequent ownership feature. Every employee remains a distinct requester; no fake Clerk user or impersonation is permitted.

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
| `GET /api/slack/oauth/callback` | Single-use hashed state + Slack code exchange | Recheck initiating actor/admin/workspace |
| `POST /webhooks/slack/events` | Raw-body Slack HMAC + five-minute timestamp/app/workspace | Verified link, current Matrix membership and configured Project |
| `GET /slack/link`, `POST /api/slack/link/complete` | Matrix account session + private-DM single-use challenge | One verified Slack sender; account-only employees supported |
| Channel binding `PUT`, workspace/link `DELETE` under `/api/slack/workspaces/` | Matrix account session + CSRF origin check | Current org admin; exact owner Project management and explicit output approval |
| `POST /api/internal/slack/events` on home | Path/body/timestamp-bound platform HMAC | Exact host owner; live company Project authority or exact personal DM owner |
| `POST /api/internal/slack/authorize` on home | Path/body/timestamp-bound platform HMAC | Exact Project owner/org/actor and live action; `publish_reply` also requires exact sending receipt, raw answer digest, canonical result and current source proofs |
| Pi broker | Runtime/generation/run binding | Current group authority and immutable source/model/policy/root on every frame |
| `POST /api/company-brain/scopes/:scopeId/sources` | Trusted Matrix principal | Host owner + scope publication authority |
| Brain `GET` source/search under `/scopes/:scopeId` | Trusted Matrix principal | Current actor/source scope authority |
| Brain scope/source `DELETE`, `GET /export` | Trusted Matrix principal | Host owner + scope authority; source deletion requires expected revision |
| `POST /internal/slack/context` on platform | Exact registered home runtime credential | Fixed original receipt, current membership/scope/install; bounded untrusted page |
| `POST /internal/slack/reactions` on platform | Exact registered home runtime credential | Fixed `eyes` reaction to the original invoking message; exact receipt and current publication authority |
| `POST /internal/slack/replies` on platform | Exact registered home runtime credential | Fixed original receipt/destination, current publication approval/membership/scope/install |

## Resource/failure bounds

Slack ingress: 256 KiB raw body, five-minute timestamp window, home enqueue deadline below Slack's three-second acknowledgement budget. API fetches: 10 seconds, no unbounded retries. OAuth/link challenges expire in ten minutes. Leases prevent concurrent receipt processing; expired pending claims are recoverable, uncertain external effects are not replayed. Persistent receipts have recurring retention cleanup. Brain scopes cap 1,000 documents and 8 MiB of text; context retrieves at most five sources. Messages cap 40,000 characters at ingress and 8,000 in the prompt, with a truncation marker. Thread reads cap one page, 20 messages and 16 KiB; unavailable/partial context is stated truthfully. Inbox/outbox passes and retry counts are bounded. Brain export and source bodies are capped. All timers and registries drain on shutdown. Only owners destroy database resources.

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
