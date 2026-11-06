# Repair native command socket authorization

> ENG-432 / spec639. Execute with subagent-driven-development after the focused Linux candidate proof. No Trellis task.

**Spec:** `specs/639-devstack/native-command-ipc.md`.
**Goal:** Let the capability-free trusted supervisor dispatch through its pinned worker socket without giving the workload trusted host groups or weakening its sandbox.
**Architecture:** root-owned setgid command leaf, owner-published group-write-only socket, explicit host trust/active workload UID, shared semantic policy fencing.

## Global constraints

- Preserve Main, installed Dev, old OrbStack source/data and all monetary state. No provider calls during source tests; no new cloud/VPS, credential import, merge, rollout or external message.
- Modes02733/0620 are contingent on the actual Linux proof; preserve capabilities, DynamicUser/PrivateUsers, UMask, network and group membership. No world-writable or capability fallback.
- Preserve O_PATH/nofollow inode dispatch, command/generation validation, source/Node/profile provenance, single-use Chat, bounded Bot controls and exact owned cleanup. No active probes of foreign installed endpoints.
- Source/tests in this existing manual worktree and native GitHub stack. English public-safe docs; separate site documentation. Hard50files/3000added lines per PR, aim20/1000; split if required.
- Never add behavior to a1000+LOC entry without extraction: put IPC constants, trust/permission publication and descriptor policy in focused modules; launcher should delegate.

## Task 1: Shared IPC policy, publication, trusted dispatch and regression tests

Own focused `packages/scope-runtime/src/command-*.ts` modules, `runtime-directories.ts`, `worker-common.ts`, `worker.ts`, `worker-bot.ts`, `namespace-ancestry.ts`, `profile.ts`, `bot-profile.ts`, minimal launcher delegation and owning focused tests.

- RED first: real filesystem/Unix listener policy and failure-path tests plus profile/version fences. Linux-only descriptor behavior uses real Linux fixture; portable tests explicitly inject fixture trust, never masquerade as root/DynamicUser proof.
- Introduce side-effect-free canonical IPC policy/constants. Include it in Chat/Bot digests; versions Chat3/Bot4/managedPi4; harness versions unchanged, central Gateway derivation retained.
- Create only exclusive per-runtime leaves02733; verify owner and trusted group. Do not broaden namespace ancestry exceptions or alter existing/foreign leaves.
- Shared worker helper pins its owned socket, applies0620 through the descriptor alias and verifies identity/mode/group before readiness. Handle Chat and Bot, including cleanup on publication failure and preservation of replacement objects; keep inference socket unchanged.
- Host pinner receives explicit trusted parent UID/GID and expected workload UID from source-controlled host identity/verified launch state, validates policy on pinned objects, and retains fd alias until reply/closure. Bounded fixed-name UID/GID lookup must fail closed; fixture DI is typed/internal. Do not use only leaf/parent equality or dynamic-range guessing as trust.
- Preserve frame/generation/Node/namespace/provenance fences, no reconnect/preconsumption, old-profile reconciliation rejection and bounded resources. Extract helper logic instead of growing the launcher composition file.
- Run focused ScopeRuntime + Gateway policy/client suites, build/typecheck, diff and commit. Independent task review before Task2. No actual Dev action by implementer.

## Task 2: Native credential/group evidence and documentation

Own focused `scripts/ops/devstack-native/{evidence,security,proof,receipt}.mjs` changes or small extraction, their tests, repository developer docs and separate site doc change. Do not modify the service sandbox to satisfy inspection.

- RED/GREEN tests record real supervisor/worker credentials, userns and uid/gid maps, supplementary groups and command inode modes/GID; exact metadata-only foreign targets remain unconsumed. Missing/unexpected fields fail the gate.
- Require actual supervisor root/trusted group/caps empty and workload absence of trusted supplementary group. Preserve fresh SDK-worker role, source/frozen dependency/build, root/network/mount/cgroup denial, restart/reconcile/drain/cleanup and installed/peer invariance.
- Document trusted inherited IPC group, no workload group membership, cold source-vs-native qualification and private operator recovery boundaries. Update existing site documentation PR without running a preview.
- Focused suites/syntax/typecheck/diff, commit and independent task review; then broad whole-plan review. No paid call or target mutation by implementer.

## Controller gates after source review

Build/publish linked draft source PR(s) via native stack with invariant sections and matching ENG-432 links; do not merge. Prepare fresh exact-source owned Dev namespace, verify SDK/native/Node hashes, run uninstrumented qualification and retain compiled/version/identity/closure evidence. Fix actual failures through the same reviewed workflow. Full connected Gateway, multiple worktrees, funded Chat/ledger, authenticated previews, surfaces and CI remain distinct. Preserve all prior failed receipts and do not overwrite live projections.
