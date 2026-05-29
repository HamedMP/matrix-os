# Contract: Session Operations

## Purpose

Preserve the parent Matrix session cockpit while adding zellij-style operations.

## Required Operations

- Create shell session
- List shell and coding sessions
- Attach to session
- Observe session
- Take over session
- Detach without killing session
- Stop session with confirmation
- Inspect native attach details, tabs, panes, and layout when available

## Failure Behavior

- Missing zellij/session runtime: show unavailable state with setup next step
- Stale session: show recoverable stale state and refresh list
- Backend timeout: show safe failure and keep current view
- Stop/remove failure: keep session visible until backend confirms success
