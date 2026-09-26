# Spike Protocol: Two Conversational Bots Powered by Pi

**Status**: Planned; not executed.
**Sequence**: Publish and review spec on GitHub -> qualify the bounded spike -> report evidence and decision -> plan production implementation. Publication alone does not mean the spec is approved or the spike passed.

## Entry Gate

Start only after this spec is published, the owner has accepted the spike scope, and a follow-up execution task is started. Record the spec commit SHA and PR URL in the spike report. No runtime installation, model spend, VPS creation, or implementation is part of the specification PR.

The spike tests uncertain implementation choices after the user-visible contract is written. No undocumented Pi behavior becomes a production assumption before this gate completes. Tests precede implementation; isolated probe code and sanitized evidence ship in a separate PR/worktree.

## Question to Answer

Can a Matrix-owned Pi runtime support two persistent conversational bots that progressively request integrations, act through a real computer, collaborate in a group, and recover without losing authority or duplicating effects, while preserving existing Matrix Chat and Provider V3 ownership?

## One Coherent Demonstration

Use Research Rabbit (an original Competitor Watch recipe) and Brief Rabbit (an original weekly-brief recipe). The owner asks for a competitor update and a brief prepared for the next meeting.

1. Select each recipe. Create its durable identity, rabbit avatar, and direct chat immediately, with no form or model selection required.
2. Research Rabbit asks which competitor/product matters. The owner supplies a synthetic company and corrects a preference; the bot remembers the correction after reopening Chat.
3. The bot discovers an already connected dedicated test Gmail account and asks for a scoped read grant if absent. A seeded email holds a source attachment/reference. No unrelated inbox data is fetched.
4. Calendar is initially disconnected. When meeting timing becomes relevant, request it through an inline Connect action. First cancel and continue the independent research; then connect from the same chat and verify the original task resumes. Use a dedicated test account, actual broker/OAuth completion, and a seeded calendar event. An unavailable real account leaves this acceptance case blocked; a fake OAuth success is not a substitute.
5. Visit a controlled external test website with no connector. Exercise browser interaction and persistent login. Download a seeded document using a graphical file dialog or another deterministic visual-desktop task that requires screenshot-based action outside the DOM.
6. The owner creates one group and invites both bots. Ask Research Rabbit to pass the sourced findings to Brief Rabbit. Share only the explicit findings artifact; no private email body, account identifiers, or direct-chat history is implicitly forwarded.
7. Brief Rabbit writes a concise workspace artifact, verifies its existence and readable content, and posts the result with its own rabbit identity. Both bots receive only their scoped tasks and grants.
8. Ask to send the brief to a dedicated test recipient. Create the exact reviewable draft and wait for approval. Deny once; approve a second proposal in the controlled test account. Verify the sent record rather than trusting assistant text. No messages go to real customers.
9. Explicitly ask for one follow-up in two minutes. Persist that one-shot trigger, restart the gateway before it is due, and verify that the supervised runtime claims it once. If a required gateway tool is unavailable, retain a blocked task and resume after verified reconnection; do not pretend the tool remained available.
10. Inject interruption, revocation, and duplicate-delivery cases below. Reopen from another supported surface and inspect truthful state and persisted history.

## Work Packages and Evidence

| Step | Hypothesis | Required evidence | Failure decision |
|---|---|---|---|
| S0: dependency probe | A pinned compatible Pi package set supports text/image tools, blocking tool policy, steering, cancellation, compaction, and context reconstruction | Version/lock manifest, exported-type checks, real-model text and image tool calls, denied-call nonexecution, reconstructed tool/result pairs and compacted context, bounded cleanup trace | Stop and report incompatibility; evaluate SDK alternative without widening the product scope |
| S1: bot creation/setup | Canonical Chat can persist bot identity, conversational preferences, and pending interactions without a form | Failing-then-passing contract tests, lost-response creation retry, reopen recording | Fix identity/state model before adding integrations |
| S2: broker connection | Existing broker can correlate a connection/grant to the correct pending bot task | Actual test-account OAuth and selected-account read, cancelled/duplicate/forged completion tests | Mark integration gate blocked; fixtures do not prove live behavior |
| S3: computer use | Pi can observe images and reliably operate the isolated Linux computer | Real model screenshot->action->screenshot trace, saved artifact, takeover/fencing and egress tests | Browser-only success does not pass desktop gate |
| S4: group collaboration | Two named bots can complete bounded assignments through canonical shared state | One parent task, attributed messages, one handoff/result chain, shared artifact, no private-context leak | Redesign participant/context authority before expanding bot count |
| S5: durability/approval | Worker and gateway restarts preserve waits, claim one durable wakeup, and avoid duplicate effects | Fault-injection traces and exact external-effect reconciliation | No autonomous rollout if uncertainty produces blind replay |
| S6: surface qualification | One shared flow works across applicable renderers | Exact-revision recordings and scenario results per surface | Partial surface evidence remains partial; no parity claim |

Implementation ownership when the spike is later assigned: contracts/state, worker/tool broker, computer executor, and shared presentation should have clear module boundaries. This plan does not start parallel agents or assign workers now.

## Failure-Injection Matrix

