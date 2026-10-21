# Chat navigation loading and cache design

Status: APPROVED for implementation by user: 可以 执行吧, 2026-10-08. ENG-177; implementation stack #2299 → #2300 → #2301 supersedes closed draft #2288.
This approved extension supersedes the startup-shortcuts.md deferral of batch navigation reads and cross-reload metadata caching. Implementation and runtime acceptance are tracked in ENG-177 and its implementation stack; performance budgets below are not achieved-result claims.

## Outcome

Returning to Chat, opening another Chat window, and restarting Electron should reuse the last successful sidebar snapshot. Background synchronization must preserve visible rows, scroll position and selection. A genuinely cold list must load through bounded batch reads, without per-Chat identity requests. Preserve the approved Figma layout, PINNED above PROJECTS, stable Agents and section headers, and existing ordinary/Bot separation.

## Evidence and limits

- desktop/src/renderer/src/features/work/work-rail-data.ts:25 loads up to ten sequential 100-record pages.
- WorkRail.tsx keeps records in component state; its list effect depends on active Chat and Project selection as well as the client.
- packages/ui/src/chat-agents/bots/use-bot-conversation-summaries.ts classifies unknown IDs through directBot reads with concurrency four. bot-summary-reads.ts retains identity results for five minutes in bounded WeakMap caches keyed by client object. It does not persist across process restart.
- packages/gateway/src/chat/metadata-repository.ts:51 hydrates each selected row separately. repository.ts:315-345 reads active run, user state, completion and read state per record. service.ts:274 also awaits active-run reconciliation before listing.
- CanonicalChatRecord and list response schemas are strict. Adding unnegotiated response fields could break older clients.
- Existing exact-head native evidence: 146 ordinary rows appeared together at 27.626 seconds in one cold run. This measures end-to-end visible completion, not SQL time. It establishes a slow path, not a latency breakdown.
- Existing canonical event sources, shell snapshot cache and Electron atomic local-store writes provide reusable patterns.

## User-visible behavior

| Situation | Proposed behavior |
| --- | --- |
| Switch Chat/Project or reopen a Chat surface | Select from the shared in-memory list immediately. Selection alone makes no list request. |
| Restart with a valid same-account/runtime snapshot | Paint the complete saved list after identity is established; refresh in the background without clearing rows. |
| First use/no usable snapshot | Keep stable headers and one loading state; publish the successfully fetched cohort together. |
| Receive new Chat, rename, move, pin, delete or run-state changes | Apply an authoritative event/mutation result when complete; otherwise coalesce a background list refresh. |
| Background fetch fails | Retain last-good rows; show a nonblocking retry/offline indication. Do not replace the list with an empty state. |
| Logout/account/runtime change | Fence old requests immediately. Clear/hide the previous scope before looking up the next scope. |

Cached run/attention state is last-known, not proof an agent is still running. Keep its placement stable while synchronizing; suppress live animation until reconfirmed and expose freshness accessibly. Reuse existing connection-status UI; do not add per-row loading spinners or change section spacing. A cached item opens through the normal authenticated detail path; it never grants permission to read or mutate a Chat.

## Architecture

### 1. Dedicated bounded navigation read

Add GET /api/chat-navigation outside the /api/chats/:chatId namespace. This avoids older gateways treating the literal navigation path as an invalid Chat ID (400), and keeps generic Chat funding/metadata negotiation out of the strict versioned navigation query. A legacy runtime therefore returns a reliable unsupported 404; 400, authorization errors and other failures remain errors, never fallback signals. Return a versioned, lean navigation DTO, not a fabricated CanonicalChatRecord. Include only IDs, bounded title, title/revision fields, Project association, pin/order/activity fields, read/attention projection, source label fields actually consumed by the rail, and explicit ordinary/Bot classification. Do not send transcripts, provider credentials or execution payloads.

Use a discriminated classification: ordinary or bot with agentId. Derive it from live owner-scoped direct bindings, including bindings to archived agents. Missing/failed classification must not mean ordinary. Bot approval details may refresh separately and must not gate ordinary history.

Read up to the current bounded 1,000-row navigation window in one request; preserve deterministic activity/ID ordering and expose truncation explicitly when that bound is exceeded. Never claim a truncated snapshot represents all historical Chats. Keep the existing search/history access path. Cap title sizes and response bytes (initial budget 2 MiB); exceedances produce a safe error, never a silently incomplete success.

