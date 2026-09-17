# Cascade project deletion

Confirmed project deletion stops child work and removes its sessions, following
T3's project-to-thread deletion model. Persisted running labels no longer prevent
explicit deletion. Archive retains its existing active-work guard.

## Implementation

- Preserve owner authorization and exact project-name confirmation. The dialog
  explains that deleting stops project tasks and terminal sessions.
- Write the existing durable deleting marker under the project admission lock.
  Serialize lifecycle requests with a separate lifecycle lock; release admission
  before cleanup so worktree lease release can acquire its normal project lock.
- Cancel and hard-delete active and archived canonical chats through the existing
  transactional repository, including their message/run descendants.
- Stop coding-agent provider sessions and local execution, then remove owned
  thread/event/turn records. Missing runtime sessions are an idempotent success;
  unavailable runtimes preserve state for retry.
- Legacy Zellij sessions without a terminalRef use their validated persisted runtime
  name (`matrix-rt_*`, `matrix-sess_*`, or `sess_<UUID>`) and the existing force-delete adapter. Missing sessions are confirmed by
  inventory; failed inventory or a surviving runtime keeps deletion pending.
- Stop child workspace sessions, remove project terminal workspaces and associated
  child tabs in Main, and remove session records and managed transcript artifacts.
  Preserve unrelated tabs, other owners' state, and external source folders.
- Already exited sessions skip runtime termination but still release leases. Terminal
  resources removed between inventory and cleanup are idempotent success.
- After child sessions release their leases, remove registered managed worktrees
  through the worktree manager before deleting project registry metadata.
- Share cleanup between requests and startup recovery. Failed cleanup leaves the
  existing hidden tombstone; retry resumes without reporting a false success.

## Validation and delivery

Focused tests cover legacy running records through the real HTTP deletion route,
active and missing sessions, runtime failures, terminal cleanup retries, archived
chats and transactional descendants, owner isolation, external file preservation,
and cleanup acquiring the project lock. Run gateway and Electron Desktop type
checks and the dialog/store tests. Prepare an exact-head Electron Human Review.

Ship through a Conventional Commit PR with invariants. Public project-deletion
copy is a separate documentation PR in FinnaAI/matrix-os-site/content/docs.
Other live projects are inspected read-only. Recovery may finish only a project
whose owner has already confirmed deletion; synthetic fixtures cover other cases. General stale-status
reconciliation and new blocker-management UI are outside this fix.


## Cross-resource regression matrix

| Resource | Required cases | Coverage |
| --- | --- | --- |
| Legacy provider sessions | Three historical name formats; running/completed threads; already exited records | `project-legacy-session-deletion.test.ts`, `legacy-session-stop.test.ts` |
| Terminal | Running, missing, unavailable; removal after inventory; unrelated tabs survive | `project-session-deletion.test.ts`, `project-deletion-cleanup.test.ts` |
| Background execution | Running and unavailable; failure retains records; retry completes | `project-cascade-mixed-resources.test.ts`, `background-agent-runtime.test.ts` |
| Worktrees/reviews | Release session lease before checkout deletion; retry on failure; remove review records | `project-cascade-mixed-resources.test.ts`, `worktree-manager.test.ts`, `review-store.test.ts` |
| Tasks/previews | Remove validated legacy records with the project | `project-cascade-mixed-resources.test.ts` |
| Canonical Chat | Active/archived descendants; cancel failure; other owners/projects survive | `project-chat-deletion.test.ts`, `project-deletion-cleanup.test.ts` |
| Project lifecycle | Admission lock, external source preservation, partial failure and restart recovery | `project-lifecycle.test.ts`, `project-cascade-mixed-resources.test.ts` |
