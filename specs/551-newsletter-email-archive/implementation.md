# Edition implementation review

Edition consolidates authorized Gmail history into a publication library. The owner can read, save, correct, export, download, remove retained content, and preview/confirm exact-message inbox cleanup with durable verification and undo. Folio and Atlas reuse the same retained email only when explicitly granted that account and history range.

This implementation is a separate draft review stack. Its integration base contains the existing gallery dependency and spec; it is not a production release or approval to merge the gallery. Rebase the stack onto main after those dependencies land.

## Implemented authority matrix

| Entry point | Authentication and authorization | Limits / public access |
| --- | --- | --- |
| `POST /api/mail/action` | Gateway request principal mapped to the canonical runtime owner; exact installed first-party Edition manifest; per-account current consumer grant. Only Edition can connect, mutate reading/corrections/retention, export, delete, or clean an inbox. | Strict action schemas, 16 KiB body limit, bounded batches, 9 s reads / 30 s cleanup. Private. |
| `POST /api/mail/read` | Same canonical owner and installed first-party consumer check; only sources/messages/message, each under an Edition, Folio, or Atlas grant. | Strict read union, bounded paging and content chunks; no grant expansion or source mutations. Private. |
| `POST /api/integrations/mail-call` | Signed internal machine delegation plus owner-scoped exact connected Gmail binding. Read-only harness delegation is explicitly denied. Source writes recheck active connection and live Gmail profile before dispatch. | Only bounded Gmail operations; request body limit and connector timeout. No public or general app capability. |
| Kernel `read_mail_archive` | Registered dependency at startup; kernel authenticated gateway client; shared read-only schema. | Retained sources/metadata/content only; installed consumer and grant checks stay server-side. |
| Managed Pi `read_mail_archive` | Owner resolved through existing managed tool broker; runtime injected read capability; shared read schema. | Default 20 messages and 16k JSON content chunks, below model-facing tool response cap. |
| Native Claude mail MCP | Separate integration_read bearer for the mail-read tool surface; existing generic MCP call capability is unchanged. | Credential never enters model inputs; only retained read operations. |
| Web iframe downloads | Exact Edition identity, expected iframe window/origin and MessagePort; scope from authenticated shell owner/computer/runtime. | No caller-selected scope. 50 complete articles, 5 MiB, 100 queued reading patches. |
| Electron downloads | Exact installed Edition renderer/frame capability and current auth generation; scope supplied by main-process identity/runtime. | Private host storage, strict cache schema, bounded serialization, logout/switch fencing. |
| Native Mobile | Clerk authenticated owner plus selected computer/runtime; fresh token per action; shared Edition state logic. | Native reader replaces raw WebView for Edition; explicit bounded downloads only; no offline provider writes. |

No route trusts an app-supplied owner, replacement source account, or grant assertion. Email text is inert evidence, never instructions. Remote tracking resources and executable email HTML are not rendered.

## Persistence and concurrency

Owner-controlled PostgreSQL/Kysely stores source identities, per-consumer grants, message metadata, reading revisions, sync checkpoints, classifications, suppression markers, observed usage, cleanup plans and receipts. Private content-addressed files store retained message evidence. Production adds no embedded database or alternative ORM.

Bootstrap is idempotent and advisory-lock serialized. Related writes use transactions. Import and purge acquire source locks before grants and message rows. Purge acquires all consumer grants before deleting message state; it erases private tombstone metadata/corrections, revokes grants, and fences active sync leases. Stop importing keeps granted history readable and requires explicit account reconsent to resume. Neither retention choice changes Gmail.

Reading state and corrections enforce CAS in the write. Message deletion leaves a suppression marker so replay does not silently resurrect it. Cleanup is exact-message, previewed, consent-checked and independently verified. Unknown provider outcomes remain recoverable; replay reconciles current source state rather than blindly repeating a write. Undo restores only confirmed inbox membership, preserving source read/unread labels.

Bounded, owner/account sync leases make replay resumable. Mutable Gmail page identity changes reset the local offset; stable pages retain progress. Missing or corrupt bodies can be repaired through verified atomic replacement; directory/symlink/permission failures do not widen access or trigger an unrestricted retry. Private file reclamation is recurring, symlink-safe, age/count bounded, and respects import/read leases. Shutdown drains workers, garbage collection and owned file capabilities without closing the injected shared database pool.

## Jev and cost presentation

Classification uses the existing Jev email-triage recipe and explicit funded readiness. Immutable evidence digest, owner/account/message, model policy and recipe form the durable idempotency key. Unknown paid outcomes never create a new dispatch key. Complete unchanged content and classification evidence are reused; partial, truncated, conflicting, urgent, personal, reply-needed or manually excluded evidence cannot enter cleanup.

Source summaries distinguish selected coverage, saved/partial counts, classification progress, source availability, last completed sync, safe errors and quota. Observed connector attempts, message retrievals and reuse are account totals. These counters observe the owner-side exact-bound transport; internal provider verification calls are not separately observed. Billed usage remains null when the connector supplies no authoritative bill; the UI makes no dollar-saving promise.

## Device behavior

All renderers share Edition models, filtering, reading reconciliation, cleanup and source actions. Web Canvas, Web Desktop and Web Mobile use authenticated host-owned browser storage. Electron uses its trusted main-process store. Native Mobile launches a native reading screen and persists its owner/computer-scoped cache through AsyncStorage. A complete edition must be explicitly downloaded; partial placeholders are rejected. Persistence failure never claims a successful download or silently evicts an existing requested article.

Only reading metadata queues offline. On reconnect the runtime reauthorizes retained IDs, checks content versions, then reconciles CAS revisions. Removed or revoked content is invalidated on authenticated contact. Logout or computer/owner changes fence stale writers and clear/isolate device copies. Source cleanup, classification changes and retention require an online confirmed action.

## Review and qualification

The combined implementation is validated before splitting; each review layer declares its dependency. Fixture mail and screenshots are fictional. No real mailbox, paid classification, inbox write or production rollout was used for this implementation review.

Final combined checks passed 58 suites / 377 tests (9 Linux-specific skips on macOS), with an additional 41 tests against isolated PostgreSQL. The production Web build and gateway typecheck passed. Recorded checks include PostgreSQL import/read/cleanup/undo/deletion, concurrent grant/purge lock order, additive/repeated migration, quota/grant boundaries, interrupted sync, mutable-page recovery, unknown source writes, device reconciliation and cache isolation. The Native Mobile Jest suite passed 115 suites / 1,074 tests; its existing post-summary open handle was stopped explicitly. Physical-device offline latency, actual Linux pinned-file runtime, live funded Jev classification calibration, exact-head Greptile and required CI remain release qualification gates.

Publication rules remain disabled until the spec's independently labeled mixed-mail calibration meets its precision threshold. Manual preview/confirm cleanup is available. Do not describe autonomous publication cleanup as released or infer calibration from synthetic score fixtures.

Public documentation ships separately in [FinnaAI/matrix-os-site PR #200](https://github.com/FinnaAI/matrix-os-site/pull/200) under content/docs/edition.mdx. Final changed-scope React audits report zero errors and zero warnings for Web, Native Mobile and the Edition template. Final focused Edition checks passed 36 tests; Native Mobile checks passed 10 tests after the UI refactor, and the template production build passed. Before promotion, validate a disposable owner-scoped VPS using real account consent, inspect observed counts independently from connector billing, qualify all five surfaces, then verify the immutable host bundle and healthy gateway/shell/sync services.
