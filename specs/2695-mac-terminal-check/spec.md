# Run one approved Mac terminal check from Matrix Chat

Tracking [ENG-495](https://linear.app/matrix-os/issue/ENG-495/cloud-matrix-controls-the-desktop-computer-terminals-and-apps). Builds on [#3455](https://github.com/HamedMP/matrix-os/pull/3455).

## Scope

A signed-in Matrix Electron Desktop development build on macOS can approve one read-only command from an existing personal Main worktree Chat. With `MATRIX_MAC_TERMINAL_CHECK=1` and the existing herdr-core local Terminal, the owner types `@` in the empty composer, selects **Request Mac terminal check**, and approves once on the Mac. Matrix reserves a dedicated terminal and stages a worktree-bound Chat draft. After the owner sends it, the Main agent emits a request for that terminal. Electron handles the request automatically while the originating Chat is open. The Mac runs the fixed `/usr/bin/uname -s` and returns its result to that Chat using existing Matrix authorization. Mac-to-Main terminal input uses the authorized hosted CLI.

This milestone scopes the grant to one Chat, one terminal and one read-only action. The broader ENG-495 work includes reusable machine approval, general cross-machine shell verbs, background delivery, app input, visible takeover and activity audit.

## Trust boundary

| Operation | Authority |
| --- | --- |
| Prepare | Trusted main renderer for the signed-in Mac profile. Electron independently reads the active personal Chat and completed isolated worktree. Native consent names the original Chat, the fixed command and the dedicated terminal. |
| Request | Exactly one unquoted `MATRIX_MAC_TERMINAL_V1 {"targetId":"<uuid>","action":"uname"}` line in a fresh, committed assistant message from a completed Codex run. The main process re-reads the original Chat and rejects another owner, Computer, worktree, target or action. |
| Execute | Local main-process grant bound to the checked Chat and owner session. Mark it used before delivering a local challenge into its dedicated PTY. The PTY runs one fixed command and renders its output. Parse bounded output correlated to the local challenge. |
| Return | The same authenticated Gateway. A deterministic Chat turn key and the same isolated worktree bind the command output to the originating Chat. |

The grant expires five minutes after reservation. Switching the authenticated account or Computer or shutting down the client revokes it and ends the reserved terminal. Closing the reserved terminal prevents it from accepting a command. An approved run stays single-use after transport failure. The terminal is available briefly for inspection after the result and then cleaned up. The client uses existing Matrix authentication and outbound Gateway access. The Gateway and Main's installed services need no deployment for the pilot.

## Verification

- One available Mac terminal displays the result of the exact readonly command. The original Main Chat persists the result and run association after one approval. Verify the live selected terminal and the canonical result independently.
- Verify the other direction from the Mac through the hosted CLI to a named isolated Main terminal. Read the acknowledgement and exact output on Main before closing only the temporary test terminals.
- Unit tests reject bad owner, Chat, worktree, target, action, expired or duplicated request, lost authorization, and cancel before side effects.
- Validate the macOS developer app under a separate profile, with only Main and Mac. Keep the build and input bounds local. Record client and account prerequisites in review. Public documentation follows reviewer approval of the supported user path.
