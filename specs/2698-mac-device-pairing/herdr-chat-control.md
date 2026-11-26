# Use a selected Herdr terminal from a private Codex Chat

[ENG-495](https://linear.app/matrix-os/issue/ENG-495) · [Herdr sessions](../2701-herdr-self-host/spec.md)

## Conversation goal

A user can ask a private Chat “Which computers are online?”, “Which terminals are open on my Mac?” or “List all my connected terminals.” Chat answers in the conversation. The last question groups terminals by computer. Each answer names the computer from the user's perspective (for example, the paired Mac or the Preview VPS), the terminal name and ID, and the worktree when known. The user can follow up with “Use the build terminal on my Mac and run the tests.” A slash command or composer picker can remain a shortcut.

Discovery is read-only. Show terminals from the current Matrix computer, the paired desktop and authorized reachable Herdr remotes using their actual connection state. A failed inventory is reported for that computer alongside successful inventories. An online computer with no open terminals is a distinct result. The same numeric terminal ID can exist on several computers. When “use t1” matches multiple computers, ask which one before sending input. Recheck the selected device, session revision, worktree and permissions at execution time. If the target disconnected, report that in Chat. Never silently switch computers. A follow-up may remember the user's selection for reference, subject to the existing per-run authorization.

Acceptance requires an ordinary question in the originating Chat with no prior picker selection. List the Preview and paired Mac, list each one's terminals, then select the Mac terminal by name and run a focused test in the requested checkout. Confirm the output on the physical Mac PTY and the matching exit status and result in the original Chat. Include the ambiguous-ID and disconnected-target cases.

The current candidate exposes a read-only catalog to a directly submitted private Codex worktree turn. Ask an ordinary question to discover the current Matrix computer and the remotes its Herdr Core actually reports. The first page includes at most five computers. A computer with up to three live terminals can include their names immediately; a busier computer returns a count. Subsequent questions can filter or page through five terminal names at a time. An offline remote has an unknown count. A missing desktop link cannot establish whether the physical Mac itself is online.

For example, ask “Which computers are online?”, then “Show me the build terminals on this Preview.” The discovery tool returns qualified addresses such as `gateway/t1`. In Electron, “Use gateway/t1 to run the tests” resolves a current terminal in the composer for explicit selection. Only a selected and admitted turn can operate it. Remote inventory by itself does not provide remote control. A paired Mac independent of the current core still depends on an admitted desktop link.

## Control shortcuts

In Electron, open a private Codex Chat on an isolated worktree, choose Full Access, then type `@herdr` or `/herdr-terminal-control` in the composer. Select a live terminal started in this worktree. Send the task with that selection. Each user turn selects its own target. A selection gives that turn permission to read the screen, submit text and interrupt the foreground task as the terminal's owner. Its launch directory identifies the worktree. Programs in the terminal retain their normal OS permissions.

## Execution

The owner-only Herdr listing with `?view=chat-control` returns an opaque revision for each identifiable live process. The user message carries the explicit control action and one versioned terminal reference. The native Codex run receives a separate `matrix-herdr` MCP server. Its four tools are `terminal_list`, `terminal_read`, `terminal_send` and `terminal_interrupt`. Each call acts on the selected process. The tool arguments contain no device, terminal or directory overrides.

The launcher accepts a dedicated run credential. The Gateway grants it access only to `POST /api/chat/herdr-terminal`. The dispatcher checks the Herdr connection, process identity and worktree before sending input. A process waiting for the owner rejects automated text. An interrupted process reports the outcome observed by the terminal verb. The originating Codex run receives the tool response. System and provider credentials belong outside the result.

## Lifetime and deployment

Closing or cancelling the run revokes the grant. A restarted core, replaced process or replaced worktree directory invalidates the selection, including a directory replaced between selection and the first tool call. Automatic retries and internal follow-ups cannot replay a previous terminal grant. Reading a transcript or reopening the Chat does not grant control.

The target terminal belongs to the same computer as the Gateway. A self-host uses the owner's existing Herdr Core. On an owner-only Private Preview the target is a terminal on that Preview VPS, selected by its authenticated owner for a private Codex worktree turn. Shared Previews, collaborators and other machines cannot receive this grant. The Preview expires on its ordinary lifecycle. A separate physical Mac requires a desktop link admitted under the paired device's current revision and native consent. The desktop link is tracked by [ENG-574](https://linear.app/matrix-os/issue/ENG-574). The retired DevStack runtime, publisher and CLI are outside this flow.


## Private Preview acceptance

1. Start a Private Preview for the candidate PR. Compare its installed revision with the selected bundle and open it from a matching Electron build.
2. Log in as the Preview owner. Open an isolated project worktree and start a Herdr terminal in that checkout as the runtime user. Record the visible terminal ID.
3. In a private Codex Chat on the same worktree, select Full Access and use the composer action to choose that terminal. Ask it to run a focused project check and report the result in this Chat.
4. Match the revision, terminal ID, actual PTY output and Chat response. Confirm a subsequent turn cannot reuse the grant and that shared Preview or foreign owners cannot acquire it. Record any steps tested through fixtures separately from the live account run.
