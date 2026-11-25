# Mac pairing validation

> **Note (2026-11-25).** Step 4's background checks (#3460) are retired in a follow-up stack in favour of the [2716](../2716-desktop-link/spec.md) desktop link.

## Reproduction

1. Run the Gateway on an isolated primary test Computer. Enable `MATRIX_DESKTOP_PAIRING_ENABLED=1` with the existing owner database, immutable `MATRIX_MACHINE_ID`, `MATRIX_HANDLE`, and owner identity. Keep the default off elsewhere.
2. Build the macOS client from this change with `pnpm --filter desktop build`. Start with an isolated app profile and sign it in using the ordinary Matrix device flow for that Computer.
3. Open **Mac Pairing…**, approve **Pair This Mac**, and reopen the menu to confirm the paired Mac. Relaunch the client and restart the isolated Gateway. Confirm that the existing binding is still shown without a second pairing. Disconnect the same Mac and repeat the restart check. Use a different device or owner to verify the previous grant cannot be used.
4. In an eligible isolated worktree Chat, choose **Allow background Mac checks** from `@ → This Mac`. Approve on the Mac and send the draft. Check that the three local exit statuses arrive in the original Chat. Interrupt the test route during delivery and verify that recovery returns just one receipt for that run. Stop from the Mac activity menu, then verify that a later matching request does not run. Check **Recent Mac Activity**.
5. The preview path can capture a Matrix-owned Electron window in its disposable local profile. Verify against its existing approval and exact-source procedure in [2694](../2694-chat-electron-preview/spec.md). Wider macOS GUI control requires the native consent and coordination described in the [follow-up](./parity-follow-up.md).

## Verification boundaries

- Local integration exercised the built Electron app on the Mac with its real encrypted storage, TLS to Gateway pairing authentication and routes, and disk-backed PGlite. The fixture used synthetic Matrix credentials and intercepted dialog replies in an independent profile. Pair, restart, outage, reconnect, disconnect, canceled re-pair and explicit re-pair were checked at the authenticated API.
- The existing background service read a synthetic committed request, ran `uname -s`, `uname -m` and `sw_vers -productVersion` in a real Mac `herdr-core` PTY, and returned the result to the fixture Chat. One deliberate first-response HTTP failure produced a retry with one stored receipt. Native Stop invalidated the active background grant, and the local history recorded `returned` and `stopped`.
- Playwright clicked the actual Matrix Chat window, typed into a draft and captured the rendered result. The fixture cleared the draft without sending it. These actions tested control within an Electron window owned by the client.
- Signed packaged-client pairing with a real Matrix owner and an isolated cloud Gateway remains an acceptance gate. The device-bound action checks have their own [acceptance](./action-authorization.md). Existing Terminal selection from a remote Chat, interactive takeover and wider macOS GUI control remain open.

## Additional Computer acceptance

The selected test target is the requester's existing Additional Computer (runtime slot `dev`). The current Gateway and Mac client admit pairing only for `primary`. A version install alone therefore cannot qualify this target. Private Preview has the same limitation with its per-machine `pv-…` slot.

Before installing a candidate, support explicitly enabled non-primary targets without reclassifying them as primary. Verify the current owner and exact runtime using the existing Matrix credentials and route. Bind the device key, action proof, grants, and delivery to the intended account, slot and machine. A changed slot, replacement machine, or mismatched token must deny access. Retain the previous installed release as the rollback target and record its exact version. Use a matching macOS development build in an isolated profile for real-account acceptance. The signed packaged-client lane requires its own feature admission and separate qualification.

Exercise the approved action on the Additional Computer, then verify that Main cannot access or inherit its pairing or action. Use the existing Matrix HTTPS and device authorization flow.


## Main Computer acceptance for Mac Verification

Use the existing Main identity with an isolated Matrix OS worktree and a separate Mac client profile. Confirm the exact installed Gateway revision exposes the pairing routes before authorizing the candidate client. The real-account run requires the matching reviewed Gateway and a compatible Mac client. The local feature admission does not change the Main release or services.

Run the current-worktree action once with local approval. Use a Mac that has explicitly allowed Chat Full Access for this pairing. Switch the same Chat to Full Access and verify that the next supported action returns a result without another modal. Exercise Stop, mode downgrade and revocation separately. Compare the current source digest, visible preview, actual test results and original Chat receipt. Restore only the trial source change. Qualify a signed packaged Mac candidate independently of the developer build and record both client and server revisions.
