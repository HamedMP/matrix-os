# Use a selected Herdr terminal from a private Codex Chat

[ENG-495](https://linear.app/matrix-os/issue/ENG-495) · [Herdr sessions](../2701-herdr-self-host/spec.md)

## Entry point

In Electron, open a private Codex Chat on an isolated worktree, choose Full Access, then type `@herdr` or `/herdr-terminal-control` in the composer. Select a live terminal started in this worktree. Send the task with that selection. Each user turn selects its own target. A selection gives that turn permission to read the screen, submit text and interrupt the foreground task as the terminal's owner. Its launch directory identifies the worktree. Programs in the terminal retain their normal OS permissions.

## Execution

The owner-only Herdr listing with `?view=chat-control` returns an opaque revision for each identifiable live process. The user message carries the explicit control action and one versioned terminal reference. The native Codex run receives a separate `matrix-herdr` MCP server. Its four tools are `terminal_list`, `terminal_read`, `terminal_send` and `terminal_interrupt`. Each call acts on the selected process. The tool arguments contain no device, terminal or directory overrides.

The launcher accepts a dedicated run credential. The Gateway grants it access only to `POST /api/chat/herdr-terminal`. The dispatcher checks the Herdr connection, process identity and worktree before sending input. A process waiting for the owner rejects automated text. An interrupted process reports the outcome observed by the terminal verb. The originating Codex run receives the tool response. System and provider credentials belong outside the result.

## Lifetime and deployment

Closing or cancelling the run revokes the grant. A restarted core, replaced process or replaced worktree directory invalidates the selection, including a directory replaced between selection and the first tool call. Automatic retries and internal follow-ups cannot replay a previous terminal grant. Reading a transcript or reopening the Chat does not grant control.

This path reaches the current Gateway owner's Herdr Core on a self-host with Herdr sessions enabled. A separate physical Mac requires a desktop link admitted under the paired device's current revision and native consent. The desktop link is tracked by [ENG-574](https://linear.app/matrix-os/issue/ENG-574). The retired DevStack runtime, publisher and CLI are outside this flow.
