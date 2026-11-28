# Background Mac terminal checks from Matrix Chat

Tracking [ENG-495](https://linear.app/matrix-os/issue/ENG-495/cloud-matrix-controls-the-desktop-computer-terminals-and-apps). Builds on [#3457](https://github.com/HamedMP/matrix-os/pull/3457).

## Single-command baseline (#3460)

### User flow

In a personal Main worktree Chat on an opt-in macOS Electron development build, the owner selects **Allow background Mac checks**. The native sheet says which Chat and worktree can request `/usr/bin/uname -s` on this Mac and provides Cancel and Approve. One approval permits up to three checks over 15 minutes. The owner can send the staged request, navigate away, and receive the output in the original Chat while Electron stays running. Reopening the Chat during approval shows the active grant and allows the owner to stage another check. The Matrix application menu shows the active permission and allows the owner to stop it while the Chat is closed.

### Trust and recovery

| Operation | Authority and limits |
| --- | --- |
| Approve | Existing Matrix primary-Computer session, trusted Electron main renderer, personal owner Chat and registered Codex worktree, and local native consent. One in-memory grant per Electron profile. The grant is tied to the approving Mac process, the actual owner, the active Computer, one Chat and worktree, and an unguessable request target. |
| Discover | Electron main polls only the approved Chat via the existing authenticated detail endpoint. One poll at a time, with the existing response size and transport time limits. Only a recent completed owner-worktree Codex run and its committed canonical marker with this target can be admitted. |
| Run | Consume the run before executing the fixed action in a newly prepared dedicated local PTY. One operation at a time. The Mac only runs the existing fixed binary and returns bounded `Darwin` output. |
| Return | Use the existing canonical Chat turn request and idempotency key. On a transient error, keep one pending output under the same grant and retry delivery until its deadline. Execution stays single-use. Record approved, dispatched, returned, failed and revoked transitions in the existing Electron diagnostic logger with event names and whitelisted fields. |
| Revoke | Local stop, expiry, sign-out, changed authority/Computer, or Electron quit clears the permission, cancels pending work and disposes its PTY. A transient connection loss can recover during a live grant. A client restart clears the grant. |

The original controls belong to the single-command baseline. The following milestone uses the composer menu for the one-time and background paths. Packaged enrollment, background device discovery, general cross-machine shell verbs, bounded application input, takeover and product audit history are subsequent ENG-495 milestones. Public docs ship when reviewers approve a supported enrollment workflow.

### IPC and failure behavior

- `chat:mac-terminal-background-start` and `chat:mac-terminal-background-status` both take the exact `{chatId, worktreeId}` binding. Start returns `{status: "ready", targetId, expiresAt, remaining}` on consent. Unavailable authority, conflicting work, decline and failure have bounded status responses.
- Status returns `{active: false}` for all unmatched grants. An active reply contains the target, expiry, remaining count (0–3), and phase (`waiting`, `running`, or `returning`). The compositor validates that exact grant before sending a generated draft. Stop uses the existing Chat cancel IPC or the local Matrix application menu.
- Polls serialize at a three-second cadence with a five-second retry after transport errors. Discovery and writes honor cancellation. An in-flight canonical POST may already have been accepted by Gateway when Stop is used. Its existing receipt remains in the original Chat.
- Reconnection can retry a pending result while the request and authority remain valid. A later completed run or changed canonical binding discards that result and keeps its request consumed. An active-only run can settle before a retry. A consumed request always keeps the same canonical idempotency key. Its terminal is disposed when the inspection window ends or authority is lost.

### Acceptance

- Use the same existing Main and Mac identity. Approve once, send one Main Chat request, leave that Chat before it completes, and observe the Mac result in the original Chat from a separate view or a canonical receipt.
- Verify a second fresh run reuses the approved grant. Verify the app can stop it while the original Chat is closed.
- Tests verify owner/target/worktree checks, expiry, stop, auth change, reconnect while waiting, retry after execution without duplicate PTY input, and existing one-time behavior. Record actual Mac and Main evidence separately from simulated transport loss.

## Background system checks and Electron preview verification

This ENG-495 follow-up uses the same Matrix session and the same Chat/worktree
grant. On the opt-in macOS Electron development build, type `@` in the empty
composer and select **Allow background Mac checks**. Native approval stages a
draft for system checks. The owner sends it and can close the Chat window.
The `@` menu's **Draft another Mac check** reuses the live grant. The Mac prepares
a private PTY and runs these fixed commands for each system check. A successful
receipt contains each value and exit status in the originating Chat.

- `/usr/bin/uname -s` reports the kernel.
- `/usr/bin/uname -m` reports the architecture.
- `/usr/bin/sw_vers -productVersion` reports the macOS version.

When a trusted local preview checkout is configured, the `@` menu's **Draft
background Electron preview** stages the existing sign-in label change from
[the single-run preview](../2694-chat-electron-preview/spec.md). The completed
assistant turn identifies the active grant, source SHA-256, commit and
`verify-sign-in-recovery` operation. Electron main can discover this request
with the Chat window closed. A separate native **Approve Once** dialog names
the Chat, worktree, source and operation. The Mac builds and tests the bound
source in a disposable checkout, opens Electron Desktop with an isolated
profile, clicks **Sign in**, and checks the connection error and enabled retry
control. It sends the resulting PNG and focused test count to the same Chat.

| Operation | Authority and limits |
| --- | --- |
| System checks | The existing native grant allows at most three batches. Executables and arguments come from a closed local list. The PTY has a bounded output parser and deadline. An unsupported value, missing output, or failed command fails the batch. Legacy one-time `uname -s` retains its existing approval and result. |
| Preview discovery | Only the latest completed Codex run in the approved owner Chat and worktree can request a preview using the current target. A renderer cannot admit a background request. The grant allows discovery and a native consent prompt. |
| Preview execution | A one-time on-device approval binds the exact operation and source. The single-run preview claim prevents a second build for the same Chat run. The candidate has a disposable profile and an offline sign-in endpoint. The only application action in this slice is the fixed sign-in recovery check. |
| Delivery and stop | System check receipts keep the existing idempotent delivery. Preview uploads and canonical receipt writes honor the live grant signal. Stop, expiry, sign-out or Computer change cancels the prompt or work. A write already admitted by Gateway remains in the original Chat. |

The existing IPC payloads are unchanged. The request marker
`MATRIX_MAC_TERMINAL_V1 {"targetId":"<uuid>","action":"system-checks"}` is
accepted only on the background dispatch path. Successful output contains
`kernel`, `architecture` and `macOSVersion`. A preview marker adds
`backgroundTargetId` to the fields in the single-run preview spec and requires
`operation: "verify-sign-in-recovery"`. Missing or stale targets, different
worktrees, source changes during approval, and unrecognized command or operation
strings produce no local execution.

### Composer actions

The existing `@` menu groups the preview and terminal actions under **This Mac**
in an eligible Chat and worktree. The draft must contain only the menu query
and have no references or attachments. Select an action with the mouse or
keyboard to replace the query with a worktree-bound draft. Starting a terminal
grant requires Mac approval before staging. A separate preview approval
appears when the Mac receives a matching request from the Main agent. The
owner sends the draft with the normal Chat composer. In-progress status stays
visible. **Stop background Mac checks** remains available during a live grant.

Acceptance covers mouse and keyboard selection, opening and dismissing the
menu without issuing a Mac request, preserving a populated draft, rejecting
an owner or worktree change during approval, and checking the selected
worktree and grant at send time.

This adds no public endpoints. It uses the existing authenticated owner Chat,
project/worktree, source verification and receipt endpoints. Validation covers
both foreground paths, grant/scope mismatch, changed preview operation, stop,
deduplication, and the three commands in a real Mac PTY. The matching-client
acceptance sends two batches and the fixed preview action from one Main Chat,
closes the Chat renderer before dispatch, and checks its canonical receipts.
The preview source is restored after the run.

Packaged device enrollment, selecting already-open Mac terminals, an
interactive two-way terminal session, arbitrary application control, foreground
takeover, and owner-visible execution history remain separate milestones.
Public usage docs follow in the site repository when packaged enrollment and
supported actions are ready for review.
