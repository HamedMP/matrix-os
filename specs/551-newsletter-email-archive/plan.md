# Architecture and Delivery Plan

This is a design plan, not implemented behavior. Start implementation only after the gallery stack reaches main. The newsletter app and common archive are one feature: the archive is the shared dependency, not a private reader cache that every app recreates.

## Verified Starting Points

- `packages/contracts/src/jev.ts`: `email-triage-v1` returns seven probabilities including `newsletter`; the existing label policy accepts newsletter evidence at 0.90 for snippets and 0.85 for verified context. Its automatic archive decision is specifically for cold outreach, so it must not be reused as a newsletter cleanup decision.
- `packages/gateway/src/jev/routes.ts`: `/api/jev/evaluate` accepts bounded fixed-recipe input; `/api/jev/inbox/preview` additionally requires an active restricted recipe capability. An installed reader does not inherit that capability.
- `packages/gateway/src/integrations/gmail.ts`: current actions include profile verification, paged messages, full structured message retrieval, string-valued history IDs, labels, and exact-message label modification. `get_message` returns structured full content, not original RFC 822 bytes; lossless `.eml` export requires an explicitly implemented raw retrieval action.
- The existing connector routes reads through Pipedream. This plan reduces repeated retrievals; it does not establish a different funding path or eliminate initial discovery, sync, mutation, or credential costs.
- Existing gallery app-account bindings and owner authorization must be reused after their merge; no guessed email-to-connection mapping.

## Storage and Shared Access

Owner Postgres/Kysely is authoritative for account bindings, message metadata, classifications, consumer grants, cursor/CAS state, reading state, and cleanup ledger. Do not add an embedded database or second canonical JSON metadata store.

Store large retained email payloads as owner-private files under `$MATRIX_HOME/mail/objects/`, addressed by bounded opaque account namespace and content digest. Files contain the exact supported source payload plus canonical text/HTML derivations; label snapshots remain mutable metadata. Store original `.eml` only when the raw adapter exists. App data remains indexed and governed in the owner's database; files are content artifacts and portable export bytes.

Messages are uniquely keyed by owner + provider + immutable connection ID + message ID. A source rebinding creates a new namespace. Headers, email addresses, provider IDs, and user text never form filesystem paths directly. Reject symlinks/path traversal; owner-only directory/file permissions; atomic temporary writes and rename; verify size/digest before setting content ready. A staging file may exist before the DB transaction succeeds; recurring symlink-safe orphan cleanup removes unreferenced staging objects after a bounded grace period. Missing/corrupt files fail explicitly and are eligible for a controlled refetch.

A transaction upserts message versions and classification metadata, then CAS-updates sync progress. Cursor advance follows durable content acknowledgement. Garbage collection marks objects first, removes references atomically, and deletes only unreferenced bytes; concurrent import/export/read leases protect objects until expiry. Long-lived repositories close only their own DB resources on gateway shutdown.

Consumers use a broker, never arbitrary raw archive directories. Resolve the authenticated owner, current installation, exact account grant, purpose/range, and revocation on every read. An expense app may receive only granted receipt evidence; the newsletter app must not grant itself access to every historical message merely because it is installed. No shell-level shared endpoint, public archive URL, or default org access.

## Ingestion and Cost Control

1. Verify the exact live account profile before first read and on reconnect or a saved-binding change.
2. Capture a starting history position before a bounded backfill. Query only the selected date range; checkpoint page progress. Fetch missing bodies; deduplicate by message version.
3. Replay history from the captured starting position to catch mail arriving during backfill. Keep history IDs as strings and checkpoint only after all referenced changes are applied.
4. Fetch missing/content-changed messages once per observed version. Label-only changes update label snapshots without body refetch. Coalesce concurrent app requests behind one bounded per-account worker and database claim with expiry/CAS.
5. On expired history, reconcile the requested range with saved message identities. Never turn a missing page or provider error into source deletion. Preserve tombstones and explicit user-deletion suppression so later replay does not silently resurrect purged content.
6. Classify from retained evidence once per owner/account/message/content fingerprint/context kind/recipe/model-policy version. Reuse durable validated scores; recompute deterministic policy separately when policy changes. Respect existing funded request idempotency and unknown-outcome reconciliation, including unavailable historical result caches; do not blindly redispatch ambiguous paid requests.

Backfill jobs are bounded (proposed 100 messages/page, 500 processed messages/run, max 32 KiB Jev evidence, 2 MiB decoded body, 1 GiB/account quota). Oversize entries remain partial with an explicit reason and no cleanup eligibility. Attachments are opt-in lazy content; future expense consumers can request scoped attachments after validating size and storage budget. No in-memory registry grows without caps and TTL eviction.

The Matrix scheduler resumes incremental jobs; the reader's Sync now uses the same job. Do not invent a separate systemd service per app. Use rate-aware backoff, circuit breaking, cancellation, and bounded retries. External calls have explicit deadlines (10 seconds for ordinary APIs, existing Jev deadline for inference, 30 seconds for supported bounded file transfers). Persist per-action upstream counts and actual billed usage when returned; publish no guessed dollar saving.

## Classification and Cleanup

Use Jev through the existing owner-authorized gateway service with a new archive-backed orchestration adapter. Browser requests reference stored message IDs; they cannot supply arbitrary owner IDs, credentials, models, recipe questions, or filesystem paths. Any installed-app or background caller gets a separately tested least-privilege capability; it cannot borrow a chat run's scoped `/inbox/preview` authorization.

