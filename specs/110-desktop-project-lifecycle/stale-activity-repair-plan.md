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
  name and the existing force-delete adapter. Missing sessions are confirmed by
  inventory; failed inventory or a surviving runtime keeps deletion pending.
- Stop child workspace sessions, remove project terminal workspaces and associated
  child tabs in Main, and remove session records and managed transcript artifacts.
  Preserve unrelated tabs, other owners' state, and external source folders.
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
No live customer project is deleted during validation. General stale-status
reconciliation and new blocker-management UI are outside this fix.
