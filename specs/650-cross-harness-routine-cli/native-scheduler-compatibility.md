# Native Claude Cron and routine CLI compatibility

Status: compatibility repair within the existing approved 30-minute owner-wait
and native-Cron behavior. No new source authority or scheduler semantics.

## Exact composition

- Routine CLI / Full Access: #3138 at
  `ee08d7fc5ee39b53fed6cedb630f8d4d7a773029`.
- Native Claude Cron: #3108 at
  `2387948dc0cff71fc139c9fbd281923d58d81fca` (parent #3116
  `60083e4fdd5a12a458d19152937d3467040ebb5c`).
- These are composed only in the independent
  `codex/routine-source-chat-20261106` worktree. Neither PR is merged on GitHub;
  existing source worktrees and installed Dev bytes remain unchanged.

## Failure and correction

The routine hook registers a Bash callback with the shared
`ROUTINE_CLI_NATIVE_TIMEOUT_MS` budget (currently 1,830 seconds). The retained
native-session registrar currently rejects values above 120 seconds and installs
a separate 120-second native Bash callback. Both layers must agree with the
existing shared contract, otherwise the combined sources reject a normal Chat
before input or cancel a legitimate owner decision early.

Accept only a finite integer timeout within the shared host-owned upper bound.
The single physical native initialize must install the shared Bash upper bound,
including when initialization occurs before the first routine phase. Later
phases remap only the registered opaque callback; they must never initialize a
second time or replay an already held prompt. Keep UserPromptSubmit at 120
seconds, the general native tool guard at 10 seconds, control ACK waits bounded,
and all existing source lifetime, cancellation, cleanup and permission checks.
This transport budget never extends a source lease or approval deadline.

## Failure-first verification

1. Connect the actual routine hook to the actual retained-session control.
   Reproduce rejection of its current 1,830-second registration before changing
   production code. Assert the original input is released exactly once only
   after successful hook/MCP ACKs.
2. Inspect actual emitted native initialize: Bash receives the shared bounded
   budget; unrelated prompt/guard timeouts remain short. Cover a session
   initialized before the routine phase and a subsequent phase without another
   initialize or stale callback reuse.
3. With fake time, hold a real correlated routine callback past 120 seconds;
   cancellation/source shutdown must still settle it and prevent late success.
   No real model, account, schedule, browser or elapsed 30-minute claim.
4. Reject malformed, fractional, zero and over-budget registrations. Run native
   session, routine-hook, provider wiring, lifetime and shutdown regressions,
   affected type checks and pattern checks on the combined source.

## Separate product follow-up

Choosing native Cron versus durable Matrix routines, projecting canonical
approval into the source Chat and returning canonical results there are separate
design changes. This compatibility repair neither chooses a scheduler for a
user request nor grants a new source-to-Bot binding. Existing native jobs and
routine records must not be migrated, replayed or duplicated.
