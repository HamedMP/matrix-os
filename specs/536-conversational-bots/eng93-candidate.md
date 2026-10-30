# ENG93 minimal personal routines candidate

Continues the approved M2 slice of spec.md. Local candidate only; no rollout or live qualification is claimed.

## Scope and wiring

Only a personal, active, non-collaborative direct Bot Chat qualifies. Delivery stays in that same Chat. Existing Pi Bot execution, canonical task state, run cancellation, outbox and one-run-per-Chat queue remain authoritative. No multi-runtime framework or ENG209 dependency is introduced.

A model may propose intent; an owner approval displays the exact timing/timezone, prompt, allowed effects and server-selected subscription account/grant/computer/definition revision. Activation consumes the existing exact approval atomically with owner-local durable routine creation. Recurring execution must continue to resolve that exact subscription with explicit background consent; it never substitutes a newer grant or another funding source. Integration grants and exact action/account/audience approvals still apply to every call.

The large server entrypoint receives one composition call only. Scheduling, trusted run correlation, effect admission, cancellation and lifecycle logic are extracted into routine-execution.ts and its focused helpers; no new execution logic belongs in server.ts. Startup registers the services before the canonical adapter, then starts the bounded dispatcher only after the canonical orchestrator exists. Shutdown drains scheduling before peer/runtime/DB ownership is released.

## Security and controls

| Boundary | Authority | Limits / refusal |
| --- | --- | --- |
| routine.propose / routine.control broker tools | Interactive, registry-bound private Bot; owner/bot/chat/task/run from server binding | Strict intent schemas, existing broker action budget; background and managed ordinary Chat cannot self-schedule |
| approval decision | Existing authenticated designated-responder interaction route | Exact digest, source, task, bot and audience; transactional one-time claim |
| GET /api/chat-agents/:agentId/routines | Existing request principal, owner scope | Validated IDs, max32 routines and max20 fires each, private no-store |
| POST /api/chat-agents/:agentId/routines/:routineId/control | Existing request principal, owner scope | Strict revision/status/IDs, bodyLimit64KiB, generic errors, transactional authority-change event |
| canonical scheduled adapter start | Durable server fire correlated through canonical client request ID | Only first run attempt, queued claimed task, exact approved prompt/selection restored server-side |
| every model/tool boundary | Live fire/task/lease/source/definition and approved effect envelope | Unknown effects, nested native tasks, custom MCP, missing/revoked authority fail closed |

Pause/cancel fences future work durably before requesting canonical cancellation of its exact queued/running task. Resume authorizes future occurrences only; it never replays an uncertain effect. Cancellation failure remains uncertain and visible. Existing owner authority view reads active/paused routines from Postgres, while the status endpoint retains recent fire failures.

## Ownership, recovery and review findings

Occurrence identity is unique per owner/routine/scheduled time. Claimed-to-dispatched is a conditional write. A stale pending snapshot may settle only a still-claimed fire. Live/direct Chat and held-occurrence filtering happens before the bounded32-row page. Invalid claimed rows are closed in bounded batches. Cron obtains a fresh consistent clock per claim, retaining the stored occurrence identity after DB delay.

Leases bound execution authority; expired dispatched fires become uncertain and close their task, and uncertain occurrences continue to hold that routine's unfinished gate. A late worker cannot pass the broker's live fire/lease/task check, and another scheduler cannot launch its next period. This is conservative reconciliation, not renewal/replay or proof that an external in-flight call was rolled back. Unknown effects require review. Finalization also checks durable non-read checkpoints in the same transaction: dispatched/effect_unknown writes or sends override worker success/cancellation to an uncertain fire. The canonical scheduled run then shows a non-retryable failure. Recovery uses this same finalizer and outbox transaction, publishing only actual state transitions.

Only a server-side scope admission capacity refusal before bot.run may be retried, at most twice with 30/60-second backoff. Each attempt has its own canonical request ID and reuses the same durable task/fire; a capacity-blocked task can only be resumed by the exact approved retry. Queue cancellation addresses the current attempt before considering any retained prior run ID. No generic thrown/ambiguous outcome is replayed. Candidate tests use PGlite, fake scope hosts and controlled interleavings/clocks; real multi-connection Postgres and real runtime/device evidence remain separate gates.

## Qualification still required

Complete targeted unit/type/pattern checks and independent review of the final bytes. Preserve exact source/version and report any unavailable checks. Real Postgres contention, gateway/update restart, grant revocation, pause/resume/cancel and supported-surface live evidence remain prerequisites to release qualification. Do not create real jobs, call real models/mail, write real grants/credentials, deploy, push, run Greptile or full CI in this task. A separate matrix-os-site documentation PR follows verified behavior.
