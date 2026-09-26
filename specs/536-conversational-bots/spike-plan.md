# Spike Protocol: Conversational Bots Powered by Pi

**Status**: Planned; not executed.
**Sequence**: Publish and review spec on GitHub -> S0 package probe -> Spike A (one bot) -> Spike B (group) and Spike C (computer use) -> report evidence and decision per milestone -> plan production implementation. Publication alone does not mean the spec is approved or any stage passed.

## Entry Gate

Start only after this spec is published, the owner has accepted the spike scope, and a follow-up execution task is started. Record the spec commit SHA and PR URL in the spike report. No runtime installation, model spend, VPS creation, or implementation is part of the specification PR.

The spike tests uncertain implementation choices after the user-visible contract is written. No undocumented Pi behavior becomes a production assumption before its stage completes. Tests precede implementation; isolated probe code and sanitized evidence ship in a separate PR/worktree.

## Question to Answer

Can a Matrix-owned Pi runtime, running inside the existing scope runtime, support two persistent conversational bots that progressively request integrations, act through a real computer, collaborate in a group, and recover without losing authority or duplicating effects, while preserving existing Matrix Chat and Provider V3 ownership?

## Staged Program

One integrated attempt covering every capability does not fit a short timebox, and a single failure would block unrelated findings. The program runs in stages, each with its own timebox, pass criteria, and report. Stop at a stage's timebox and report partial or blocked findings instead of expanding scope silently.

| Stage | Timebox | Scope | Depends on | Unblocks |
|---|---|---|---|---|
| S0: Package probe | 0.5 engineering day | Pinned Pi package set under the scope-runtime profile; text and image tool calls through a stub broker; denied-call nonexecution; steering; cancellation; compaction; context reconstruction; broker inference compatibility; memory and CPU inside the profile caps | Entry gate | Go or no-go on Pi before integrated work |
| Spike A: One bot | 2 engineering days | Demonstration steps 1-4, 8, and 9: creation, memory, progressive integration, approval, durable wakeup, restart | S0 | M1 and M2 planning |
| Spike B: Group | 1.5 engineering days | Demonstration steps 6-7: two bots, one coordinator, handoff, audience grants, one-run-per-Chat queue, funded-slot queuing | Spike A identity and grant model | M3 planning; M1 data model finalization |
| Spike C: Computer use | 2 engineering days | Demonstration step 5: browser and visual desktop, takeover, fencing, egress, capacity measurement, vision model cost | S0 | M4 planning |

Spike B and Spike C may run in parallel after their dependencies pass. Surface qualification is not part of the program: each stage records the surface it used (Web Desktop by default), and FR-014 parity is qualified during implementation.

## Demonstration

Use Research Rabbit (an original Competitor Watch recipe) and Brief Rabbit (an original weekly-brief recipe). The owner asks for a competitor update and a brief prepared for the next meeting.

1. **[A]** Select each recipe. Create its durable identity, rabbit avatar, and direct chat immediately, with no form or model selection required.
2. **[A]** Research Rabbit asks which competitor/product matters. The owner supplies a synthetic company and corrects a preference; the bot remembers the correction after reopening Chat, and the authority view lists the remembered item with its source.
3. **[A]** The bot discovers an already connected dedicated test Gmail account and asks for a scoped read grant if absent. A seeded email holds a source attachment/reference. No unrelated inbox data is fetched. The authority view shows the grant once approved.
4. **[A]** Calendar is initially disconnected. When meeting timing becomes relevant, request it through an inline Connect action. First cancel and continue the independent research; then connect from the same chat and verify the original task resumes. Use a dedicated test account, actual broker/OAuth completion, and a seeded calendar event. An unavailable real account leaves this acceptance case blocked; a fake OAuth success is not a substitute.
5. **[C]** Visit a controlled external test website with no connector. Exercise browser interaction and persistent login. Download a seeded document using a graphical file dialog or another deterministic visual-desktop task that requires screenshot-based action outside the DOM. Measure one graphical session's resident memory and CPU next to the existing services on the smallest supported plan.
6. **[B]** The owner creates one group and invites both bots. Ask Research Rabbit to pass the sourced findings to Brief Rabbit. Share only the explicit findings artifact; no private email body, account identifiers, or direct-chat history is implicitly forwarded. Run once on a Matrix AI usage-mode route and once on an own-account route.
7. **[B]** Brief Rabbit writes a concise workspace artifact, verifies its existence and readable content, and posts the result with its own rabbit identity. Both bots receive only their scoped tasks and grants.
8. **[A]** Ask to send the brief to a dedicated test recipient. Create the exact reviewable draft and wait for approval. Deny once; approve a second proposal in the controlled test account. Verify the sent record rather than trusting assistant text. No messages go to real customers.
9. **[A]** Explicitly ask for one follow-up in two minutes. Persist that one-shot trigger, restart the gateway before it is due, and verify that the supervised runtime claims it once. If a required gateway tool is unavailable, retain a blocked task and resume after verified reconnection; do not pretend the tool remained available.
10. **[A, B, C]** Inject the interruption, revocation, and duplicate-delivery cases assigned to each stage below. Reopen after each injected failure and inspect truthful state and persisted history.

