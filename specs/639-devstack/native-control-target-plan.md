# Native boundary control targets

Spec: [native-command-ipc.md](native-command-ipc.md). Shared ticket: [ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack). Deliver within the existing draft native-stack layer; no merge or deployment.

The latest owned Linux run creates two workers and verifies their directory/socket, credentials and sandbox evidence, then fails the isolation host positive-control step before SDK execution. Its preserved baseline includes stale IPC sockets from deliberately retained failed peer namespaces. The harness currently selects and connects one of those foreign targets. The coarse failure does not identify the exact first failing target, so an additional owned-listener fault is not ruled out.

## Global constraints

- Preserve the reviewed runtime at `0010de8b6313eddac507936b8187b617f8a8b2be`: directory policy, hardening, capabilities, memberships, masks, profiles, pinned dispatch, single-use Chat, bounded Bot and ownership-safe cleanup are unchanged.
- No Main/installed Dev or old local projection mutation, new infrastructure, provider/account/credential operation, merge, external message, or target action by the implementer/reviewer. Controller uses a fresh exact-source namespace after source approval.
- Active Unix positives use only the two current-run owned disposable command workers. Discovered installed/foreign IPC and command sockets remain metadata-bound negative targets, with `connected: false` and `metadata_only`; never claim their listener is live.
- Keep required metadata, successful owned Unix/TCP controls, protected-file control, worker broker positive response, exact worker denial codes, external route/interface absence, fresh SDK worker, recovery/drain/cleanup and installed/peer invariance. Do not skip or weaken a gate to obtain a pass.
- Unknown connection errors fail closed. Private error context is bounded, source-defined role/errno data only; no raw error message, arbitrary peer value or credential/path concatenation in an error code.
- English public-safe repository and separate site documentation; no site server/browser/Clerk invocation by implementer. No new dependency. Per-PR limits remain50 files/3000 additions.

## Task 1: Separate owned connection controls from foreign metadata targets

Update the focused native harness and tests, with the smallest coherent source change.

1. Reproduce the real defect using production `startControls` with valid owned disposable listeners and an actual stale foreign socket inode. Show that the old implementation fails by attempting the foreign connection; preserve RED evidence.
2. Connect only current-run owned disposable command targets. Stat every selected foreign IPC/command target, keep it in the worker denial list and label its host evidence honestly. Keep missing/non-socket metadata and unavailable owned controls as failures.
3. Retain enough bounded role/error context to distinguish an owned positive failure in a later private receipt; test this path without exposing arbitrary paths or messages. Do not consume or probe a fresh SDK worker.
4. Test that live foreign listeners receive no connections, stale foreign sockets do not block valid owned controls, missing metadata still fails, owned listeners are actually reached, and worker `ECONNREFUSED`/timeout still fail denial validation. Preserve the existing single-use/recovery/cleanup tests.
5. Update repository and separate site prose for the changed target policy. Run focused owning tests, syntax/type checks where applicable and diff/pattern checks; commit explicit paths and report exact revisions, RED/GREEN, commands/output, concerns and remaining Linux/SDK gates.

After independent task and whole-plan review, the controller updates the existing draft PR, rebuilds a fresh exact-source owned namespace and reruns the full uninstrumented native qualification. Preserve the prior failed receipt and unknown peer resources. Source approval does not certify SDK, Bot, Gateway, funded Chat or client parity.
