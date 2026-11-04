# ENG-93 scheduling experience

Ticket: https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent
Stack: https://github.com/HamedMP/matrix-os/pull/3054
Baseline: e7f258a6b17dccd407dfe2f47c107ee5b65a8a99. Historical live evidence remains tied to that client and Host 7203569a.

## Approved product requirements (2026-11-01)

1. Scheduling is available without a Settings Allow schedule prerequisite. Approval in Chat authorizes one exact schedule; it never grants arbitrary background work or activates other tasks. Existing owner/account/Computer/source/revision boundaries remain.
2. Show an understandable schedule approval: task, Bot, Computer, frequency/time zone/next run, effects, subscription use, and how to stop it. Raw JSON belongs in collapsed details. Approval remains explicit, revision-bound and server-authoritative.
3. Provide a Schedules entry in Chat, shared across Web and Electron, with owner-scoped listing, pending/active/paused/archived and actual run outcomes, details/history and revision-safe management. Edits require a fresh approval. Delete means recoverable archive.

## Design

Reuse the existing Chat agent typography, semantic surface/muted/border/accent tokens and focus treatment. Left-align task content; use a compact definition list for schedule facts, one primary action, and a quiet secondary Cancel. Wrap long task text and stack actions at narrow widths. Preserve visible expired/unavailable/error states. The same summary vocabulary is shared by approval and management views; do not imply that JSON or model text establishes authority.

## Authorization design

Do not set all saved background grants true. Native interactive connection remains required, while the ability to execute explicitly approved routines is negotiated separately from general background access. Old strict peer messages remain compatible: capability extensions are requested and echoed before any new request fields are emitted. Missing support cannot break ordinary Chat or imply approval. At the actual inference boundary, derive the current occurrence from durable approval/routine/fire/task/source/lease state; worker/model fields never grant authority. Revocation, cancellation, disabled sources and changed revisions still fail closed.

No production account/grant migration or real permission change is part of implementation. New permission UI acceptance requires matching client/Host and the existing narrowly approved test fixture; current e7 live evidence does not qualify the new head.

## Verification seams and sequence

The user's requested regression scope is UI decisions, public client/HTTP/IPC boundaries, and actual durable scheduling/inference; retain existing isolated PostgreSQL and compiled-process tests. Work in vertical red/green slices:

- Public InteractionCard: readable exact schedule, no primary JSON, explicit decision/revision, repeated clicks, failure/retry, expired or invalid payloads and narrow layout.
- Native/peer capability negotiation and live inference authority: fresh explicit routine approval works without broad background permission; arbitrary background, stale/foreign/revoked/paused/archived or unapproved requests fail; old peers retain interactive compatibility.
- Owner-scoped center routes/client/component: bounded list and history, pending requests, target failure, concurrency conflicts, pause/resume/archive and approved edits. Preserve other owner/organization isolation.
- Activation continuation: authoritative persisted phase prevents a newly activated schedule being described as pending; do not inject approval from user/model text.
- Independent review; affected targeted suites, type and patterns; fresh matching-build/live/English media evidence kept separate from CI.

Public documentation requires a separate follow-up in private FinnaAI/matrix-os-site content/docs once behavior is validated. No Slack, merge, APPROVE, production deployment, unrelated branch changes, external accounts or real grants during local implementation.

## HTTP authority and management semantics

| Route | Authentication / owner source | Boundary |
| --- | --- | --- |
| GET /api/bot-routines | Existing authenticated request principal; owner never accepted in query | Current Computer's owner-only personal tasks, 32 per page; private direct Chat pending approvals |
| GET /api/bot-routines/:routineId | Same principal, validated ID | Owner lookup; foreign records return not found; latest 20 fires |
| POST /api/bot-routines/:routineId/control | Same principal, bounded body, validated status/baseRevision | Existing revision-bound pause/resume/archive; active occurrence cancellation unchanged |
| POST /api/bot-routines/:routineId/review | Same principal, bounded typed edit | Only name/prompt/schedule; current source/model/effects retained; creates one deduplicated owner review, no change until approval |
| Existing interaction resolve | Existing designated responder and revision | Rechecks private target, source and definition; exact edit target/base revision is included in digest; transaction rolls back stale or in-flight edit |

The center is scoped to the selected Computer, not an aggregate of every remote Computer. Archive preserves audit history and cannot resume. Edits preserve paused status; the old schedule continues until approval, so pause first to prevent a concurrent occurrence. Existing running/uncertain occurrences must settle before changed instructions apply. The server, not Chat prose, projects current approval/lifecycle counts into ordinary personal Bot Chat. That context conveys no execution capability.

## Required version and evidence

Both Electron Native and Gateway change. Capability negotiation preserves ordinary interactive Chat across old/new versions, but default scheduling requires both new components. No saved grant is upgraded automatically. A failed explicit revocation must fence the in-memory revision even when its broad background bit was already false. Existing e7/7203569 media is historical only. New affected-surface captures, native PG, CI and Greptile must each identify the new commit; none can stand in for another.

