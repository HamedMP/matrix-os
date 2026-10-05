# Matrix Memory Workspace trial — implementation draft

Status: ready for implementation after isolated branch/worktree creation is unblocked. No trial code, PR, VPS, or personal-data import has been created by this step.

## Intended experience

One shared Memory & Sources workspace lets the owner import selected email, calendar events, Apple Notes, and documents; browse originals and extracted knowledge; compare Hindsight and OpenViking; and use selected evidence in an existing or new Chat. Storage stays on the owner's VPS. Cloud extraction, embedding, and reranking are allowed.

The workspace has a source/collection sidebar, searchable list, reading pane, related-items navigation, and an expandable ingestion activity view. Originals, extracted facts, and reusable procedures are distinguishable. Each memory shows its source, processing status, engine, and revision. Empty, disconnected, importing, partial, unavailable-engine, and failure states report actual state.

Pending preferences: whether “current Drive UI” means the Files app; whether the first email/calendar source is Apple Mail/Calendar, connected Gmail/Google Calendar, or both. The desktop import wizard will expose source selection before accessing personal content.

## Decisions

1. Canonical import records, source revisions, permissions, jobs, context references, comparison queries, and owner ratings live in owner-controlled Postgres through Kysely.
2. Hindsight and OpenViking run separately on the trial VPS. Each receives the same selected source revisions, with independent ingestion receipts and status. One engine failing must not appear as a successful comparison.
3. OpenViking's required local content/index state is an explicitly documented experimental engine store. It must not silently replace Matrix's canonical Postgres data or introduce a new embedded database into Matrix services. Record this storage boundary in the governing spec before implementation.
4. Engine URLs and credentials are operator-controlled. Browser payloads never choose backend URLs or receive model credentials. Services bind to loopback; Matrix authorizes their use.
5. A private, owner-only trial runtime is required before personal imports. The existing standard PR preview is shared, has a 72-hour reaper, and blocks machine-proxied personal integrations. Do not upload personal mail/notes into that standard shared preview. Preserve private source data before expiring or removing a trial.
6. Use native host services and an exact, channel-free PR bundle. No production promotion or fleet rollout. Keep the existing customer runtime untouched.
7. Do not directly read Apple Notes databases or scrape local mail stores. Prefer supported macOS APIs/automation and explicit export imports, with an owner selection/preview step. Preserve metadata and source identifiers where available; report unsupported attachments and locked notes honestly.
8. The trial measures retrieval and useful knowledge rather than advertising autonomous improvement. Promote procedures only with observed outcomes and source evidence; evaluate later use on held-out tasks.

## Work units

### U1 — Canonical sources and ingestion

Goal: one bounded, resumable import pipeline supplies the same source revisions to both engines.

Files: new `packages/contracts/src/memory-workspace.ts`, new `packages/gateway/src/memory-workspace/{database,repository,import-service,ingestion-worker,routes}.ts`, contract exports, gateway registration, focused tests under `tests/contracts/` and `tests/gateway/`.

Approach: validated source envelopes; exclusive owner scope; account/source keys; revision/content hashes; idempotent transactional page commits; independently leased engine jobs; bounded concurrency, retries and input sizes; cancel/pause/retry; tombstones and deletion receipts. Source text is untrusted input and never grants execution permission.

Execution: tests first.

Tests: duplicate imports, revision updates, interrupted pages, expired leases, two workers, later-page failure, invalid MIME/HTML, oversized input, private/org isolation, deletion during ingestion, cancellation, failed engine writes, restart recovery, shutdown drains.

Verification: a real Postgres integration test replays duplicate and interrupted batches without missing or duplicating sources and jobs.

### U2 — Hindsight and OpenViking adapters

Goal: actual ingestion and retrieval through both engines, with inspectable evidence and comparable runs.

Files: new `packages/gateway/src/memory-workspace/engines/`, test adapters and fixtures, deployment service definitions and readiness checks under `scripts/` / host bundle configuration, benchmark adapter modules where the existing benchmark lands.

Approach: spike pinned engine versions first; document retain/session commit completion behavior, source identifiers, updates/deletion and export. Connect Hindsight to local Postgres; configure OpenViking's local workspace and vector backend. Cloud inference is separately configured. Normalize responses into engine-neutral evidence while preserving engine-native details for diagnostics. Never fabricate exact source spans when an engine only returns summaries or document references.

Execution: tests first after live API spikes.

Tests: ingestion readiness, unavailable service, timeout, malformed results, extraction with no facts, duplicate captures, source correction, tombstone propagation, engine restart, corpus parity, retrieval scope, citations, content budget.

Verification: a selected synthetic corpus is ingested on the trial VPS, searched through both real engines, updated, and deleted; original and engine receipts agree.

### U3 — Shared Memory & Sources browser

Goal: replace the identified old Drive surface with a polished, navigable memory workspace while preserving existing files and file operations.

Files: new `packages/ui/src/memory-workspace/`, surface adapters in `shell/src/components/` and `desktop/src/renderer/src/features/`, app launch wiring after the Drive clarification; focused renderer tests.