Reuse all seven scores to identify exclusions. Before enabling automatic publication rules, define and calibrate a separately versioned newsletter policy on the labeled fixture set; it must require verified context and reject urgent, reply-needed, personal, recruiting/investment, or conflicting evidence. Existing cold-outreach thresholds are not evidence that a newsletter is safe to archive. Manual message selection remains explicit and cannot bypass missing content or wrong-account checks.

Cleanup is a durable operation over exact message IDs. Before each write, verify saved content readiness, current binding/grant, policy version, and current source labels. Remove only `INBOX`; optionally add the verified existing newsletter label in the same source modification request. Do not mutate `UNREAD`, `TRASH`, or unrelated labels. Source calls stay outside DB transactions. Persist intent and per-message outcomes; read back current labels to settle uncertain dispatches. Retries never claim completion from a request merely being accepted. Cancellation stops new dispatches and reconciles in-flight outcomes.

Undo requires fresh account authorization and source evidence. Restore only inbox membership removed by that operation; skip already-restored, deleted, rebound, or conflicting messages and report partial results. A user can revoke future publication cleanup without erasing receipts or existing local reading content.

## Proposed Endpoint Auth Matrix

All routes below are proposed. Existing Jev and integration endpoint authorization remains unchanged.

| Route | Caller and authority | Public? | Bounds and write behavior |
| --- | --- | --- | --- |
| `GET /api/mail/sources`, `/api/mail/messages`, `/api/mail/messages/:id` | Authenticated owner + installation/account-scoped read grant | No | Zod query/path validation, capped cursors and response size; no arbitrary path |
| `POST /api/mail/sync` | Owner + exact source read grant + bounded selected range | No | Body limit, idempotent job creation, per-owner/account rate limits |
| `POST /api/mail/classify` | Owner + exact message read grant + explicit funded policy | No | Body limit; stored IDs only; bounded fixed-recipe evidence; no Gmail write capability |
| `POST /api/newsletters/reading-state` | Owner + installed reader record scope | No | Per-action schema, revision CAS, idempotent save; notify authenticated subscribers after commit |
| `POST /api/newsletters/cleanup/preview` | Owner + current read/source scope | No | Bounded stored selection; computes expiring exact plan, no provider writes |
| `POST /api/newsletters/cleanup/commit` | Owner + exact approved plan or saved publication-specific mutation grant | No | Body limit, plan revision/hash, fixed `INBOX` mutation, receipt ledger |
| `POST /api/newsletters/cleanup/:id/undo` | Same owner + fresh exact source mutation grant | No | Body limit, validated IDs, idempotent per-message restoration |
| `POST /api/mail/export` | Owner + current account/content read grant | No | Body limit, bounded asynchronous export, expiring owner-authenticated download |
| `DELETE /api/mail/messages/:id`, `/api/mail/sources/:id/history` | Owner + explicit local deletion authority | No | Body limit even without payload, reference invalidation and tombstones; no provider deletion |

Background work rechecks grants and account binding at dispatch, not just at job creation. Misconfiguration is a safe 503, not not-found. Error output never exposes provider errors, mail content, credentials, or filesystem paths. Notifications omit article content/account details on lock screens by default. Realtime subscriptions need bounded registries, stale eviction, failure isolation, and shutdown drains; browser WebSocket query-token registration follows existing auth patterns.

## Reading, Offline, and Visual Design

Edition uses the approved app family but a distinct editorial identity: publication marks, serif reading titles, quiet plum accent, generous line height, and a reading-focused layout rather than a ledger. Gallery cards use screenshots of the actual app sources with fictional mail. Sources and permissions remain visible in setup, not implementation jargon in the reading flow.

Sanitize HTML into inert article content, reject active content and unsafe links, constrain wide email tables to a labeled scrolling region, and block remote images/tracking by default. Optional image fetch must use an SSRF-safe, redirect-revalidating, address-pinned fetch path with type/size/time limits. Do not automatically request unsubscribe URLs or execute email instructions.

Use the existing Native Mobile Expo app runtime and its authenticated gateway path. Explicit downloaded editions use a bounded device cache keyed by owner/computer/account/message version. Reader metadata can queue bounded revisioned updates; source cleanup cannot execute offline. Logout clears device content; account/computer changes invalidate visibility immediately. Revocations on another device take effect on next authenticated contact; truly offline copies cannot be remotely erased, and retention copy must say so. First launch, reconnect, interrupted save, stale cache, and memory pressure are actual device acceptance gates.

## Delivery Gates

1. Land and qualify the gallery foundations, including real installation, owner/account binding, and persistence. Do not merge this specification PR before the gallery prerequisite lands.
2. Add failing Postgres, filesystem, authorization, pagination/race, Jev reuse, and source mutation fixtures before production implementation.
3. Implement shared archive and read broker; adapt expenses and trips to consume granted retained evidence. Prove zero repeated body fetches on the same complete historical window.
4. Build and visually qualify Edition across all five OS views. Test raw and sanitized content, empty/partial/error/offline states, and actual compiled gallery screenshots.
5. Deliver explicit cleanup preview/commit/undo first. Enable publication automation only after policy precision and exclusion tests pass.
6. Create a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` covering archive retention, app permissions, inbox archive/undo, partial history, and connector costs. No public customer-specific identifiers or operational secrets.
7. Greptile 5/5 at the exact shipping head, required CI green, independent Linux Postgres/filesystem checks, real Gmail label verification, and physical Native Mobile save/reopen/offline recovery. Scoped owner-computer acceptance precedes promotion.
