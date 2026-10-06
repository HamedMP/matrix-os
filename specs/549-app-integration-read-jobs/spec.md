# Owner-scoped application integration reads and durable read jobs

## Problem and behavior

Self-built developer applications need evidence from the owner's chosen Linear issues, GitHub PRs, Slack feedback threads and PostHog support tickets. The legacy service bridge deliberately rejects production requests. A renderer timer also stops when the app closes. This change introduces a dedicated read capability and a bounded server-side collection recipe without expanding the legacy bridge or granting source writes.

The owner declares app permissions in its manifest and grants exact connection IDs, read actions and fixed source selectors in `system/app-integrations.json`. Duplicate account labels cannot select an arbitrary account. `system/app-read-jobs.json` selects reviewed jobs using the fixed `developer-briefing-v1` recipe. Owner-controlled scheduling remains independent of the UI. Missing grants, credentials, storage or configuration fail closed.

## Authentication matrix

| Route | Auth | Additional admission | Public |
| --- | --- | --- | --- |
| GET/POST `/api/bridge/integrations` | Gateway authenticated principal | Configured runtime owner, app manifest, exact policy grant, active connection ID/service/label | No |
| POST `/api/app-read-jobs/status` | Gateway authenticated principal | Configured runtime owner, declared app/job | No |
| POST `/api/app-read-jobs/run` | Gateway authenticated principal | Same owner/job plus current source grants and fenced durable claim | No |
| POST `/api/app-read-jobs/configure` | Gateway authenticated principal | Existing owner/job, strict bounded settings, each selected source already granted; cannot write integration grants | No |
| POST `/api/app-read-jobs/pause` | Gateway authenticated principal | Same owner/job; only owner-local scheduling mutation | No |
| POST `/api/bridge/ai` | Gateway authenticated principal | Explicit owner app AI policy and supported owner or managed text generation admission | No |

All mutations use body limits and strict boundary schemas. Web and native app bridges inject the registered app identity, never trust a caller-supplied replacement. Owner identity comes from verified authentication or runtime configuration, not request headers. Aliases admitted as the same runtime owner map to one canonical durable identity.

## Runtime wiring and source contracts

One injected integration read service is shared by bridge routes and background runner. Its server-owned transport calls the existing integration broker; provider credentials never enter app bundles, IPC payloads or job files. All actions must be registry-classified read operations with validated parameters. The read service rechecks policy and connection identity immediately before dispatch.

GitHub adds current PR detail, reviews, exact full-SHA check runs and commit status. Slack adds replies for a selected channel/thread. PostHog adds actual Support/Conversations tickets and messages with `ticket:read`, using only fixed EU/US API origins. Analytics events and error tracking are not substitutes for tickets. Existing Linear issue reads retain their source semantics.

The gateway starts the runner after owner Postgres services are initialized and drains it before those services close. No Docker customer deployment path, app keepalive, generic executable job, arbitrary URL, platform patch or laptop heartbeat is introduced. `server.ts` only composes a focused runtime initializer; new behavior lives in `app-read-jobs/`.

## Persistence and concurrency

App-declared owner Postgres tables `read_job_state`, `read_job_runs` and `read_job_snapshots` are reserved for trusted runner writes; generic app data mutations must reject them. Reads remain app-scoped. The injected Kysely resource is owned by existing gateway database lifecycle.

Database-time conditional updates claim a 120-second fenced lease. Manual and scheduled runs share that lease. Snapshot updates, completion receipt, next due time and summary state commit in one transaction matching generation, config hash and unexpired lease. A restarted worker can recover expiry; stale completions cannot overwrite newer results. Pausing invalidates the current generation. Partial sources preserve their last successful data and remain visibly incomplete.

Configuration writes use an exclusive lock and atomic rename. A crash-orphaned configuration lock fails closed; an operator must confirm all writers stopped before explicitly removing it. Age-based lock deletion is unsafe because it can unlink a replacement owned by another writer.

Run receipts retain 30 days; receipts containing briefs retain 90 days. Snapshot replacement bounds imported history. App-local notes and pins remain outside runner retention. Deleting source imports is a deliberate owner action.

## Resource limits and failure semantics

Maximum eight jobs and eight sources per job; polling every15 seconds; collection interval at least15 minutes; maximum48 read calls,90 seconds and256KiB per collection result. Shared public inventory/provider read admission is120 requests/minute and four in-flight calls. Internal runner/config authorization rechecks retain the same concurrency and timeout limits without consuming provider-action admission; these are only invoked by the bounded trusted runner. All underlying external fetches retain bounded timeouts. Bounded pagination reports partial coverage when capped rather than implying an exhaustive result.

Summary generation uses the same owner-granted service as interactive app AI, sharing two in-flight slots and10 calls/minute. A policy explicitly selecting `@cf/zai-org/glm-5.3-flash` uses server-owned Matrix funding through the fixed text-only relay route, never an SDK or an owner Codex profile. Scheduled summaries enter the shared funding queue as background work; interactive requests retain interactive priority. The request has no tools, does not stream, caps output at4096 tokens and rejects tool calls, refusals or incomplete responses. Existing owner Anthropic policies keep their credential admission. Selecting a model does not grant app access or change the active Chat provider. It runs only for changed evidence after the configured minimum30-minute interval, or the configured IANA-timezone daily boundary. A fenced database-time attempt intent is persisted before invoking AI, so a timeout, aborted run or process crash still enforces the minimum interval after restart. An attempt without a successful brief is an acceptable orphan state; it grants no execution authority and safely delays another attempt. No source changes means no repeated change summary. Source text is untrusted data. Structured results can reference only server-assigned evidence IDs and must preserve exact source coverage. Revocation is rechecked after model generation and before collection commit. Model or funding failures preserve source collection and produce an unavailable summary receipt.

Errors shown to the app are coarse denied/invalid/busy/unavailable or coverage timeout/budget codes. Logs contain error class, not credentials or raw source data. A queued manual request is accepted, never reported as collection success before its durable receipt.

## Delivery and acceptance

- Red-first unit/contract tests for source parameter validation, exact account binding, grant revocation, bridge identity and reserved table mutation denial.
- Actual PostgreSQL concurrency, lease recovery, transactional snapshot/receipt persistence and stale completion tests.
- Runtime wiring test: boot runner without a renderer, collect and persist; stop drains before shared resource destruction.
- Web and native bridge parity tests; legacy production service rejection remains covered.
- Exact-head Preview VPS and Electron Desktop review: source selection, real reads, truthful empty/partial states, manual refresh, pause, reload, local overrides and collection with the app closed.
- Separate public-safe documentation PR in private `FinnaAI/matrix-os-site/content/docs/`, covering permissions, connection selection, recipe limits and background receipts. No personal account identifiers or private source content in documentation.
- Human Review on the exact runnable Preview before Greptile or Main deployment. Main receives the immutable reviewed bundle through normal scoped deployment; installed system files are never patched ad hoc.

## Deferred scope

External source writes, autonomous repair, generic executable recipes, global account selection, self-hosted arbitrary PostHog origins and organization-wide sharing remain excluded. The personal application's visual design and domain correlation stay in its self-contained app code; platform code supplies only permissioned reads and durable execution.