Approach: shared client, state derivations and feature components; source collections, memory types, search, reader, related evidence, import wizard, activity, compare view. Engine controls are visible in the comparison experiment, not scattered across ordinary browsing. Preserve navigation to existing files and deep links. Account/runtime changes clear private derived state.

Execution: tests first for shared behavior, followed by visual validation.

Tests: selection changes during loading, import/retry/cancel failure, truthful counts, keyboard navigation, safe plain-text rendering, engine outage, bounded errors, source citations, runtime switch, deleted sources and existing file navigation.

Verification: equivalent behavior across Web Canvas, Web Desktop and Electron Desktop; mobile parity or an explicit scoped limitation in the spec.

### U4 — Desktop and connected-account imports

Goal: the owner selects an account, mailbox/date range, calendars or Notes folders and previews the import before upload.

Files: new desktop main-process import modules, preload IPC contracts, shared wizard source adapters, existing integrations bridge adapters and focused tests.

Approach: determine available supported macOS interfaces in a spike before promising automatic access. macOS permission requests occur through the desktop flow. Import read-only snapshots; bounded pagination; source-specific metadata; explicit progress and partial coverage. Provide file/export import when a source lacks reliable native access. Connected Google adapters must retain the authenticated actor and selected account; do not forward platform credentials to the trial engines.

Execution: tests first after native API spikes.

Tests: denied permissions, unavailable application, multiple accounts, canceled selection, locked note, malformed calendar data, recurrence/timezone preservation, email body decoding, omitted attachment reporting, selection/date bounds, paging and resumability.

Verification: owner-selected small samples from each enabled real source appear with accurate identifiers, dates and content before offering bulk import.

### U5 — Chat context and automatic memory use

Goal: select a source, memory or collection and add it to a new/existing Chat; enable bounded automatic retrieval per Chat.

Files: `packages/contracts/src/chat-agent-context.ts`, canonical resource-reference contracts, `packages/gateway/src/chat/agent-context.ts`, queue/retry context resolution, common Chat composer/context picker and harness adapters, focused tests.

Approach: extend the existing server-resolved context pipeline rather than trusting client-supplied memory text. Resolve references to source revisions and citations; show the evidence/context budget before sending; persist the admitted snapshot; reauthorize on queued execution and retry. “Automatic”, “Selected only” and “Off” are explicit Chat settings. Retrieved text remains reference material and cannot grant tools, permissions or instructions. All supported harnesses consume the same resolved evidence.

Execution: tests first.

Tests: cross-owner IDs, deleted/revoked references, revision mismatch, unavailable engine, token/byte budget, prompt injection in source content, queue/retry revalidation, new Chat creation failure, harness parity and cited context receipt.

Verification: start a fresh Chat from a selected memory, inspect its context receipt, ask a source-grounded question, then delete/revoke that source and verify new/queued use is blocked.

### U6 — PR, private preview and comparison evidence

Goal: a reviewable implementation PR and working private VPS experiment, plus a separate public documentation PR.

Approach: manual named worktree; TDD and appropriate type/build checks; mandatory code review; conventional PR with invariants and deployment monitoring. Publish only an exact channel-free trial bundle. Verify native services, both engines and source storage. Use synthetic fixtures for initial end-to-end checks, then leave the owner to select private imports in the UI. No raw personal content in PRs, logs, screenshots or fixtures.

Measurements: same corpus and model budget; correctness/admission/placement; corrections and historical queries; 10k/100k file retrieval; grounded answers; held-out procedure success; import and query cost; p50/p95 latency; peak RSS; restart recovery; delete/export; owner ratings. Separate engine comparison from model comparison and distinguish ingestion-complete from consolidation-complete.

Deliverables: implementation PR, docs PR, private trial URL, desktop build supporting the import flow, reproducible benchmark output, deployment verification and an export/cleanup plan.

## Authentication matrix

| Operation | Required authority | Boundary |
|---|---|---|
| Browse/search/compare | Authenticated owner of trial memory | Scope before retrieval; filter results again |
| Import/upload | Owner + explicitly selected source/account | Bounded body and per-source payload schemas |
| Desktop source access | Trusted desktop IPC caller + OS permission | Selection before upload; read-only |
| Pause/retry/cancel | Owner of job | Atomic job state transition |
| Delete/export | Owner of source/collection | Engine receipts, tombstones, export status |
| Attach/retrieve in Chat | Chat owner + current source permission | Server resolution, snapshot, queue/retry recheck |
| Engine API/model credentials | Local service identity | No public engine ports or client credentials |
| Trial deploy | Authorized operator, exact PR bundle and private owner | No channel promotion or production fanout |

Every mutating HTTP route uses body limits and bounded Zod validation; all external calls have timeouts. Errors shown to users are generic while operator diagnostics remain content-free. UI and worker shutdown behavior must be tested.

## Current blocker

The filesystem allows working-file edits but protects Git metadata. The request to create the required isolated branch/worktree was sent through automatic approval review twice. Both attempts were rejected before execution because the selected review model was at capacity. This was not a determination that the action was unsafe. Do not bypass approval by copying Git metadata or changing the main checkout. Resume branch/worktree creation when approval-service availability is restored.
