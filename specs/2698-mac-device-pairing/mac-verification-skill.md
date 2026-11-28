# Mac Verification Skill

Tracking ENG-495. This document defines the user flow and the initial supported verification operation.

## User flow

Choose **Mac Verification** in a private worktree Chat. The Skill supplies the instructions for preparing the candidate, running checks, opening a matching Electron Desktop preview and returning evidence to the original Chat.

- Skill alone verifies the selected worktree as it stands, including relevant uncommitted source changes.
- Skill plus a request makes the requested change in that worktree and then runs the same verification. Existing edits are preserved.
- The same entrypoint identifies when a paired Mac, an eligible worktree, or a supported verification operation is missing.

Mac Verification appears under `@` and `/mac-verification`. Selecting it alone requests native execution for the current eligible worktree. With a change request already in the composer, selecting it arms verification for the next send. The normal Chat submission keeps the user’s text and the selected worktree. Start local verification only after the exact admitted Codex run completes in that Chat and remains current. Cancel removes the pending verification intent.

If the previous worktree becomes unavailable, an ordinary text reply in an idle Chat can continue in the current project checkout after the user chooses it. An armed verification still requires its selected worktree.

## Execution and approval

| Boundary | Contract |
| --- | --- |
| Chat action | `chat:electron-preview-run` accepts `{ chatId, runId, requestKind: "verification" }` from the trusted Electron main renderer. An optional `fullAccessViewId` must match the live `{ viewId, scope: { chatId, projectId, worktreeId } }` registered through `chat:mac-verification-selection` by the same renderer. Stale Full Access requests fail without a per-run dialog. Read the canonical owner, Computer, Chat and worktree binding. Require the latest eligible completed Codex run within ten minutes, or the exact newly admitted run in the combined flow. Derive the supported source candidate from authenticated worktree reads. |
| Candidate source | Bind the base revision and changed-source manifest to the approved request. Stage source in a disposable Mac checkout and verify the staged digest before starting Electron. Treat an unsupported or changed snapshot as a failed verification. Preserve the original cloud and Mac checkouts. |
| Supervised Mac access | Show the Mac, requesting Chat, worktree, and operations in the native approval. Stop or denial ends the request. |
| Chat Full Access | The owner authorizes Full Access for Mac Verification once on the paired Mac. While Full Access is selected in the originating private worktree Chat, eligible verification runs directly on that Mac without a per-run dialog or fixed grant expiry. The native consent is tied to the exact owner, Computer, device and pairing revision. A previously paired Mac needs affirmative consent before it can honor Chat Full Access. A Chat selection alone cannot grant access to an unapproved device. The existing source verification and request freshness checks still apply. |
| Result | Return the test outcome, source provenance and screenshot of the disposable Electron window to the originating Chat. Deduplicate retries by request identity. Stop cancels a pending local action. For a direct Full Access run, recheck the same Chat, Full Access selection, source candidate and device proof before starting the build and each return attempt. Switching away from the Chat or Full Access, signing out or changing Computer, and revoking or disconnecting on the Mac cancel affected pending work. A committed receipt remains available in its Chat. |

The initial verifier accepts an unchanged Matrix OS worktree or a single plain-text sign-in label edit. It validates the registered path, Git base and exact file bytes, runs the fixed sign-in suite and opens a disposable Electron window. Other edits fail admission. Reuse the already-paired device and the trusted local checkout configured from the native app menu. Multi-file source snapshots and additional app surfaces require separate execution contracts.

### Setup

In Matrix Electron Desktop on macOS, open **Mac Pairing…** and choose **Pair and Allow Chat Full Access** for the selected primary Computer. With an existing pairing, choose **Allow Chat Full Access** once. Open **Mac Verification…**, choose a trusted local Matrix OS checkout with the matching revision and prepared offline dependencies, then enable for the app session. Select **Full Access** in the private worktree Chat to run Mac Verification directly. See recent work and stop pending actions in **Mac Activity**. Choose **Revoke Chat Full Access** in Mac Pairing to remove consent.

## Acceptance

1. Invoke the Skill alone against a changed worktree. Verify that the Mac build and screenshot match those edits.
2. Type a small sign-in label change, select Mac Verification, and send the message. Verify that only the exact completed run for that change requests the same test and preview path.
3. In Supervised mode, approve once. Verify that enabling Chat Full Access on a legacy pairing still requires local consent. After device consent, switch the same Chat to Full Access, verify its current worktree, and see the result without another Mac dialog. Closing or changing Chat, downgrading mode, Stop or revoking the pairing must prevent pending execution or result delivery. Verify an unsupported or stale request still fails. Reopening the app can reuse device consent, with authority scoped to the current selection.
4. Verify the exact cloud bundle and Mac build, matching snapshot, scoped test results, and one receipt in the originating Chat. Exercise reconnect and repeated delivery with a stable request ID.

## Isolated Mac evidence

An isolated development Electron client used loopback TLS, the real Gateway pairing routes and a disk-backed test database. Native consent replies and the Matrix actor were fixture-controlled. The trusted local checkout and Electron process were real.

With ordinary approval, the current-worktree action opened the disposable Electron candidate, passed ten sign-in tests and returned one screenshot and result after one preview approval. With a pre-authorized Mac grant, Chat submitted only the supplied change request. The fixture provided the exact accepted run and changed source. Matrix verified the digest, built and captured the local candidate, passed the same ten tests, and returned one result to the original Chat without a second approval popup. Revocation during execution or result delivery is covered by focused tests. Signed-client and real Main acceptance are separate outstanding checks.
