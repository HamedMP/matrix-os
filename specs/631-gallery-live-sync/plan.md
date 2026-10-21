# Gallery import progress and ongoing updates

Tracking: [ENG-324](https://linear.app/matrix-os/issue/ENG-324/show-live-gallery-import-progress-and-keep-selected-accounts-updated), under [ENG-174](https://linear.app/matrix-os/issue/ENG-174/qualify-owner-scoped-resumable-app-data-imports). Hamed explicitly requested ongoing updates on 19 October 2026, extending the parent's earlier manual-only scope. Product/integrations owner review is recommended before rollout.

## User outcome

Replace the unacknowledged Chat handoff in every connected Gallery starter with a durable accepted import, account progress, confirmed saved-row counts, last/next checks, and pause/retry/account controls. Manual-only apps keep their existing workflows. Selecting Work groups owner records and grants no organization access.

Gmail-only selections check mailbox history IDs every minute without starting another AI run when unchanged. Other selections check every 15 minutes. These are scheduled checks while the Matrix computer is running, not instantaneous provider push subscriptions. Imported rows refresh while processing and after completion. The cadence and AI usage are disclosed beside the ongoing-update choice.

## Implementation and invariants

- Canonical catalog and installed manifest define the app. Exact connection ID, label and email snapshots are revalidated before each account. Imports retain the established read-only owner-agent route and prompt protections, manual-field preservation, deterministic IDs, deduplication and conditional updates.
- Owner Postgres stores one bounded configuration per app (40 maximum), UUID idempotency, current run, account stages, mailbox checkpoint and next check. Starts and claims are transactional. All progress/finish writes compare the current run and unexpired lease. Initial queued work precedes scheduled checks.
- A single worker dispatches the existing kernel with an eight-minute deadline. The database lease lasts ten minutes. Pause fences progress and aborts the active run. Shutdown aborts/drains before the shared database closes. Expired runs become interrupted and require an explicit retry; no uncertain AI run is silently replayed.
- Completion requires a valid bounded terminal report and an owner-database verification of rows bearing the current importRunId. Counts come from persisted records, not the model. Partial, denied and failed work stops scheduled AI retries. Source coverage is still the importing agent's report; real-provider qualification is required.
- Progress measures accounts processed and finished tool steps. It does not invent a page denominator or percentage of unknown mailbox contents. Raw tool input, private source content and credentials never enter the progress UI.
- The shared owner-import composition was extracted from server.ts into startup/owner-imports.ts; new orchestration, routes, persistence and upgrade behavior live in focused modules. No new orchestration is implemented in the large server entrypoint.

## Authorization matrix

| Route | Methods | Authority | App host restriction |
| --- | --- | --- | --- |
| /api/app-gallery/:appId/sync | GET, POST | Verified runtime owner; no opaque-origin/app-session access | Exact starter's own app ID only |
| /api/app-gallery/:appId/sync/pause | POST | Same owner | Exact same app |
| /api/app-gallery/:appId/sync/retry | POST | Same owner and live selected connections | Exact same app |
| /api/app-gallery/:appId/sync/resume | POST | Same owner and live selected connections | Exact same app |

All mutation bodies are streaming-limited to 16 KiB and strictly validated. Control actions accept an empty object. Requests contain selections, never executable prompts or transport credentials. Web and Electron use the same exact-path policy; aliases, other app IDs, query/fragment/path tricks and direct provider access remain denied.

## Existing installed starters

A bounded signature of the previous source and compiled template is shipped in home/system/gallery-starter-legacy.json. It was generated from commit 25b2f3c8d1519bf9724ce7df563e4d6eb8622eea using the starter's frozen lockfile and Vite 6.4.3. Startup upgrades only an installed canonical starter whose definition, source and old compiled assets match that known template (or already-copied new bytes after an interrupted upgrade). Unknown/customized apps are preserved and logged for explicit follow-up.

The existing owner-file mutation lock covers verification/publication. Private bounded staging and pinned directories avoid symlink traversal. Existing additional files, icons, definition, manifest and all Postgres data are retained. Source/assets publish before the runtime HTML; old assets remain available during copying. Publication is resumable without deleting owner files. Direct concurrent same-UID filesystem changes retain the installer's existing privileged boundary.

## Verification and release gate

Tests cover durable acceptance/idempotency, owner/account isolation, scheduled incremental ranges, unchanged mailbox suppression, source revocation, partial/failed output, concurrent claims, pause fencing, interruption, schema/path/body limits, all 23 connected starter identities across Web/Electron, UI restoration/reload, and preservation of customized installed apps.

The local synthetic preview is preparatory evidence only. It uses test accounts, an injected bridge and synthetic completion; it is not a live Gmail import or installed-host qualification. Captures are under evidence/. Runtime/client matching, real records/save/reopen, unchanged-mailbox checks, new-mail arrival and failure/retry must still be captured on Web Canvas, Web Desktop, Electron Desktop and Web Mobile. Native Mobile has no new bridge implementation here; its unavailable state remains and requires an explicitly reviewed launch disposition, not a parity claim.

A separate FinnaAI/matrix-os-site documentation PR is open at https://github.com/FinnaAI/matrix-os-site/pull/274. Its preview passed 375px, 768px and 1360px overflow checks and current-head Greptile 5/5. Keep both PRs draft until the implementation's current commit has Greptile 5/5 and the per-surface live screenshots/recordings and tech-channel evidence are linked.

Hamed explicitly selected the `hamedmp` main computer for live qualification on 19 October 2026. Use a reviewed exact-version bundle through the supported updater, preserving owner data. This authorizes that one test target, not a fleet rollout. The local workstation is a separate `hamedmp-dev` self-host; cloud sign-in is pending before accessing the main computer.
