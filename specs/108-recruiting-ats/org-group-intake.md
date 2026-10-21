# Organization hiring and group email intake

## Ownership and access

The recruiting database remains an isolated organization ATS database, never the platform or a personal app database. This deployment serves a single recruiting organization. The private site binds its production Clerk organization ID; adding a different organization requires its own ATS database and credentials. Live Clerk membership is checked for every page, action and CV download. Members read/comment; admins review/manage members; custom Clerk `org:recruiting:review` permits reviewer actions and `org:recruiting:comment` permits comments. Active organization switching and email domains never confer access. Removed members lose access on the next request.

The site alone holds the ATS admin bridge secret. It supplies the verified Clerk actor ID after the action-specific permission check. The platform trusts this authenticated server caller; actor headers without the admin bearer grant no access. Notes, transitions, metadata, promotion and history imports record the acting identity. Slack discussions stay in Slack; decisions use the Clerk-protected review link. Slack identities never authorize candidate decisions.

## Auth matrix

| Route | Authentication | Public |
|---|---|---|
| POST /api/ats/applications | Distinct public-site ingest bridge credential | No |
| POST /api/ats/mail | Dedicated write-only email intake credential | No |
| GET /api/ats/admin/inbox, attachments/:id | Admin bridge credential, preceded by live site Clerk read permission | No |
| POST /api/ats/admin/inbox/:id/promote | Admin bridge, live site Clerk review permission and actor | No |
| POST /api/ats/admin/legacy-import, legacy-inbox | Operator admin bridge; explicit one-time stored recruiting migration | No |
| POST /api/ats/admin/slack-backfill | Operator admin bridge; bounded cursor paging | No |
| Existing admin comments, scorecards, tasks | Admin bridge, live site Clerk comment permission | No |
| Existing status, metadata, interviews | Admin bridge, live site Clerk review permission | No |
| /admin/ats/team | Clerk organization admin; Clerk manages invitations and roles | No |

## Email wiring

Google Groups has no supported conversation-reading API. A dedicated opaque receiving address subscribes to careers-group delivery. No personal Gmail authorization, token or ongoing mailbox import is used. Cloudflare routing uses an isolated subdomain; root Workspace MX records remain unchanged. The worker checks exact recipient capability and careers List-Id; List-Id is a routing filter, not cryptographic proof of sender identity. Cloudflare's inbound authentication still applies. The address is stored privately in Engineering 1Password and as a worker secret.

SMTP -> Email Worker -> private EU R2 raw object -> Queue object reference -> bounded MIME parse -> platform write-only intake -> organization Postgres -> Slack notification outbox. Platform acceptance commits message, all attachments and outbox atomically; RFC message ID hashes deduplicate retries. Raw email is deleted only after confirmed platform acceptance. Max raw email 32 MiB, body 500,000 characters, attachment total 20 MiB, at most 30 files. All file types are opaque downloads; CV signatures remain validated. Original HTML is retained as a downloadable attachment and text is posted without active formatting. Oversized originals remain in the failed intake archive for operator recovery. Unknown senders require human promotion, without invented consent or automated ranking.

Queue retries ten times then retains a reference in the failed queue. R2 pending objects expire after 30 days; the private operator must monitor failed delivery and replay within that retention. No applicant PII or raw content is logged. A queue-write failure after archival leaves a bounded lifecycle orphan and fails SMTP processing. Missing raw on a retried accepted job is acknowledged. The group archive remains the original source.

## Reliability and lifecycle

Sender advisory locks serialize promotion and imports. Logical identifiers use ON CONFLICT. Related writes stay in one transaction. Status/metadata updates preserve existing optimistic revision checks. Slack jobs claim at most two rows with FOR UPDATE SKIP LOCKED and ten-minute leases; failures retry with bounded backoff, delivered bookkeeping expires after 30 days. A crash after Slack acceptance but before database acknowledgement can duplicate a notification: delivery is at least once, never exactly once. Plain-text Slack blocks prevent applicant mention/formatting injection. All external calls time out and reject redirects. Worker startup cleanup and process shutdown drain in-flight delivery before closing ATS Postgres.

Historical tracker import reads stored app tables through the owner-authorized bridge, never Gmail. It preserves stages/comments and files, maps historical role names explicitly, records missing original authors honestly, suppresses notification floods, and never overwrites subsequent reviews on replay. Original personal data remains intact; migration is an explicit transfer requested by the owner. The retired personal Gmail polling timer must be stopped at cutover. Original group history is captured through the authorized Group UI, including every expanded message and its raw MIME attachments. The private manifest importer validates all originals before writes, sorts chronologically and deduplicates by RFC ID; no Gmail API is used. Legacy tracker snippets remain preserved in the ATS, but are excluded from Slack email backfill when full originals replace them.

## Verification and rollout

- Unit/integration tests: Clerk membership/role revocation, wrong organization and anonymity; idempotent email/promotion/history imports; attachment bounds/signatures/private access; queue failure, durable acceptance, Slack retry and leases; existing ATS route regression tests.
- Compile platform and private site; build the worker bundle; validate Web Desktop, Web Canvas and Electron Desktop access to the same hosted dashboard through browser navigation. This feature is the shared hosted recruiting dashboard, not duplicated shell-specific candidate state.
- Open backend PR and separate private-site PR with canonical public docs updates. Large platform composition files receive dependency wiring only; all behavior is extracted to focused ATS modules. Future composition refactors must extract lifecycle ownership rather than add feature logic there.
- Provision new secrets in Engineering before runtime binding. Enable production `ATS_GROUP_INTAKE_ENABLED` only after Slack installation, runtime secret access and receiving address are verified. Existing deployments keep the feature disabled until then.
- Configure EU R2 lifecycle, queue failure monitoring, the subdomain routing rule and the group's member subscription. Browser access grants require action-time confirmation.
- Deploy reviewed heads, exercise synthetic group intake and public-site receipt, verify Slack, import stored tracker history/reconcile counts, then stop old polling and point the personal launcher at the shared dashboard.

## Full applicant Slack threads and historical replay

A channel-scoped hash of the normalized applicant email identifies one root thread across roles and sources. Team replies inherit the original sender identity through References/In-Reply-To. Missing-sender records use a unique message identity, never guess an applicant. No automated candidate approval, rejection or ranking occurs.

A five-minute database lease serializes each applicant thread. Each job delivers at most four new text/file parts per continuation (each file has at most 50 seconds of external calls). Completed text chunks and attachments have durable part receipts; a separate upload ledger reuses allocations and uploaded bytes when completion fails. A confirmed completion clears the signed upload URL. Channel changes intentionally create separate threads. Plain-text chunks preserve all application question answers and email text; all attachments are uploaded to the same thread. Staff review notes are not application answers and remain in the protected ATS.

The worker runs every ten seconds, resumes continuations after sixty seconds, and honors Slack Retry-After. Historical enqueue has bounded UUID cursors and reuses existing entity keys. Durable hash/Slack-ID receipts survive outbox retention to prevent normal replay duplication. These receipts contain no email addresses or body content. Crash windows after external success and before acknowledgement remain at-least-once; uncertain root/attachment completion requires operator reconciliation rather than allocating a replacement file. Slack copies follow workspace access and retention policies and must be managed separately when a recruiting record is deleted.

Verification covers long content, full answers/CVs, archived applications, opaque attachments, original HTML, reply identity, concurrent delivery, partial file failures, upload allocation reuse, rate limits, untrusted upload hosts, soft deletion, private historical enqueue and original archive source boundaries. A separate public-site documentation PR updates the delivery behavior.