Use a focused navigation repository with a bounded set of bulk queries: selected Chats, user/read state, active/latest-completed runs and direct bindings. Query count must not grow per Chat. Use one read-only consistent database snapshot for the projection and reuse/extract pure business-state derivations so NEEDS YOU/WORKING/DONE and unread logic cannot drift from detail reads. Do not expand the already large repository.ts with another orchestration subsystem.

Navigation renders persisted state without awaiting provider/network reconciliation. Reuse existing authenticated event-stream startup/reconnect recovery, which reconciles before replay and delivers durable outbox corrections, plus canonical detail/admission/list/search recovery. Do not create a detached recovery task: the current orchestrator shutdown does not drain its reconciliation Map. The client event stream starts alongside navigation and revalidates the list on durable corrections. Verify slow recovery does not gate first list paint and eventual corrections update the visible state; no recovery guarantee on existing canonical reads is removed.

### 2. One scope-scoped client store

Move list ownership out of WorkRail into a shared navigation store. Its stable scope identity is independent of selected Chat/Project, component mount and client-object allocation.

Within each renderer/application scope, allow one in-flight refresh plus one dirty bit. Multiple Chat surfaces subscribe to the same store and event stream. Separate Electron renderer processes may each revalidate once; they share the main-process saved snapshot, and no cross-process live broker is required for this first version.

An idle initial load should need one navigation request. A replay/gap or recovery correction received while that request is pending must retain the dirty bit and trigger one coalesced follow-up: the response may describe a database snapshot taken before recovery. Do not suppress that invalidation to meet a request-count target. Empty stream attachment does not invalidate the list. Measure idle and replay/recovery cases separately.

Selection filters local data. Refresh on initial authenticated mount, meaningful invalidation, event-stream reconnect/gap, explicit retry, and focus when stale. Use a 60-second stale threshold and a visible fallback refresh when the stream is unavailable; never clear successful data because it became stale. Do not refresh for each token/run.message event.

Patch only from complete, revision-compatible authoritative results. A fetch started before a local mutation or newer event must not resurrect a deleted row or undo a rename/pin/move/read update. Preserve pending overlays; mark uncertain in-flight snapshots dirty and revalidate after mutations settle. Failure retains the last-good snapshot. All cancellation/publication checks include the current scope generation.

Authority epochs fence retained unread/Project/Bot summaries, identity caches, queued updates and asynchronous rail mutations. Revocation discards old state before rendering; recovery establishes fresh data without reviving earlier callbacks. Web scope follows the validated runtime transport captured at mount, including its slot, even when Shared links rewrite browser history without replacing that transport.

Stream overlays retain only monotonic metadata and independently versioned title/read clocks. Pin choices, completion acknowledgement and other server-owned fields remain authoritative; confirmed reconciliation resumes persistence. Automatically restored cached selection is distinct from explicit user choice: fresh complete exclusion or a confirmed not-found repairs only automatic selection; truncated absence alone proves nothing.

### 3. Reconstructable persistent snapshot

Canonical data remains in owner Postgres. Persist only a disposable UI projection:

- Electron: separate versioned JSON snapshot under app userData, accessed through validated main-process IPC. Reuse async serialized atomic-write patterns, private file permissions, bounded reads and symlink-safe cleanup.
- Web Desktop and Web Canvas: the same schema/policy through a bounded browser-storage adapter following the existing shell snapshot pattern. Storage denial/quota/corruption falls back to memory.
- Shared UI consumers reuse the projection and freshness model; check Native Mobile consumers during wiring and document any platform adapter limitation instead of duplicating business rules.

Key by verified user ID, platform identity, runtime handle/slot, ownership scope and schema version. Include any existing runtime-instance discriminator if available. Authentication generation fences outstanding reads/writes but is not part of the durable key, so ordinary token renewal/restart can reuse a snapshot. A renderer cannot supply another user's authority through a cache key.

Defaults: 1,000 rows and 2 MiB per scope; at most three persisted scope snapshots, LRU eviction, 24-hour maximum age. Browser adapter may retain fewer entries if its bounded storage budget is reached, but must mark that cache as partial and must not publish partial ordinary cohorts as a complete list. Prefer retaining the previous complete snapshot or skipping persistence rather than writing a new partial snapshot. Sweep on load/write and with bounded symlink-safe recurring maintenance; delete expired/corrupt/version-incompatible files. Serialize maintenance with cache operations, prevent timer backlog and stop its timer before draining on shutdown. Memory stores have the same bounded scope/row policy.

Persist successful complete snapshots with a coalesced write after paint. Logout removes that user's snapshots and cancels pending writes; runtime switches hide the old scope before hydrating the new one. Authentication revocation clears/hides affected data. Delayed work cannot recreate signed-out data.

