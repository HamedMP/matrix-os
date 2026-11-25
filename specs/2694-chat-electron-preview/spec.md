# One-time Electron Desktop preview from Chat

[ENG-495](https://linear.app/matrix-os/issue/ENG-495/cloud-matrix-controls-the-desktop-computer-terminals-and-apps)

## Scope

An engineer working in a personal Matrix Chat on a cloud Computer can request one Electron Desktop preview from a completed worktree run. The engineer opens the same Chat on a macOS Matrix developer build. Matrix displays the request and asks for approval on the Mac. It builds and opens the matching candidate, captures the Electron Desktop window, and posts the screenshot and test result to that Chat. The test uses the existing Main Computer and Mac, with the regular Main services online.

The first implementation covers a single changed static label in the Electron Desktop sign-in screen. Its clone, base revision, dependencies and build/test commands are local and trusted. Launching arbitrary source, granting permanent device control, controlling other apps, and supporting cross-machine terminal commands require separate ENG-495 work.

## Request and trust boundaries

1. The completed Codex run in a personal Chat identifies its registered project worktree. A single standalone assistant line begins with `MATRIX_ELECTRON_PREVIEW_V1 ` followed by a strict JSON object with `baseSha` (40 hex digits), `sourceSha256` (64 hex digits), `label` (bounded static text), and `mainChecksPassed: true`. The cloud source assertion is distinct from the test actually run by the Mac.
2. The renderer selects only the Chat and run IDs. Electron main uses the existing authenticated runtime, re-reads the owner, worktree run, marker, and digest from the corresponding source file. The request expires ten minutes after completion. Other account or Computer scopes have independent request identities.
3. The Mac dialog shows the Chat/run, worktree, base revision, source fingerprint, and exact label. It defaults to Cancel. A single locally recorded approval claims the request before creating or launching a candidate. Losing the active authorization cancels the dialog or work. Claim retention exceeds the request window, so reopening the Chat or restarting Electron cannot repeat an accepted launch.
4. The Mac reconstructs the candidate from the exact commit in the local trusted Matrix checkout and verifies the full changed file digest. It detaches a disposable local worktree, uses fixed offline dependencies and the fixed sign-in test and build commands, and opens the candidate in a disposable Electron profile. It captures the candidate window and cleans up the preview and source changes.
5. Electron main verifies that the original runtime identity is still active. It uses the canonical owner file and turn APIs to deliver a bounded PNG and the test summary to the same Chat and worktree. A stable client request ID binds retries to one turn. Failures are visible to the user.

| Operation | Authority |
| --- | --- |
| Read request | Existing Matrix device session. Scope to the signed-in owner, active Computer, personal Chat, completed eligible worktree run, and registered file. |
| Electron invoke | Trusted main renderer frame supplies the validated Chat and run IDs. Local developer config enables the capability only on macOS. |
| Approve and run | Native Electron dialog and local single-use claim. The cloud request carries data only and cannot select a local repository, command, file path, or environment. |
| Return evidence | Electron main only, with unchanged owner/Computer authorization. Existing personal file and Chat endpoints. |

## Acceptance

- Approved request produces a real Electron Desktop screenshot containing the requested label and a focused sign-in test result. Both are persisted in the exact original Chat. Matching source is confirmed through base and complete file SHA-256. Both approved checkouts are restored or cleaned; Main services stay online.
- Expired or duplicate requests, wrong Chat/worktree/owner, noncanonical manifest, unrelated edit bytes, and malformed screenshot are rejected. Cancel or changed credentials cannot launch a candidate.
- Test a built macOS Matrix client on the authorized Main Computer and Mac before rollout. The native action is specific to Electron Desktop since its target is a local Electron process. CLI, Web Desktop, Web Canvas and mobile retain normal Chat behavior and can display the returned canonical attachment.
- Follow with a documentation-site PR once the reviewer-approved developer path is ready to expose.

## Developer client setup and use

Use a macOS Matrix developer build with Node 24 and the repository's Corepack-pinned pnpm available on its local PATH. Set `MATRIX_ELECTRON_PREVIEW_CHECKOUT` to an absolute path to a trusted local Matrix OS checkout at the same commit as the cloud worktree. The dependency cache for that commit must already exist. A reviewer can use an independent Electron QA profile and ordinary Matrix device sign-in to the primary Computer.

In the original worktree Chat, select **Request Electron preview** and send the prepared draft. A completed run binds its request to that Chat. Open the Chat in the same developer client and choose **Approve Once** in the native dialog. The candidate stays visible for up to 30 seconds and can be closed sooner. The screenshot and recorded test count then appear in the original Chat. The developer's cloud edit stays available after the preview. For acceptance, restore only the trial edit after reviewing the evidence.

The native invokes are `chat:electron-preview-available` with no fields and `chat:electron-preview-run` with `{chatId, runId}`. Only the trusted main renderer can call either. Approved requests use a 24-hour private local single-use record, bounded to 512 entries. A profile change or stale source after approval consumes the request without starting the build. Failures after build admission produce a short failure result when the authorized Chat is available. A failed delivery may leave a bounded private attachment in the existing temporary Chat attachment namespace, using its normal retention policy.

A correct request provides the actual worktree commit and full source hash and leaves the one label edit unstaged. A marker in user text or quoted code, extra source edits, a stale revision, a nonprimary runtime, or a different account cannot trigger a build. The acceptance suite checks those cases, duplicate approval, credential and source changes during consent, native sender isolation, the actual Electron build, and attachment persistence in the originating Chat.
