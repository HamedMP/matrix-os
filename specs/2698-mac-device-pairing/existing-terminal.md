# Read an existing Mac Terminal from Chat

> **Superseded (2026-11-25).** [2716](../2716-desktop-link/spec.md) reaches every desktop terminal over the desktop link, with this file's consent rule. A follow-up stack retires this read path; it keeps working until then.

Tracking ENG-495. In an eligible worktree Chat, open `@ → Read an existing Mac terminal`. Matrix Electron opens a local picker listing live terminals from **This Computer**. Select a terminal and review a bounded snapshot in a native dialog. Choose **Use in Chat** to place that snapshot in the original Chat composer. The user can inspect, edit, or send the draft. The read runs once and has no background grant.

## Trust boundaries

| Operation | Authority |
| --- | --- |
| `chat:mac-terminal-read-existing` IPC | Trusted main renderer frame of a signed-in macOS development client with the current owner, primary Computer, personal Chat and registered worktree. Request contains the Chat and worktree IDs and a fresh request UUID. |
| `chat:mac-terminal-read-existing-cancel` IPC | Only the originating trusted renderer frame with the same Chat, worktree, and request UUID. Cancels that in-flight snapshot without reaching the Gateway. |
| Terminal selection | Native picker operated by the local owner. List contains local terminal IDs and safe titles. The renderer and agent never select the live target. |
| Read | Existing paired-device key proof, checked at use. Bind the selected terminal to the live core connection and terminal incarnation. Revalidate before reading and before result handoff. |
| Draft | Same Chat, composer revision, worktree and account. The native sheet previews the exact returned bytes. The Chat stages them as quoted output. The user chooses whether to send. |

Read the current screen using the pinned Herdr Core `terminal.read` with `lines: 0`. Herdr Core v0.1.19 scrolls a full-screen app only for positive history lines. This flow sends no keys, does not resize or end the target, and never starts a fresh terminal for the read. Reject a vanished or replaced target, changed core connection, account or Computer, stop, revoke, timeout, or changed Chat placement. Changing or leaving the originating Chat or worktree aborts the pending native picker or approval and drops any late reply. The pending native operation is bounded and drains on cancel. A connection failure ends the request. The owner can explicitly start a fresh snapshot after reconnect.

Cap the picker at 20 live local terminals and snapshot at 2,000 Unicode code points, after stripping ANSI sequences and unsafe controls. The same formatted snapshot appears in the native preview and can enter the draft. No terminal text is sent to the Gateway until the owner sends the draft through the normal Chat composer. Treat terminal text as untrusted reference data. Persist only the operation outcome in Mac Activity, with no terminal title or contents.

## Validation

- Use the real native Terminal window and two live Mac PTYs in an isolated build. Put distinct output in each. Select the intended terminal via the native picker, approve the matching preview, then confirm only that terminal's output appears in the original Chat draft. Send using an isolated fixture to prove there is no delivery before the owner's action.
- Tests cover closed/replaced terminals, mismatched scope, invalid native picker response, account change, pairing revoke and Stop, and verify the read path uses zero history and never sends input. Continuous local observation has a [separate watch flow](./live-terminal.md). Interactive takeover remains open. Publish public docs via a reviewed documentation PR once signed-build qualification passes.

## Isolated Mac acceptance

The built macOS Electron client used an isolated profile, the pinned Herdr Core 0.1.19, and the authenticated pairing routes over loopback TLS. The picker listed two real PTYs with distinct fixture content. The selected Terminal remained live, its native preview matched the original Chat draft, and the other Terminal's line was absent. The fixture observed zero submissions before **Send** and one afterward. The submitted output was visible after reopening the original Chat. Pairing and native dialog decisions used test credentials and fixture replies. Real account and signed-client verification stay open.