For Spike B, a brief written by Brief Rabbit alone from a fixture findings artifact substitutes for Spike A's live Gmail research if Spike A's integration gate is blocked; record the substitution.

## Work Packages and Evidence

| Step | Stage | Hypothesis | Required evidence | Failure decision |
|---|---|---|---|---|
| S0: dependency probe | S0 | A pinned compatible Pi package set runs inside the scope-runtime profile and supports text/image tools, blocking tool policy, steering, cancellation, compaction, and context reconstruction through broker inference | Version/lock manifest, exported-type checks, real-model text and image tool calls through the broker, denied-call nonexecution, reconstructed tool/result pairs and compacted context, measured worker memory and CPU, bounded cleanup trace | Stop and report incompatibility; evaluate the SDK alternative or another runtime without widening the product scope |
| S1: bot creation/setup | A | Canonical Chat can persist bot identity, conversational preferences, memory, and pending interactions without a form | Failing-then-passing contract tests, lost-response creation retry, reopen recording, authority view matching server state | Fix identity/state model before adding integrations |
| S2: broker connection | A | Existing broker can correlate a connection/grant to the correct pending bot task | Actual test-account OAuth and selected-account read, cancelled/duplicate/forged completion tests | Mark integration gate blocked; fixtures do not prove live behavior |
| S3: computer use | C | Pi can observe images and reliably operate the isolated Linux computer through the computer service | Real model screenshot->action->screenshot trace, saved artifact, takeover/fencing and egress tests, capacity measurement, per-step cost | Browser-only success does not pass desktop gate; missing capacity blocks M4 on that plan |
| S4: group collaboration | B | Two named bots can complete bounded assignments through canonical shared state and the same admission path production uses | One parent task, attributed messages, one handoff/result chain, shared artifact, no private-context leak, one bot run posting into the group at a time, task-scoped child run, queued turns on the funded route | Redesign participant/context authority before expanding bot count |
| S5: durability/approval | A | Worker and gateway restarts preserve waits, claim one durable wakeup, and avoid duplicate effects | Fault-injection traces and exact external-effect reconciliation | No autonomous rollout if uncertainty produces blind replay |

Implementation ownership when the program is later assigned: contracts/state, worker/broker adapter, computer service, and shared presentation should have clear module boundaries. This plan does not start parallel agents or assign workers now.

## Failure-Injection Matrix

1. **[A]** Retry recipe creation after losing the response: one bot/direct-chat pair; conflicting request payload rejected.
2. **[A]** Kill the gateway during an active tool call: reattach an exact live worker or recover a checkpoint; no second dispatch of an uncertain action.
3. **[A]** Kill the worker after an external send but before completion persistence: inspect the test service's sent record or surface effect-unknown; never resend automatically.
4. **[A]** Restart while waiting for account choice or approval: preserve the original interaction identity and designated responder; stale answers reject.
5. **[A]** Duplicate the verified OAuth completion and forge an unrelated owner's completion: one continuation for the former, no account attachment for the latter.
6. **[A, B]** Revoke the bot grant or remove it from the group while work is queued/running: recheck before the next effect and publication; private data cannot enter group context; the authority view reflects the revocation immediately.
7. **[A, C]** Put malicious instructions in the source email/page: they cannot create grants, write standing memory, read control credentials, or trigger a new external recipient.
8. **[C]** Have two bots request the same desktop/profile: only the lease holder mutates it; stale fenced actions reject after user takeover.
9. **[B]** Cancel the parent task: stop descendants and queued actions; report uncertain termination without releasing in-use resources.
10. **[B]** Exceed task/handoff/action/budget limits; simulate slow subscriber/model timeout: bounded termination and recoverable canonical state.
11. **[A]** Block required service/model, exhaust funds, fail artifact writes, and return an empty successful query: distinguish each from successful completion.
12. **[A]** Deliver the same one-shot trigger twice across gateway restart: one task claim; missed-deadline behavior and unavailable-tool recovery remain explicit.
13. **[B]** Attempt a cross-owner group read with no grant and a revoked-viewer control action: reject both without revealing private metadata.
14. **[B]** On a Matrix AI usage-mode route, have both bots request model turns while the owner sends an interactive Chat turn: the owner's turn is served first, bot turns queue, and no policy rejection surfaces as task failure.
15. **[B]** A collaborator without AI permission mentions a bot, then a collaborator with AI permission asks it for data behind the owner's grant: the first does not run; the second is limited to the collaborator's resource permission and the grant is not exposed.
16. **[C]** Point the browser at a private address, a metadata address, and a redirect to a private address: all are blocked at the computer service's egress point, and the worker has no direct network path.

