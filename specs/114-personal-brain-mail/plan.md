---
status: active
---

# Personal Brain: mail and inbox zero

## Outcome

A personal Matrix app for fast, keyboard-friendly email review and a source-linked view of receipts, people, meetings, subscriptions, and travel. Durable workers keep it current without an always-running LLM. No synthetic mailbox data may be presented as connected or imported mail.

## Decisions and boundaries

- Confirm the selected mailbox before fetching message content. Personal and company scopes never merge implicitly. Do not put account identifiers or message content in this public repository.
- Gmail is the initial adapter because Matrix already has authenticated Gmail integration support. Other mailbox providers require their own adapters.
- Inbox zero means removing INBOX from a message/thread after an explicit user action, not hiding it locally. Local tags must be distinguished from Gmail labels.
- New-mail monitoring and historical import are separate durable jobs. Historical import is paginated, resumable, bounded, cancelable, and reports imported versus remaining/unknown counts honestly.
- Start with explicit user-triggered archive/mark-read/label actions. No autonomous sending, deletion, bulk archiving, purchases, meeting creation, or unsubscribe actions.
- Do not forward an entire mailbox to an unrestricted terminal agent. Mail bodies are untrusted data, never tool instructions. Model extraction uses bounded input, no action tools, a validated output schema, and source evidence.
- Use owner-controlled Postgres/Kysely for messages, extraction candidates, sync cursors, action receipts, and job state. Use ON CONFLICT on account + provider message IDs. Related writes and cursor advancement are atomic.
- Never load email HTML directly into the app DOM. Begin with plain text; sanitize any future HTML renderer, block remote images by default, and never run attachments.
- Reuse the authenticated Matrix integrations interface; never expose provider tokens to the app or store them in app data.
- Follow the existing first-party Vite + React app model. Web Canvas, Web Desktop, Electron Desktop, and applicable mobile app rendering share behavior.

## Work units

### U1 — Gmail connector foundation

Goal: support complete reads, incremental history, and deliberate label operations.
Files: integrations/gmail.ts, integrations/parameter-validation.ts (shared with the integration bridge), existing integrations registry/types/routes; focused gateway and integration tests.
Approach: extract Gmail from the large registry and extract generic action validation from routes before adding behavior. Add bounded Zod schemas, pageToken, history.list, create_label, and modify_message. Keep existing Gmail actions compatible. No permanent delete or batch mutation endpoint.
Tests: existing action compatibility, invalid identifiers, pagination bounds, string history IDs (no numeric precision loss), empty/conflicting label changes, unknown fields, and direct API mapping. Verify errors are rejected before external calls.
Execution: test-first.

### U2 — Durable ingestion and extraction

Goal: import the selected mailbox without duplicates and maintain sync across restarts.
Approach: account-scoped Postgres unique keys, atomic page commits, worker leases with expiry, bounded fetch concurrency, backoff, retry budget, quota/error visibility, and full-resync recovery for expired Gmail history. Preserve user corrections across re-extraction. Record rules/model version and evidence per candidate.
Tests: restart midway through a page, duplicate delivery, two workers, auth expiry, expired history cursor, poison email, oversized MIME, missing headers, HTML-only mail, soft-deletion/export semantics, and cross-owner denial.

### U3 — Personal Brain app

Goal: usable high-quality review experience, not a dashboard mock.
Views: Inbox, Needs reply, Read later, Receipts, People, Meetings, Subscriptions, Travel, All mail, and Sync activity.
Interaction: search, split list/reader, keyboard navigation, visible shortcuts, individual archive/read/tag, draft review, and source links. Never label a heuristic extraction as confirmed.
State: truthful loading/empty/disconnected/partial-import/error states; retain selection and edits on failed actions. No optimistic removal before server confirmation. Expose Gmail permission failures and retry without leaking raw provider errors.
Tests: keyboard and pointer parity, focus/accessibility, dangerous HTML, action failure, source evidence, account changes, duplicate people, and renderer parity.

### U4 — Scheduled jobs and new-mail monitoring

Goal: maintained synchronization and extraction when the UI is closed.
Initial proposed schedules: new-mail catch-up every five minutes; bounded historical batches separately; daily brief at an owner-selected time. Enable only after U2 integration tests and mailbox approval. Do not call polling real-time push.
Gmail push requires Cloud Pub/Sub setup and watch renewal; add only with explicit project configuration. Push and catch-up invoke the same idempotent sync path. No scheduled LLM invocation when there is no new input. Status includes last success, next run, failures, coverage, and pause controls.
Tests: overlapping ticks, process crash, retry/backoff, watch expiry, replayed events, notification deduplication, pause/resume, and shutdown drains.

### U5 — Release and owner validation

Ship through reviewed PRs; do not patch the customer host bundle manually. Validate a selected small mail sample first, then enable resumable history import with a clear progress view. Verify an explicit archive and label action against Gmail before advertising inbox-zero support. Add a separate public documentation PR to FinnaAI/matrix-os-site under content/docs/ with no private mailbox fixtures.

## Auth and execution matrix

| Surface | Authentication | Allowed execution |
| --- | --- | --- |
| Account inventory | Existing Matrix principal | Connection metadata only |
| Read/import/sync | Owner + selected connected account | Read-only Gmail calls |
| Archive/read/tag | Owner + action-specific validated request | One explicit operation; audit receipt |
| Extraction | Scoped worker | No action tools; validated candidates only |
| Scheduler | Owner-scoped durable job | Same sync service; no cross-account fallback |
| Future push webhook | Verified Pub/Sub identity + allowlisted topic/account mapping | Enqueue sync; never execute message instructions |

## Evidence and open prerequisites

- Existing Gmail integration lacks pagination, history, and label mutations.
- Mailbox selection is awaiting user confirmation; no mail content has been imported.
- Current teammate demo jobs are not the Personal Brain scheduler.
- Native Gmail sync documentation: https://developers.google.com/workspace/gmail/api/guides/sync
- Push setup and renewal: https://developers.google.com/workspace/gmail/api/guides/push
- Production readiness requires U1–U5 evidence; an implemented connector alone is not a working mail app.
