# Mac connectivity and Herdr parity follow-up

## Existing implementation and gaps

| Area | Existing code | Smallest remaining acceptance |
| --- | --- | --- |
| Device identity | Matrix login, key enrollment, and revision-bound action proofs for existing native Chat actions | Use a signed client and an isolated Matrix Computer with real device sign-in. Confirm local disconnect and remote revocation cancel an approved action. |
| Existing terminal | The Mac's private `herdr-core` host already lists and attaches to local sessions for the native Terminal. The Chat check creates its own PTY. | Let the owner select a running Terminal from the native client and give one worktree Chat a short, read-only attachment. Test that closing, replacing or choosing another terminal invalidates it. |
| Interactive input | `hc` attach has flow control and bidirectional I/O. Hosted CLI support can address a known hosted terminal independently. | Add input only after the attachment check is proven. Allow one active writer, surface who holds input, and release it locally on Take Over or Stop. Prove that input queued under an old attachment cannot arrive after takeover or reconnect. |
| Chat close and restart | The running Mac client polls the approved Chat and can retry a pending receipt with the same request key. Activity history is scoped to the account and Computer. | Exercise close/reopen and reconnect with the existing terminal attachment. A Mac process restart keeps the pairing and history and revokes active grants. Preserve that behavior. |

The existing device-bound actions keep short-lived native consent, owner/Computer/Chat/worktree checks, idempotent receipts and Stop. Reuse these checks for a read-only existing Terminal attachment before adding live input.

## Local GUI

The existing Electron preview executor is a suitable first adapter for an isolated Matrix-owned window. It can validate the candidate build, act on a known control, and return scoped screenshot evidence to the original Chat. Use a typed operation tied to a source run and window for subsequent experiments. Wider desktop access would require a separate native permission and consent flow using macOS ScreenCaptureKit for window capture and Accessibility for input. Approve only a selected window under a visible, revocable local session, with per-action validation of its identity.

Allow a single active GUI writer per Mac. An additional agent receives Busy while the local control session is active. Take Over and Stop invalidate its lease and queued inputs immediately. Disconnect releases the writer. An interrupted click or keystroke may have taken effect. After reconnection, read the visible state under renewed permission before intentionally issuing another input. Only an already-produced result uses automatic retry with the original result ID.

## ENG-501 integration

Reviewed [#3472](https://github.com/HamedMP/matrix-os/pull/3472) at `1941817ad9751a8764f87d69d40ea99704efd064`.

- Use its proposed `AgentSessionRef` for Chat and Terminal sessions, and keep the Mac pairing and window/terminal target identity in the local authority binding. The harness can identify the caller using its trusted launch scope. The device cannot derive consent from a parent/child relationship.
- Reuse the existing Chat owner repository, hosted terminal verbs and the Mac `hc` attachment primitives. Keep runtime-scoped availability, stop and receipts on their existing paths until ENG-501's cross-kind verbs land. A delivered device receipt can become an input to the original Chat without creating a second delivery store.
- Use the existing Chat subagent activity events for provider-native observations. Model the future routable child Chats and terminal agents using #3472's session refs. Present local Mac activity and device ownership as scoped operations, with a link to the originating Chat.
- Key dependencies are the session index/verbs and supervisor in ENG-501, Matrix Core MCP harness exposure in #3311, and spec 652 for the unified inbox. Pairing and its independent verification can proceed while those land.
- Keep child Chat permission inheritance, report auto-continue defaults and Mobile pane scope open for spec review.
