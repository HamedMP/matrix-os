# Post-Merge Delivery Tasks

All implementation tasks remain open. This specification does not build an app, fetch mail, clean an inbox, or change a production runtime.

- [ ] Verify the gallery stack has landed in main, its installer/account grants are qualified, and dependencies can be based on main.
- [ ] Inventory exact Jev funded readiness, result-retention/idempotency behavior, and supported Gmail history/message actions in the shipping runtime.
- [ ] Write failing Postgres fixtures for owner/account uniqueness, CAS progress, coalesced claims, consumer grants, classification reuse, cleanup receipts, and deletion suppression.
- [ ] Write failing filesystem fixtures for content integrity, write interruption, quota exhaustion, symlinks, missing objects, exports, and lease-aware recurring cleanup.
- [ ] Implement shared owner archive, bounded jobs, full selected-range backfill, history replay, and recovery from expired history.
- [ ] Add a narrowly authorized archive-backed Jev adapter and immutable evidence/version keys; test unknown funded outcomes without blind retries.
- [ ] Build a labeled mixed-mail fixture set and calibrate newsletter inclusion/exclusions independently from cold-outreach archiving.
- [ ] Adapt Folio and Atlas imports to archive reads with explicit account grants; preserve existing manual correction precedence and import history.
- [ ] Design and build Edition publication library, reading queue, article view, search, Work/Personal filters, review/corrections, and durable reading metadata.
- [ ] Implement exact-message cleanup preview, confirmed archive receipts, partial/unknown recovery, cancellation, and undo; independent source verification is mandatory.
- [ ] Add separately enabled publication rules after calibration, with per-account grants, revocation, and capped jobs.
- [ ] Qualify all five OS views, including Native Mobile authenticated app loading, explicit offline download, session recovery, cache isolation, and queued reading-state reconciliation.
- [ ] Capture actual source screenshots with fictional content for the gallery; add recommendations only for supported source capabilities.
- [ ] Add observed connector call/reuse metrics and honest cost/coverage presentation. Verify initial-backfill and unchanged-delta call counts separately.
- [ ] Open a separate public documentation PR in FinnaAI/matrix-os-site; document retention/export/deletion, cleanup/undo, offline limits, and connector cost behavior.
- [ ] Complete exact-head Greptile 5/5, required CI, independent Linux runtime checks, and owner-scoped live mail acceptance before release promotion.

Later adapters: additional email providers, RSS, saved articles, unsubscribe workflows, optional attachments, and highlights beyond plain reading metadata. Each needs its own capability and safety qualification.