## Native Mobile parity layer (2026-11-01)

Native Mobile has its own Bot Chat renderer, so it is affected and is not N/A. Reuse the same browser-safe routine client/parser/recurrence formatter through explicit package subpaths; do not import DOM components or create another scheduler. The Agents tab gains one Schedules destination for the selected Computer. Native approval shows the task, exact Bot/Computer, recurrence/timezone/estimated next run, effects and subscription use, with collapsed technical details and explicit owner approve/cancel. It never enables a global background grant.

The owner + Computer keyed route discards previous-scope UI. Authenticated requests retain the selected runtime query, use the normal token/timeout transport, and accept no owner input. The bounded list/history and revision-bound pause/resume/confirmed archive/edit-review use the existing HTTP services. Drafts survive errors and saved-revision refreshes. Returning from a review resolved elsewhere requires an explicit new review. Late editor receipts refresh the current filter without reopening closed details, accepted revisions do not regress, failed detail refresh keeps controls fenced, and approval lifecycle is checked at the time of a press.

Native component/request regression evidence is separate from device acceptance. All five surfaces still need current-version screenshots and a short recording, including a real Native Mobile development client; web captures cannot qualify it. No native dependency, plugin, entitlement, account or permission changes are introduced. The frozen-lockfile local dependency restore changes no manifest or lockfile. Full Native Mobile TypeScript is not green: the configured frozen global-store install reports 59 baseline diagnostics, reproduced with identical normalized output against pristine Native Mobile sources at 69ff9654 and the same dependencies; changed files add no diagnostics. An earlier isolated CI-mode install reported 12 different baseline test-prop diagnostics; that earlier layout does not qualify the current install.

Closed edit reviews reveal the retained draft without automatically requesting a replacement. A shared, bounded and cleaned-up review clock updates both Web/Electron and Native Mobile at expiry; an unexpired saved-answer recovery remains recoverable. Return to draft stays fenced while a submitted decision is unconfirmed. Both renderers share task-state and next-run presentation: an active one-time task with no next fire says None scheduled, not paused or archived. Display helpers confer no execution authority.

## Reliability repair and full-flow capture (2026-11-02)

The requester authorized repair of failed natural-language creation, contradictory approval acknowledgements and paused-time replay, followed by a complete `product-demo-video` capture. Keep ENG-93, stack3020 and the existing private acceptance Preview/Bot; preserve all earlier failure evidence.

- Build the model-facing proposal from task content/timing/effects and the server-admitted worker model. Do not ask the model to choose the source binding. The broker contract stays unchanged and still verifies the exact route, owner, source and grant. Validate a mismatched route in dispatcher preflight, before creating an unknown-effect checkpoint; do not weaken generic unknown-effect recovery.
- A resolved schedule approval continuation receives a deterministic canonical Chat acknowledgement from durable owner/Chat/task/run/approval records, before allocating an inference runtime. It records the decision and directs the person to current Schedules state; it never claims a revoked or paused task is running. Ordinary messages, forged activation text, unrelated approvals and group Chats retain their current behavior.
- A paused recurring task resumes at the next future occurrence, without replaying time spent paused. An elapsed one-time task needs a newly approved time and remains paused. Compute the future time under the existing routine lock/revision fence. No new grants or automatic retries of unknown effects.

Rejected alternatives: prompt-only reminders still leave model interpretation on the successful approval path; globally converting dispatched errors to safe refusals would erase effect uncertainty; silently rewriting a mismatched broker request would hide binding drift. Reuse canonical task settlement and events rather than adding a second execution/notification path. Extract the approval acknowledgement query from the large orchestrator into a focused helper; the entrypoint only coordinates it.

Verification: fault-detecting worker schema/request, dispatcher preflight, durable approval acknowledgement and resume regressions; relevant runtime/gateway suites, types/patterns and isolated native PostgreSQL; independent review and exact-head CI/Greptile. Record the normal-language proposal (without model IDs), owner approval, current task center, real fixed-text fire, pause with no fire, edit cancellation, resume with a future slot, second fire, archive and disconnected connection readback. Capture real Electron Desktop, English captions and the complete timeline; identify any speed changes or cuts. Keep media outside Git and deliver only redacted private Library links. Matching Host/runtime bits are needed for these backend repairs; the earlier layout-only correction did not need a Host update. Never use old recordings as new-head evidence.

## Schedule navigation follow-up (2026-11-02)

The requester and Nima identified that selected details repeated the same schedule's list card. Preserve approved #3084 and add one frontend-only stack layer. Use a list → details journey with a Back action, rather than an expanded duplicate card or a second history inbox. Schedules contains saved task definitions, status, timing and revision-bound management; execution messages and history remain in the task's existing private Bot Chat. The target Bot name opens that exact saved Chat without creating another conversation; there is no standalone View history action. Archived task definitions remain inspectable.