Electron constructs the snapshot cache after authentication initialization. If initialization already confirms signed-out or revoked authority, explicitly purge retained personal snapshots: there may be no earlier identity-change callback to observe. Account replacement and logout purge all account partitions; ordinary runtime switches retain separate same-account partitions while fencing outstanding work. A navigation 401/403 hides and clears the affected snapshot; a temporary 5xx keeps the last successful list available.

Persist personal, owner-visible list metadata only. Shared-with-me/org membership-dependent rows remain memory-only until a valid membership check; do not resurrect revoked collaboration access from disk. No transcript cache, tokens, approval actions, raw provider responses or new embedded database. No new Keychain prompt for a disposable title cache.

## Authentication and compatibility

| Boundary | Authentication / validation | Public |
| --- | --- | --- |
| GET /api/chat-navigation | Existing verified principal; derive owner server-side; validate bounded query/version; owner-qualified SQL and binding reads | No |
| Cache read/write IPC | Trusted renderer IPC; active main-process verified auth/runtime scope; strict versioned payload/size validation | No |
| Event subscription | Existing canonical authenticated event source and ownership filtering | No |

Keep private, no-store HTTP headers. Application snapshot reuse does not permit HTTP intermediary caching.

Leave legacy /api/chats and /api/chats/:id/bot response shapes unchanged. A new client may fall back to the legacy cohort loader only on a confirmed unsupported endpoint response, not on authentication failures, rate limits or generic server errors. Fence capability results to the runtime/version/session and bound their lifetime. Old clients continue working with a new server. New clients on old servers gain warm snapshot reuse but retain the slower uncached legacy path; report that limitation honestly.

## Acceptance and measurement

Performance budgets are targets to validate, not achieved results:
- Same-scope memory navigation: no clearing and zero list/identity requests caused only by selecting another Chat/Project.
- Persisted list: visible within 200 ms of verified account/runtime readiness on the review Mac, even with a deliberately delayed server.
- Roughly 150 Chats on a healthy Preview runtime: one navigation list HTTP request, zero per-ID Bot classification requests, target cold visible list within 2 seconds under recorded network conditions.
- Bounded DB query count at 1, 150 and 1,000 rows; no per-row query growth.
- No incremental ordinary-row popping, Agent disappearance, lost DONE rows, scope leakage, resurrected deletions or stale optimistic updates.
- Cmd+N mode, Project vertical layout, long-title hover behavior and Figma spacing remain unchanged.

Instrument auth readiness, cache read, list request, DB projection, reconciliation and render commit separately using counts/durations, not titles or message content. Record at least five cold, five restart-cache and five warm-navigation trials with median/range; do not report a p95 from five samples. Diagnose a missed budget before claiming completion.

Test malformed/expired/oversized caches, quota/disk failures, logout during write, account/runtime switches during requests, Bot archive/removal semantics, old/new client-server combinations, event gaps, rapid mutation plus refresh, and revoked access. Use real Postgres integration tests for query/auth behavior.

## Delivery and rollback

After design approval: update ENG-177 and its implementation stack in English, add failing tests, implement independent API/store/cache changes, and update the existing public docs companion PR. Backend changes require exact-version Preview VPS plus packaged Electron validation before Main computer acceptance. Do not silently deploy to Main computer during testing.

Supply an exact-head named App and manual review flow. Obtain user review, then run authorized fresh Greptile/CI gates before merge. Disable the navigation capability to fall back to the existing loader; deleting snapshots is safe because they are reconstructable. No user-data migration or provider-routing change is required.

Out of scope: full offline conversation history, database replacement, Redis, UI redesign, provider login changes, unlimited-history loading and new collaboration persistence. No unresolved product questions block presenting this proposal; latency attribution and recovery-path extraction remain explicit engineering checks.

## Native acceptance correction: embedded content list ownership

Native warm-selection measurements found the embedded canonical content controller still re-reading its separate legacy list on each selected Chat. When `externalNavigation` is set, WorkRail alone owns the list; skip the route-availability list probe and controller list refresh, while retaining authenticated detail reads, completion acknowledgement and event/reconnect detail recovery. Standalone canonical history/search keeps its current loader. Direct Bot-binding reads for the selected conversation remain detail reads, not per-row navigation classification.

Large-file extraction plan: this patch adds only the existing external-navigation flag wiring to the 1,000+ line workspace. Keep the loader ownership guard in the focused controller; future controller behavior must extract list state/loading and detail/replay orchestration into separate hooks before extending the workspace or controller further. No unrelated rewrite is needed for this measured duplicate-read correction.
