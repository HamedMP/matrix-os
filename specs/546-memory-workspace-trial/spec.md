# Memory workspace trial

Status: implementation in progress. Governs the first private experiment requested October 5, 2026.

The trial separates originals from extracted memory. Library owns editable notes and imported email/calendar/documents in owner PostgreSQL. Hindsight and OpenViking keep independently rebuildable local indexes on that owner's VPS; cloud inference is permitted. Memory searches show engine status and original source citations. Compare runs one query against both engines with identical source revisions. No engine is declared the winner before measurement.

The shared browser ships across Web Canvas, Web Desktop, Electron Desktop and Web Mobile. Native import into Electron Desktop uses supported Apple automation and a file chooser: inventory, owner selection, bounded preview, selected confirmation, authenticated upload. Native Mobile importing Apple Notes/Mail is an explicit platform limitation; the shared Web Mobile browser is available. Personal originals remain independent of organization Drive permissions. The current Drive browser is redesigned while preserving its existing actions and access rules.

Library starts with a sidebar, collections, search, original reader and editor. A graph is deferred until user testing shows that graph navigation improves connection discovery beyond search and source citations. Files remain an independent source workspace; this trial does not silently watch or upload arbitrary folders. Automatic file watching, per-interaction learning/admission, reflection, a dedicated verification subagent and autonomous self-improvement are follow-up work. The trial tests memory engines on owner-selected originals first; ingestion status does not assert truth, extraction quality or continuous Chat learning.

## Authorization

| Route | Authentication | Scope | Public |
|---|---|---|---|
| GET /api/memory-workspace | Gateway principal | Personal owner | No |
| GET/PATCH/DELETE /api/memory-workspace/sources/:id | Gateway principal | Personal owner; update revision check | No |
| POST /api/memory-workspace/sources | Gateway principal | Personal owner; idempotent request | No |
| POST /api/memory-workspace/search, /compare, /context | Gateway principal | Personal owner; current source revision | No |
| POST /api/memory-workspace/jobs/:id/action | Gateway principal | Personal owner | No |
| Electron memory import IPC | Exact trusted main renderer frame | Local owner selection | No |

All mutations have body limits and strict validation. Engine endpoints are operator-configured loopback services; the browser cannot configure URLs or obtain credentials. Canonical sources, receipts and job changes use owner-scoped transactions. Jobs lease independently per engine and recover after interruption. Deletion immediately excludes sources from reads/retrieval and durably requests removal from each engine. Shutdown drains worker operations and closes owned pools.

Use in Chat opens an editable draft with source identity/revision references, never auto-sends. The server resolves and bounds source text, revalidates it before queued/retried dispatch, and marks it as untrusted evidence. Personal-memory-backed Chats fail closed for public sharing and shared execution.

## Measurement and validation

Synthetic evaluation uses the existing reproducible memory benchmark for admission/retrieval/scope/deletion stress tests. Real trial comparison uses reviewed question-to-source labels on the owner's corpus, reports availability separately from recall/precision/MRR, and measures median and p95 query latency. Cloud spend and ingestion latency must be taken from provider/service telemetry rather than invented estimates. Storage/memory sizing and model configurations must be recorded for each real run.

Deploy an exact PR bundle without promoting any channel. Personal imports require an owner-only Private Preview. Its 72-hour expiry and export requirement must be clear before use. A standard shared pr-N preview is suitable only for synthetic data. The live platform currently returns unavailable for owner-only preview listing; diagnose configuration after the code and PR are ready. Do not bypass preview owner authorization.

Required deliverables: implementation PR, separate public documentation PR, focused contract/service/IPC/Chat/UI tests, rendered responsive UI validation, and exact-bundle preview with both services verified. Do not report the preview or a real engine benchmark as complete until both engines have ingested and retrieved test evidence successfully.