1. Retry recipe creation after losing the response: one bot/direct-chat pair; conflicting request payload rejected.
2. Kill the gateway during an active tool call: reattach an exact live worker or recover a checkpoint; no second dispatch of an uncertain action.
3. Kill the worker after an external send but before completion persistence: inspect the test service's sent record or surface effect-unknown; never resend automatically.
4. Restart while waiting for account choice or approval: preserve the original interaction identity and designated responder; stale answers reject.
5. Duplicate the verified OAuth completion and forge an unrelated owner's completion: one continuation for the former, no account attachment for the latter.
6. Revoke the bot grant or remove it from the group while work is queued/running: recheck before the next effect and publication; private data cannot enter group context.
7. Put malicious instructions in the source email/page: they cannot create grants, read control credentials, or trigger a new external recipient.
8. Have two bots request the same desktop/profile: only the lease holder mutates it; stale fenced actions reject after user takeover.
9. Cancel the parent task: stop descendants and queued actions; report uncertain termination without releasing in-use resources.
10. Exceed task/handoff/action/budget limits; simulate slow subscriber/model timeout: bounded termination and recoverable canonical state.
11. Block required service/model, exhaust funds, fail artifact writes, and return an empty successful query: distinguish each from successful completion.
12. Deliver the same one-shot trigger twice across gateway restart: one task claim; missed-deadline behavior and unavailable-tool recovery remain explicit.
13. Attempt a cross-owner group read with no grant and a revoked-viewer control action: reject both without revealing private metadata.

## Testing, Measurement, and Pass Criteria

- Write deterministic Vitest contract/security/fault tests first. Use Postgres/Kysely for durable-state and concurrent-claim tests, plus the actual broker and worker boundaries for end-to-end wiring tests.
- Run one end-to-end path from recipe selection -> persisted bot -> conversational question -> integration resolution -> canonical run -> Pi tool call -> group handoff -> artifact -> reconnect. Mocks may test failures; they do not qualify the live path.
- Run the complete demonstration three times after fixes. Require 3/3 successful final repetitions of setup, scoped integration reads, visual computer work, and group artifact completion, plus all safety/fault cases. Keep earlier failures in the report.
- Record per-run model/access source, active versus human-wait duration, tool count, retries, tokens/currency, interventions, observed effects, and artifacts. Do not claim lower cost or higher performance from package choice alone.
- Budget: no more than two engineering days for the initial feasibility attempt. Stop at the timebox and report partial/blocked findings instead of expanding scope silently. Before live calls, record a model spend cap and VPS lifetime/cost cap approved for the execution task. Fixtures incur no model-spend assumptions.
- Compare one representative research task with Hermes using the same model where both support it, equivalent inputs/tools, and identical completion criteria. If that comparison cannot be controlled, label it incomparable; three runs are a feasibility signal, not a benchmark.
- Surface order: Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile. Use shared contracts/presentation and exact surface names. Native Mobile Chat must receive the same attributed result and pending actions; if unavailable, record the limitation and leave full surface acceptance open.
- Run applicable typechecks, pattern checks, focused/unit suites, production builds for touched surfaces, and React audit for changed React files. Target 99-100% coverage for introduced kernel/gateway logic; report actual coverage and exclusions.
- Execute on a disposable VPS through the normal host-bundle path for the integrated slice; local fixtures and isolated package probes are additional evidence. Do not install into or replace Hermes on the primary computer.

## Decision Gate

- **Go to implementation planning** only if S0-S5 pass with real tools and all authority/fault tests pass. S6 must explicitly list any pending surface evidence; pending surfaces block production release, even if core feasibility is established.
- **Revise** if capabilities work but context, compaction, latency/cost, or group coordination require a different composition. Record why Pi core or the coding SDK is preferred using observed evidence.
- **No-go for autonomous rollout** if effects can bypass grants/approvals, group context leaks, stale workers can act, or restarts repeat uncertain external effects. A convincing happy-path demo cannot override these failures.
- Catalogue-wide functionality remains a separate acceptance program using [recipe-coverage.md](recipe-coverage.md). The spike proves representative capability families, not all recipes or Grokbot/Muse parity.

## Deliverables and Explicit Deferrals

Deliver a separate spike PR with test code, pinned dependency manifest, original test recipes, sanitized recordings/traces, acceptance matrix, costs, failures, cleanup record, and a decision report. Update this design and `SDK-VERIFICATION.md` where assumptions are disproved before binding production choices.

Deferred from the bounded spike: full catalogue execution, positive multi-human/cross-owner delegation, large bot teams, production scheduling, demonstration-to-skill learning, telephony, home robotics, paid image/video generation, proprietary native apps, local Mac control, broad channel/voice parity, marketplace publishing, and Hermes migration. These remain product requirements or capability-dependent follow-ups, not implied successes.

After qualification, plan production PRs for runtime/authority, conversational integrations, group participants, computer use, memory/routines, surface parity, and migration. Include a separate `FinnaAI/matrix-os-site` `content/docs/` PR covering verified bot setup, group privacy, integrations, computer takeover, and limitations. Do not publish unverified product capabilities as available.

Remove spike temporary files/processes and revoke test credentials/grants after evidence collection. Retain only sanitized evidence and intentionally saved artifacts. Ask whether to delete any newly provisioned test VPS; preserve it until that decision. Archive a completed worktree only after its PR is merged and unfinished work/process checks pass.