New schedule opens the existing Agents selection so the owner can choose a private Bot and describe the task/timing in Chat. This navigation neither creates nor activates a routine, sends a prompt, enables background access nor bypasses owner approval. Keep edit review and existing owner/source/target/revision checks. No new HTTP/IPC schema, persistence or Host build is needed. Apply the same information architecture to shared Web/Electron and Native Mobile, with narrow layouts and safe loading/error/recovery.

Implementation plan: first reproduce visible list/detail duplication and misplaced run history in component regressions; then separate the views, add Chat/history and new-schedule navigation, and verify failed navigation, unavailable targets, late responses and edit recovery. Run related component tests, applicable types/patterns and React audit, independently review the change, then publish a dependent Draft layer with fresh CI/Greptile and affected-surface evidence. Old #3084 recordings are before-state only. The separate public docs deliverable remains in FinnaAI/matrix-os-site after the final UX is qualified; do not recreate docs in this repository. Nima's feedback is the stakeholder input, not permission to merge.

Native history navigation carries the saved Chat ID and owner/Computer scope into the existing Agents Chat, which retains its approval cards. The destination verifies the binding with the existing read-only GET; cached status IDs, missing bindings and retries cannot create or select a replacement Chat. Scope changes immediately fence the read. Ordinary Agents get-or-create behavior remains unchanged.

### Inline scheduled messages (requester correction, 2026-11-02)

The requester rejected the top-of-Chat history disclosure and supplied the earlier Codex scheduled-message appearance as the reference. This supersedes the disclosure and the standalone View history action described below: do not add a second history browser above or below Chat. Put a small clock and “Sent by scheduled task” directly above the actual scheduled input bubble. Keep its original prompt, timestamp, normal bubble width, response and ordinary message actions. Long input expands in place. Schedules remains a task-definition list/details/management surface; its target Bot can link to the exact existing Chat without a special history action.

Bind the marker using the persisted canonical turn request ID and an exact owner/Computer/Chat-scoped durable fire, never matching text or nearby timestamps. Pre-admission failures without a canonical turn remain read-only occurrence messages at their scheduled time; say “Scheduled task did not run,” retain generic failure/uncertainty information, and never invent an assistant answer, claim a message was sent, or offer unsafe replay. A later canonical turn replaces that projected occurrence instead of duplicating it. Preserve manual messages, approvals and all existing authorization/revision fences.

Implementation: replace the history-browser loader with a bounded read-only occurrence loader over existing current/archived list/detail APIs; use a shared identity/timeline helper and matching message-level Web/Electron/Native renderers. Load a bounded recent window, fence late scope responses and label any incomplete/error read honestly. No backend, scheduler, contract schema, grant or Host update. First reproduce missing inline markers and invisible unadmitted failures with real transcript components, then verify exact identity, duplication, chronological placement, ordinary messages, small-screen expansion and failure recovery. Rebuild the affected frontend, compare against the supplied reference, and obtain fresh redacted evidence; previous825 screenshots and G5 do not qualify this correction.

### Preserved occurrence records in messages

The original history-browser presentation is removed, including its Current/Archived/Refresh controls and both header/footer renderers. Equivalent retained protections are exercised by the inline transcript and bounded occurrence-loader regressions: exact Chat filtering and detail identity, archived pagination, unavailable Bot definitions, late scope responses, repeated render stability and read-only failures. Filter-selection/loading tests are obsolete because that separate browser no longer exists.

Existing APIs return up to20 recent fires per routine. Read at most4 current and4 archived list pages, keep at most32 matching tasks of each kind, fetch at most4 details concurrently and retain at most1280 recent occurrence records. Refreshes reuse unchanged detail snapshots and never overlap. Scope changes dispose the cache and fence late responses. A failed read shows fixed generic copy and preserves already read records from the same scope; truncated reads are disclosed in the message flow. Older fire pagination requires a separately scoped API improvement and is not invented by this frontend change.

Keep exact saved Chat navigation for unavailable Bot definitions. No archived Bot, routine or grant is reactivated. Native's retained Chat→Bot lookup remains GET-only and the unavailable Bot composer remains read-only.

### Direct Bot selection for New schedule

Live Electron validation showed that a saved card in the ordinary Agents management library opens its editor. New schedule therefore uses a dedicated, bounded owner Bot picker: selecting an unarchived Bot opens its existing canonical private Chat through the normal idempotent direct-Chat service, without editing the Bot, replacing a draft or sending a prompt. The separate Create or manage Bots action retains the existing management/setup flow. Guard repeated clicks and late resolutions after leaving the picker; show generic recoverable errors. Native Mobile's existing Agents list already opens its Chat rather than an editor.
