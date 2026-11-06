# Preserve single-use commands during native qualification

> ENG-432 / spec639. Execute with subagent-driven-development. Source qualification and actual Linux/provider acceptance remain separate.

**Goal:** Run the frozen real SDK through an untouched disposable worker command socket after meaningful sandbox checks, and prevent diagnostics from consuming installed or other DevStack command sessions.

## Evidence and constraints

An actual Linux qualification passed placement, frozen dependency/build provenance, supervisor/capability and worker isolation, then failed its SDK step. The harness first connected both owned worker command sockets as host positive controls. The fixed worker intentionally reserves its command slot at first connection and never releases it. A separate same-version SDK/native/Node test with a loopback fake provider and no external network returned success. Repair the harness; do not loosen the runtime's single-use, auth, sandbox, source, namespace or shutdown guarantees.

- No Main, installed Dev, live OrbStack projection, production ledger, provider call, credentials, new VPS, merge or external message. Source/test work only; controller owns separate target actions. Frozen failed receipts and state remain intact.
- Preserve exact source/lock/archive/compiled/Node and unit incarnation checks, root/network/mount/cgroup identity, bounded receipt/ownership tracking, generation/restart/drain/cleanup and installed/peer invariance gates. A stub or standalone SDK success does not close native acceptance.
- Diagnostics must not connect discovered installed/foreign single-use command endpoints. Keep their metadata-bound paths as negative targets, but label their host evidence as metadata only rather than claiming connected/live reachability. Dedicated owned disposable control workers supply active positive controls; legacy supervisor/broker IPC controls retain their current bounded behavior.
- Keep all sacrificial control and SDK/drain workers registered with the existing ownership ledger and bounded cleanup. No reconnect or runtime replay retry, fake successful SDK result, permanent worker behavior change, or unowned unit action.
- English public-safe repository and separate site documentation. Native gh stack for dependent PR, hard 50 files/3000 additions; aim 20/1000. No concurrent implementation agents.

## Task 1: Separate consumable controls from SDK dispatch

Own scripts/ops/devstack-native/{proof,controls,receipt}.mjs and focused helper extraction only if needed, their owning tests, and minimal developer docs; do not change runtime worker semantics. Supply disposable isolation/control workers for active socket checks. Create and qualify a fresh SDK worker whose command endpoint has never received a host-control connection. Verify its exact security and Node/identity plus sandbox denials against the existing control targets before the first bounded SDK dispatch; do not mistake a prior control worker's isolation evidence for this new worker's identity. All workers remain tracked across crash/reconciliation and cleanup. Preserve the two-worker namespace/root/cgroup separation proof and avoid active probes of external one-shot commands.

TDD with real Unix listeners and the actual single-use slot contract: existing harness order consumes a command; fixed order sends the actual SDK command once to a fresh socket. Prove installed/foreign command sentinels receive zero connections, remain negative targets and are labelled metadata-only; owned controls really receive their positive connections. Cover failure after each new worker registration, bounded cleanup, receipt roles, and restart/drain tracking as appropriate. Retain false/unknown-denial failures and all old checks. Run focused covering suites/syntax/diff, commit, report, then independent task and whole-plan review. Use synthetic/fake provider only; controller subsequently reruns frozen native qualification.

Update existing separate site docs with the disposable-control/one-shot qualification boundary without starting a preview server, invoking Clerk keyless or inferring completion. No unrelated UI or resource change.
