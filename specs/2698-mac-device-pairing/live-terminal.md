# Watch an existing Mac Terminal from Chat

> **Superseded (2026-11-25).** [2716](../2716-desktop-link/spec.md) attaches to desktop terminals live over the desktop link. A follow-up stack retires this watch path; it keeps working until then.

Tracking ENG-495. In an eligible private worktree Chat on the paired Mac, choose **Watch an existing Mac terminal** from the `@` menu. Select a live Terminal in the local picker. The native **Watch locally** approval identifies the Terminal, Chat and worktree. The original Chat shows the latest visible screen in a local panel with **Stop watching**. The panel stays separate from the draft and transcript.

| Local IPC | Authority and input |
| --- | --- |
| `chat:mac-terminal-watch-start` | Trusted Electron main renderer frame, same signed-in owner and primary Computer, eligible idle personal Chat and registered worktree. Takes Chat and worktree IDs and a new request UUID. Native approval and paired-device proof bind the selected live Terminal and original window. |
| `chat:mac-terminal-watch-read` | Same trusted window, Chat, worktree and opaque watch ID. One read in flight. Recheck the authoritative Chat placement and pairing before releasing screen text. |
| `chat:mac-terminal-watch-stop` | Same trusted renderer frame, Chat and worktree. Takes the main-issued watch ID or the original request UUID if the renderer has not received the watch ID. Succeeds without a network authorization check so the owner can stop after losing connectivity. |

Only one Terminal watch or terminal-check operation can be active per app. Allow up to one minute for approval and five minutes of observation after approval. Poll approximately every two seconds from the originating Chat. Reuse the pinned Herdr Core visible-screen reader with no history, input, resize, or attachment. Render at most 2,000 sanitized Unicode code points at a time, replacing the previous screen. Terminal text never enters a Chat draft, transcript, provider request, or activity log. Retain only the operation outcome in Mac Activity.

End the watch and clear its screen when the original Chat loses eligibility or closes, the user stops it, the app/account/Computer changes, the paired device is revoked, the Terminal connection or incarnation changes, a read fails, or the session expires. Reopening the Chat or reconnecting requires a fresh selection and native approval. Leaving the Chat during startup cancels that request without waiting for the picker or approval. In-flight results are discarded after cancellation. Watching can resume once the Chat is idle and still has an eligible worktree run. The watch never closes the original Terminal.

## Validation

Use a built Electron Desktop client with an isolated profile, authenticated pairing routes and two live Mac PTYs with distinct output. Approve one watch and check that new output appears in its original Chat. Verify that Stop and a disconnected Terminal clear the output, the other PTY remains unaffected, and the Gateway receives no Chat submission. Test wrong scope, overlapping reads, revoked pairing and late results after navigation or Stop. Use a signed client and an authorized isolated Computer as the separate live-account qualification. Document the user workflow in the public docs once that qualification passes. Interactive terminal transport, agent input and takeover require their own scoped design and acceptance.

## Isolated Mac acceptance

The macOS development build used an isolated Electron profile, loopback TLS, the authenticated Gateway pairing routes, disk-backed PGlite and Herdr Core 0.1.19. The Matrix identity and native picker and approval replies came from the test fixture. The two Terminal processes were real local PTYs. The selected terminal checked the OS, checkout directory, PTY and test input before printing its result. The original Chat displayed the update without a document reload and submitted zero turns. The other screen stayed out of the panel.

Stop cleared the panel and left both PTYs running. Reopening the Chat left the watch off until a fresh approval. Simulating an unavailable pairing route cleared the current screen. Once the route recovered, a new approval selected the second Terminal. Exiting that Terminal ended its watch and left the first process running. Mac Activity recorded operation phases without storing terminal output. Signed-client and real cloud account acceptance remain open.
