# Recoverable namespaced runtime shutdown

> Execute the focused code task with subagent-driven-development, then retain its exact source and runtime evidence.

**Goal:** Stop new request dispatch when shutdown starts, preserve foreign paths, and allow a failed close to retry after trusted placement is restored.

**Problem:** Namespace ancestry can become unsafe after startup. A refusal currently leaves the supervisor admitting work; the broker and host can latch closed before cleanup and report success on retry while resources remain. This blocks ordinary Gateway integration and merge. The separate intact root-only fake-SDK fixture is narrower evidence.

**References:** DevStack spec #3023, ENG-432, native stack #3178 (parent #3164, child #3177).

## Global constraints

- No Main or installed Dev mutation, deployment, provisioning, paid/provider call, merge or external message. Preserve the live OrbStack worktrees and source projections. No Trellis task.
- Work in the existing manual parent worktree/branch; preserve current namespace, fixed worker isolation, permissions, authentication, limits and legacy happy-path behavior.
- A failed filesystem trust check must never cause foreign socket unlink/removal. Node may unlink its bind pathname on server.close; disposing or quarantining that listener must respect this behavior.
- Keep state and failures bounded and explicit. No new lifecycle framework, storage system, dependency or public endpoint. Extract a focused helper only if needed.
- An intact-placement fake-SDK qualification does not establish this fault-path lifecycle, non-root Gateway integration, paid accounting, CI or full Stage2 readiness.

## Task 1: Quiesce admission and make teardown retryable

**Own files:** `packages/scope-runtime/src/server.ts`, `main.ts`; `packages/gateway/src/collaboration/scope-runtime-broker.ts`, `scope-runtime-host/index.ts`; focused helper and owning server/broker/host lifecycle tests as needed. Do not change the large Gateway composition.

Requirements:

- Mark admission as stopping synchronously before any asynchronous/path check. New connections/frames must not reach controller or backend dispatch after shutdown begins. Already admitted work remains bounded by its existing limits.
- Safely resolve owned in-memory connections and independent client/backend resources. If pathname safety prevents listener cleanup, quarantine it with an explicit rejected/pending teardown; it must not continue serving or be reported closed.
- Keep the source guard and foreign replacement intact. Never call a pathname-unlinking close on an unverified replacement as a shortcut.
- A failed close must not poison the next close. Restoring original trusted ancestry with the original owned socket must let retry complete actual listener, controller/backend and client cleanup. Successful repeated close remains idempotent. Concurrent close calls share only a live attempt, not a permanently rejected promise.
- Main must not permanently retain a rejected shutdown promise. A later valid retry must reach the close operation while admission remains quiesced.

TDD and validation:

- [ ] Reproduce unsafe-ancestry close refusal with actual temporary Unix servers, no service/provider operations.
- [ ] Prove zero new controller/backend dispatch after refusal.
- [ ] Restore ancestry; retry must remove the owned listener and finish backend/client cleanup, then repeat cleanly.
- [ ] Foreign socket replacement must survive; failure/quarantine must be explicit.
- [ ] Keep existing normal/legacy shutdown, namespace startup/ownership and bounded-connection regressions passing.
- [ ] Run focused covering tests, relevant package typechecks and diff checks; report exact RED/GREEN commands/output and commit explicit paths.

## Delivery

Review this task independently before ordinary Gateway integration. Keep parent/child drafts until source blockers and matching acceptance are closed. Use native stack rebase only after the controller's current native candidate has stopped; do not modify a running source projection. Preserve receipts for each source version. Public site documentation remains a separate repository PR.
