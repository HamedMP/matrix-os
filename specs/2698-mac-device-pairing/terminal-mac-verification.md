# Mac Verification from Terminal

Tracking [ENG-495](https://linear.app/matrix-os/issue/ENG-495/cloud-matrix-controls-the-desktop-computer-terminals-and-apps). Keep the Mac Verification workflow in Matrix Chat and Electron Desktop.

## User flow

Run `matrix mac verify --chat <chat-id> --worktree <worktree-id> --recipe files-trash` from the matching Matrix OS checkout in an ordinary or Herdr terminal. The command uses the selected Matrix CLI profile. It binds the latest eligible completed Codex run in the private Chat and queues the exact Git revision and source digest. Coding agent choice in Terminal is independent of the Chat's existing Codex run.

The paired Mac must have the original Chat open and Mac Verification enabled for a trusted matching checkout. Under Supervised, the owner approves the specific recipe on the Mac. With Full Access selected in that Chat and the paired Mac authorized, the same action begins directly. Results return through the existing receipt in the original Chat. The terminal command reports admission only.

## Transport and authorization

| Boundary | Contract |
| --- | --- |
| CLI submission | Reuse owner-scoped `GET /api/chats/:chatId` and `PUT /api/files/blob`. Strictly validate the personal Chat and its current completed worktree run, then write the deterministic typed intent to one bounded name in `temporary/desktop-chat`. Use no-force upload and compare exact bytes on a conflict. Submit no new model turn. |
| Native discovery | Only inspect the intent for the currently eligible visible Chat and latest run. Use the current Matrix credentials and hash the bounded bytes before execution. An uploaded intent requests a recipe and grants no Mac authority. |
| Native execution | Read the exact intent again, check the private canonical Chat and identity, compare registered worktree, Git status, source bytes and base revision, and reuse native pairing and the existing approval/claim flow. Abort a changed intent at revalidation or before receipt. Current requests expire with the existing short run eligibility window. |
| Result | Use the existing verified screenshot and test receipt. Approval is scoped to the active request and the paired Mac can Stop or revoke it with the existing controls. An orphaned request has no executable content, expires and is cleaned by the Chat attachment directory policy. |

## Files verification recipe

The recipe uses a temporary Files home with a disposable target and a second file. In the actual Electron Files window, use the right-click menu to move the target to Trash. Verify the original listing and Trash entry, then use Undo and verify the original bytes were restored and the sibling file remained unchanged.

Electron sends `{ path, withUndo: true }` to `POST /api/files/delete`. A Gateway that supports this action returns an opaque `entryId` with `trashPath`. Undo sends `{ trashPath, entryId }` to `POST /api/files/trash/restore`. The manifest's `entryId` is the authority for that deletion. Compare it under the Trash mutation lock before restoring, and return `409` if the path now names a different entry. On a Gateway that returns only a path, show successful removal and refresh the folder without offering an unbound Undo action. Check both a successful restore and a second same-name deletion before accepting the flow.

The trusted Git base contains the complete implementation. The only source delta carried to the Mac is an optional bounded plain-text menu label change in the exact approved Files component. Verify the digest before and after build. Run the recipe against loopback fixture identity and real Files routes operating on temporary files. Keep the owner's Files data and the cloud checkout outside its write scope. The sign-in recipe remains separately available with its existing source rules.

## Qualification

Run the exact terminal command in an ordinary terminal and a Herdr terminal. Check wrong Chat/worktree, stale run, tampered intent, unauthorized operation, repeated submissions, and refusal of executable source edits. Observe the actual Electron context menu, removal, Trash and restored file. Confirm the screenshot and tests reach the originating Chat through the receipt. Record matching client and original Chat environment with continuous footage of the actual interaction.

Public documentation follows review in the site repository.
