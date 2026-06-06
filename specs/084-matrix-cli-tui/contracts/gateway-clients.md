# Contract: Gateway And Daemon Clients

## Common Rules

- Resolve profile and auth through existing CLI profile/auth logic.
- Include bearer auth for gateway requests when available.
- Every network request has a timeout.
- Every daemon IPC request has a timeout and response size cap.
- Client-visible errors use safe codes/messages and do not expose raw internals.

## Main Kernel Stream

The home prompt uses the existing main WebSocket message protocol:

```json
{ "type": "message", "text": "user text", "sessionId": "optional", "requestId": "optional" }
```

Supported client-side control messages include:

```json
{ "type": "switch_session", "sessionId": "session id" }
{ "type": "approval_response", "id": "approval id", "approved": true }
{ "type": "abort", "requestId": "request id" }
{ "type": "ping" }
```

The TUI consumes server messages as streaming assistant output, tool/activity state, session switch/init state, errors, and abort/completion state.

## Shell And Coding Sessions

- Shell sessions use existing shell/session list/create/attach/remove/tab/pane/layout clients.
- Coding sessions use workspace session routes for start/list/get/send/observe/takeover/kill.
- Native zellij attach details are displayed as details/copy affordances, not the primary product language.

## Workspace Families

TUI clients cover projects, worktrees, agents, reviews, tasks, previews, workspace events, export, and delete using existing gateway surfaces before adding new endpoints.

## Safety Requirements

- Preview URLs are validated before submission.
- Paths and cwd values are validated before submission.
- Session/project/task/review/preview identifiers are encoded and bounded.
- Mutating flows only clear local UI state after server confirmation.
