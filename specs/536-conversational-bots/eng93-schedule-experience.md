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
