# Chat background execution

Approved scope: MAT-523. A Chat execution must not allocate an interactive Terminal tab. Preserve existing Terminal setup/manual sessions and owner data. Raising tab limits is not this fix.

## Design

Codex's existing structured-event runner and Unix control socket remain the provider transport. Run that runner in an independently supervised user-systemd service, retaining the sandbox launch built by the existing owner/project/worktree orchestration. A durable background reference identifies one service incarnation; it is distinct from TerminalRef. Existing terminal-backed sessions remain readable and stoppable. Other providers already using independent processes retain their adapters.

The supervisor applies bounded concurrent-job admission, MemoryHigh/MemoryMax/TasksMax, control-group termination and bounded commands. Persist launch material privately before dispatch. Never reuse a service incarnation. Gateway restart observes the durable service rather than trusting a stale PID. A failed/ambiguous stop retains ownership and leases. Logs are bounded. Idle Codex hibernation and native-thread cold resume continue through the same control/event protocol. No fake terminal binding is emitted for background work.

Admission and lifecycle reconciliation share one bounded in-process queue and Linux file lock across gateway processes. The lock spans worktree lease acquisition, durable preparation, dispatch, confirmed stop, and stale-session reconciliation. Transient-service identity is the liveness source of truth. Periodic retention starts on supervisor initialization, including after a restart with no new jobs.

Gateway recovery reattaches the native event-file watcher without replaying prompts. Each native line's byte cursor commits atomically with its normalized events in the existing provider store; that store's persistence format is unchanged. Canonical replay uses exact-turn boundaries and prefix merges for text, plus stable identities for approval/input controls. Cold resume migrates older Terminal-backed Codex sessions to background execution and clears the obsolete Terminal binding. Background stop reconciliation matches the service incarnation before settling the provider thread. Recovered Stop and approval submissions resolve the owned durable run identity; Stop uses the exact admitted request under the provider-store lock and leaves the run busy if termination is unconfirmed. Graceful shutdown detaches observation only after the native identity is durable. Pending structured dispatches retain uncertain delivery for next-startup observation instead of synthesizing cancellation. A missing live-turn request record rejects Stop as unconfirmed; it cannot report successful cancellation. A fresh replay follows any joined reconciliation so an older pending snapshot cannot consume a completion notification.

Implementation extraction: keep process supervision, launch rollback, restart observation/projection, exact-incarnation stop, and activity identity in focused modules; the existing large server/thread/orchestrator files only wire these modules into their established lifecycle paths. Full large-file refactoring is separate work.

## Authorization

No new public endpoint. The background choice is a gateway-internal parameter set by the Chat provider, not accepted from terminal setup routes. Existing owner/project/worktree sandbox checks remain authoritative. Background references are validated before systemd or filesystem use. Interactive terminal attachment refuses background sessions. No credentials or launch material are emitted to clients/logs.

## Acceptance

- A full Terminal workspace cannot reject background Chat startup; neither ensureWorkspace nor createTab is called.
- Manual/interactive sessions retain Terminal behavior.
- Stop targets one background incarnation, confirms exit and does not stop siblings.
- Persistence failure and ambiguous stop do not release resources still in use.
- Gateway restart detects background liveness independently of Terminal inventory, restores output observation without duplicate text, and forwards new approval/input controls.
- Same-native-thread continuation, idle hibernation and cold resume remain safe.
- Native provider errors and limits remain visible as bounded canonical failures.

## Delivery

Implement with failing regression tests first, then focused lifecycle/contract suites and typecheck. Prepare a draft PR and exact-code runtime acceptance. Main Computer acceptance is a separate deployment/review step; existing dev1250 baseline evidence is not post-fix evidence. Resource Manager's single-use launch token issue stays separate. Public usage documentation belongs in a separate private matrix-os-site PR after behavior is validated.

## Validation boundary

The Linux supervisor spike exercises concurrent admission, supervisor-process restart, and exact stop on the existing Main Computer through its authenticated latest-main Electron client, using isolated temporary service records. It does not deploy the modified gateway or prove a real-model Chat run on the final bundle. Final acceptance still needs a reviewed bundle: start with a full Terminal workspace, receive a real reply, continue a second turn, restart the gateway during work, and verify stop/approval behavior without creating or removing interactive tabs. Existing main full-suite failures must be compared by test name and reported separately.
