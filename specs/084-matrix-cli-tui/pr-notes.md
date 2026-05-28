# PR Notes: Matrix CLI TUI

## Stack review note

- This bottom spec/docs PR intentionally leaves `tasks.md` unchecked and `spec.md` ready for implementation; the implementation and final completion markers live in the upper Graphite stack PRs.

## Invariants

### Source of truth

- Existing CLI profile/auth/config files remain the source of truth for local account and gateway resolution.
- Existing gateway workspace/session routes remain the source of truth for shell, coding, project, worktree, review, task, preview, and workspace data.
- TUI preferences are local, owner-readable, non-secret display preferences only.

### Lock/transaction scope

- This stack adds client-side TUI wrappers and does not add server-side persistence, database writes, or transaction scopes.
- Gateway mutations continue to use their existing route/service transaction and validation behavior.

### Acceptable orphan states

- TUI actions do not clear local UI state until the underlying client operation resolves.
- Partial status failures degrade the affected subsystem and show safe recovery-oriented state instead of failing the whole TUI.

### Auth source of truth

- Bearer auth continues to come from the existing profile token store or explicit `--token` path.
- Missing, expired, or rejected auth produces first-run/login recovery views and does not expose token contents.

### Deferred scope

- This stack does not add new gateway APIs or change zellij as the runtime substrate.
- Native terminal attach remains a handoff through existing clients; richer embedded terminal behavior is deferred.
- The feature should ship as the planned Graphite stack layers rather than one oversized PR.
