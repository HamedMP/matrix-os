# Mac Verification from Terminal

Tracking [ENG-495](https://linear.app/matrix-os/issue/ENG-495/cloud-matrix-controls-the-desktop-computer-terminals-and-apps). Keep the Mac Verification workflow in Matrix Chat and Electron Desktop.

## User flow

Run `matrix mac verify --chat <chat-id> --worktree <worktree-id> --recipe files-trash` from the matching Matrix OS checkout in an ordinary or Herdr terminal. The selected CLI profile binds the latest eligible completed Codex run independently of the Terminal’s agent. A same-Computer agent can instead queue `matrix mac verify --current --recipe <supported-recipe>` for its uniquely bound active owner Chat. The CLI uses the real Git root and authenticated inventories, rechecks admission before writing, and rejects ambiguous or stale contexts. Both commands report queue admission. Verification runs when the exact run finishes and the paired Mac has the original Chat open with a matching signed kit under the [native consent and result contract](./agent-mac-verification.md).

## Continuing a worktree Chat

Before hashing ordinary Send/Queue admission, read the current canonical Chat and bind its active run, or latest run when idle, for the matching project and worktree. Preserve explicit project/skill roots, current project-root context, new Chat defaults, Shared/Bot rules and the owner’s selected permission mode. Reject inconsistent active run, changed Chat or stale project with draft retained. The Gateway validates owner, registration and availability, including deleted or unauthorized worktrees. A subsequent native receipt and supervised acknowledgement preserve the live mode selection.

## Transport and authorization

| Boundary | Contract |
| --- | --- |
| CLI submission | Reuse owner-scoped `GET /api/chats/:chatId` and `PUT /api/files/blob`. Strictly validate the personal Chat and its current completed worktree run, then write the deterministic typed intent to one bounded name in `temporary/desktop-chat`. Use no-force upload and compare exact bytes on a conflict. Submit no new model turn. |
| Native discovery | Only inspect the intent for the currently eligible visible Chat and latest run. Use the current Matrix credentials and hash the bounded bytes before execution. An uploaded intent requests a recipe and grants no Mac authority. |
| Native execution | Recheck private Chat, registered worktree, Git status, exact revision and intent bytes. Show incompatible signed support before approval/claim. Eligibility expires with the completed run. An explicit Retry can follow recovered availability and retains permission generation, run, digest and claim boundaries. Changed intent, Stop and already-claimed work cannot replay. |
| Result | Use the existing verified screenshot and test receipt. Approval is scoped to the active request and the paired Mac can Stop or revoke it with the existing controls. An orphaned request has no executable content, expires and is cleaned by the Chat attachment directory policy. |

## Files verification recipe

The recipe uses a temporary Files home with a disposable target and a second file. In the actual Electron Files window, use the right-click menu to move the target to Trash. Verify the original listing and Trash entry, then use Undo and verify the original bytes were restored and the sibling file remained unchanged.

Electron sends `{ path, withUndo: true }` to `POST /api/files/delete`. A Gateway that supports this action returns an opaque `entryId` with `trashPath`. Undo sends `{ trashPath, entryId }` to `POST /api/files/trash/restore`. The manifest's `entryId` is the authority for that deletion. Compare it under the Trash mutation lock before restoring, and return `409` if the path now names a different entry. On a Gateway that returns only a path, show successful removal and refresh the folder without offering an unbound Undo action. Check both a successful restore and a second same-name deletion before accepting the flow.

The trusted Git base contains the complete implementation. The only source delta carried to the Mac is an optional bounded plain-text menu label change in the exact approved Files component. Verify the digest before and after build. Run the recipe against loopback fixture identity and real Files routes operating on temporary files. Keep the owner's Files data and the cloud checkout outside its write scope. The sign-in recipe remains separately available with its existing source rules.

## Qualification

Qualify ordinary and Herdr Terminal separately from the native Skill. Check wrong Chat/worktree, stale run, tampered intent, unauthorized operation, repeats and refusal of executable edits. Use the [live Files acceptance](./agent-mac-verification.md#5-required-verification), opting into Full Access in the reopened Chat. Send a reversible label change through the normal composer, confirm admitted worktree and `full_access`, and use the CLI for that run. Observe the actual Trash menu, removal, Trash, restoration and native receipt. Restore the trial edit and compare Main service process identities with baseline.

Regression-test real native admission after reopening, including Send in Full Access, Queue, a newer explicit project root, changed project/Chat, new Chat reset, and a deleted worktree. Assert actual admitted and queued payloads and preserve the failed draft. Public documentation follows review in the site repository.