## Testing, Measurement, and Pass Criteria

- Write deterministic Vitest contract/security/fault tests first. Use Postgres/Kysely for durable-state and concurrent-claim tests, plus the actual broker and worker boundaries for end-to-end wiring tests.
- Each stage runs its path end to end through the scope-runtime broker: Spike A from recipe selection -> persisted bot -> conversational question -> integration resolution -> canonical run -> Pi tool call -> approval -> restart; Spike B through group handoff -> artifact; Spike C through screenshot -> action -> observed artifact. Mocks may test failures; they do not qualify the live path.
- Run each stage's scenario three times after fixes. Require 3/3 successful final repetitions of that stage's criteria plus all of its safety/fault cases. Keep earlier failures in the report.
- Record per-run model/access source, active versus human-wait and queue-wait duration, tool count, retries, tokens/currency, interventions, observed effects, and artifacts. Do not claim lower cost or higher performance from package choice alone.
- Budget: six engineering days in total across the stage timeboxes above. Before live calls, record a model spend cap and VPS lifetime/cost cap approved for the execution task. Fixtures incur no model-spend assumptions.
- Compare one representative research task with Hermes using the same model where both support it, equivalent inputs/tools, and identical completion criteria. If that comparison cannot be controlled, label it incomparable; three runs are a feasibility signal, not a benchmark. Record the result in the runtime decision record.
- Run applicable typechecks, pattern checks, focused/unit suites, production builds for touched surfaces, and React audit for changed React files. Target 99-100% coverage for introduced kernel/gateway logic; report actual coverage and exclusions.
- Execute on a disposable VPS through the normal host-bundle path for integrated stages; local fixtures and isolated package probes are additional evidence. Do not install into or replace Hermes on the primary computer.

## Decision Gate

- **Go per milestone**: M1 and M2 planning require S0 and Spike A to pass with real tools and all of their authority/fault tests; the M1 data model is not finalized until Spike B's participant and grant findings are recorded. M3 requires Spike B. M4 requires Spike C, including a capacity result for the target plan.
- **Revise** if capabilities work but context, compaction, latency/cost, funded-slot queuing, or group coordination require a different composition. Record why Pi core, the coding SDK, or another runtime is preferred using observed evidence, and complete the runtime decision record.
- **No-go for autonomous rollout** if effects can bypass grants/approvals, group context leaks, stale workers can act, workers reach the network outside the broker, or restarts repeat uncertain external effects. A convincing happy-path demo cannot override these failures.
- Surface parity is not a feasibility gate. It is qualified during implementation in the order Web Canvas, Web Desktop, Electron Desktop, Web Mobile, Native Mobile, with exact surface names; pending surfaces block production release of the milestone.
- Catalogue-wide functionality remains a separate acceptance program using [recipe-coverage.md](recipe-coverage.md). The program proves representative capability families, not all recipes or Grokbot/Muse parity.

## Deliverables and Explicit Deferrals

Deliver a spike PR per stage, or one PR with a section per stage, with test code, pinned dependency manifest, original test recipes, sanitized recordings/traces, acceptance matrix, costs, capacity measurements, failures, cleanup record, and a decision report. Update this design and `SDK-VERIFICATION.md` where assumptions are disproved before binding production choices.

Deferred from the spike program: full catalogue execution, positive multi-human/cross-owner delegation, large bot teams, production scheduling breadth, demonstration-to-skill learning, telephony, home robotics, paid image/video generation, proprietary native apps, local Mac control, voice, hosting bot conversations in messaging channels (M5; the data model stays channel-independent), marketplace publishing, surface parity, and Hermes migration. These remain product requirements or capability-dependent follow-ups, not implied successes.

After qualification, plan production PRs per milestone for runtime/authority, conversational integrations, memory and the authority view, routines, group participants, computer use, surface parity, channels, and migration. Include a separate `FinnaAI/matrix-os-site` `content/docs/` PR per milestone covering verified bot setup, group privacy, integrations, computer takeover, and limitations. Do not publish unverified product capabilities as available.

Remove spike temporary files/processes and revoke test credentials/grants after evidence collection. Retain only sanitized evidence and intentionally saved artifacts. Ask whether to delete any newly provisioned test VPS; preserve it until that decision. Archive a completed worktree only after its PR is merged and unfinished work/process checks pass.
