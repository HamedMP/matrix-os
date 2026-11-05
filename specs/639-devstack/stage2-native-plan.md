# Stage 2 Native Execution Isolation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent code tasks, followed by controller-owned native qualification. Steps use checkbox syntax.

**Goal:** Run an isolated native execution candidate on the existing Dev Computer without adopting, stopping or changing its installed Matrix runtime.

**Architecture:** Derive one validated deployment namespace for supervisor, worker units, state, sockets and source placement. Preserve production defaults. Qualify the new manager against legacy and peer managers before running a bounded, owned Linux/x64 harness. Readiness monetary accounting is a separate implementation plan and remains a prerequisite to further paid acceptance.

**Tech Stack:** Node 24, TypeScript, pnpm 10.33.4, PostgreSQL/Kysely, systemd, Unix sockets, native Agent SDK.

**Spec:** Existing specification PR [#3023](https://github.com/HamedMP/matrix-os/pull/3023), `specs/639-devstack/spec.md` in the adjacent spec worktree, especially T1/T2, A14/A15. Tracking: [ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack).

## Global Constraints

- Existing Main is outside scope. Preserve active Dev service definitions, invocation IDs, installed artifacts, home, credentials and ledger. No provisioning, production deployment, merge or external message.
- The user approved continuing the Stage 2 sequence and delegated probe-budget selection; their repeated no-Trellis preference persists. This plan formalizes the approved native-isolation step rather than adding a task or approval gate.
- Use manual isolated worktrees, TDD, Conventional Commits, native GitHub stacks for dependent PRs and English online descriptions. No more than 3000 additions or 50 files per PR; aim below 1000/20.
- Keep the running OrbStack worktrees and old implementation checkout at their accepted revisions; do not rebase a live source projection.
- Preserve worker network isolation, fixed/scrubbed environment, capability restrictions, cgroups, resource limits, filesystem checks and authorization. Namespace is operator configuration, never caller IPC input.
- Local unit/socket tests and ARM evidence do not qualify the Linux/x64 Dev. Fake inference closes SDK/transport evidence only, not real provider/accounting acceptance.
- No paid call until the separate monetary probe guard and account allocation are ready. No new credit, balance/spend reset or implicit budget increase.
- Plans belong in `specs/`; public docs require a separate site-repository PR. Private host identifiers, configs, tokens and captures stay outside the repo.

## Review Focus

1. Installed legacy discovery must not even match new namespaced workers; cleanup must never touch peer/legacy units or roots.
2. A second manager, failed launch, reconcile or shutdown must not adopt another manager's runtime handles or sockets.
3. Namespaced source/home configuration must fail closed rather than silently reverting to installed paths.
4. Deployment-parametric Bot/Pi dependencies must retain honest profile fingerprints and all fixed security properties.
5. An interrupted acceptance harness must retain conservative ownership and cleanup only its own newly created units; original Dev state must remain independently observable.

## Task 1: Namespace the native supervisor and Gateway host

**Files:**
- Create `packages/scope-runtime/src/host-config.ts` and `systemd-unit-identity.ts`.
- Modify `packages/scope-runtime/src/main.ts`, `systemd-launcher.ts`, `bot-profile.ts`, `package.json` and `packages/gateway/src/startup/scope-runtime-host.ts`; minimally adjust `packages/gateway/src/collaboration/shared-ai-runtime.ts` (a small configured-host helper may be extracted).
- Add `tests/scope-runtime/host-config.test.ts`, `systemd-namespace.test.ts`, and `tests/gateway/scope-runtime-startup-namespace.test.ts`; extend owning profile/launcher tests.
- Update only hardcoded profile-version acceptance expectations in `scripts/spikes/collaboration/production-supervisor-acceptance.mjs`; do not execute that disposable-only script on active Dev.

**Interfaces:**

`resolveScopeRuntimeHostConfig({env, homePath?})` returns `namespace?`, `appRoot`, `runtimeDirectory`, `stateRoot`, `supervisorSocket`, `brokerSocket`, `workerUnitPrefix`, `supervisorUnit` and optional `commandSocketRoot`.

Only two new operator inputs are accepted:

```text
MATRIX_SCOPE_RUNTIME_NAMESPACE=eng432-stage2
MATRIX_SCOPE_RUNTIME_APP_ROOT=/var/lib/matrix-devstack/eng432-stage2/app
MATRIX_HOME=/var/lib/matrix-devstack/eng432-stage2/home
```

`MATRIX_HOME` already exists. Namespace syntax is one to 32 lowercase ASCII letters/digits/hyphens, begins with a letter and ends with a letter/digit. Empty, whitespace-padded, wildcard, control, path-separator and overlength values fail. Undefined namespace preserves existing names/paths. An app-root override without a namespace fails.

Namespaced mode requires explicit canonical app root and home equal to `/var/lib/matrix-devstack/<namespace>/app` and `/var/lib/matrix-devstack/<namespace>/home`. If `homePath` and `MATRIX_HOME` are both supplied they must agree. Reject installed defaults and overlapping/unqualified paths before systemd mutation.

Derive:

```text
supervisorUnit = matrix-devstack-<namespace>-scope-runtime.service
workerUnitPrefix = matrix-devstack-<namespace>-scope-runtime-
runtimeDirectory = /run/matrix-devstack/<namespace>/scope-runtime
stateRoot = /var/lib/matrix-devstack/<namespace>/scope-runtime
supervisorSocket = <runtimeDirectory>/supervisor.sock
brokerSocket = <runtimeDirectory>/broker.sock
commandSocketRoot = /run/matrix-devstack/<namespace>/c
```

`createScopeRuntimeUnitIdentity(namespace?)` is the single implementation of worker-name creation, exact parsing, discovery glob and supervisor identity. A launcher accepts only `namespace?: string`, never arbitrary prefixes. Unfiltered foreign discovery rows are skipped before state access or stop/reset. Prefixes must fall outside legacy `matrix-scope-runtime-*.service`.

Namespaced host command sockets use `<commandSocketRoot>/<32hex>/worker.sock` (and `inference.sock`), outside the longer persistent worker root. Main forwards this trusted socket root into the launcher; it is never IPC input. Preserve existing guest bind destinations and security, and keep legacy socket layout unchanged. For a 32-character namespace these host paths are 100/103 UTF-8 bytes, below Linux's 107-byte pathname limit. Creation, failure cleanup, stop and orphan reconciliation must own both state and socket directories; never follow a foreign symlink or remove a peer directory. Exercise a real worker-command round trip with a peer sharing the runtime suffix; tests may inject shorter trusted temporary socket roots.

Resolve SDK/native/worker/Bot paths from `appRoot`. Retain Linux/x64 default behavior and select the native SDK package for Linux/arm64 to permit real local namespace qualification; reject unsupported architectures. Reuse the already-proven PR3157 architecture rule, without copying dependencies across operating systems.

Use the shared host resolver in the small Gateway startup helper, forwarding both sockets. Invalid namespaced configuration must terminate this startup path, and a namespaced constructor failure must never return undefined into a legacy collaboration fallback. Update the minimal collaboration fallback to use the same validated deployment configuration (extract a small configured-host helper if needed). Test the actual absent-host fallback against a live legacy socket sentinel and prove no legacy connect/bind/unlink. Add a package subpath export for the resolver; do not edit the 2000+ line Gateway server composition file.

Bot dependencies become trusted `<supervisor-unit>` template materialization. Bump Bot and ManagedPi profile versions **2 -> 3** and their derived digests. Default materialized `BindsTo`/`After` remain identical. Preserve Chat's profile version/digest and all fixed security arrays, worker argv and scrubbed environment. Do not assert different DynamicUser UIDs; prove roots/cgroups/namespaces instead.

- [ ] Write failing tests for default parity, validation and all three manager identities with identical runtime suffixes.
- [ ] Run focused tests and record meaningful failures before implementation.
- [ ] Implement the resolver, identity helper and wiring; extract naming from the 853-line launcher rather than growing it materially.
- [ ] Prove active/list/reconcile/startup/shutdown/failure/stop affect only own units, roots and handles; peer/legacy sentinels survive.
- [ ] Prove two actual Unix-socket client/server/broker stacks close independently and reject foreign handle/generation authorization; cover startup forwarding.
- [ ] Run profile, sandbox, worker-environment, allowlist, symlink/hardlink, limits and authorization regressions plus package typecheck.
- [ ] Commit explicit paths and report RED/GREEN evidence, exact commands/results, changed files and concerns.

## Task 2: Add an owned native qualification harness

**Files:**
- Create `scripts/ops/devstack-native-acceptance.mjs` and focused helper modules under `scripts/ops/devstack-native/` (each below 500 lines).
- Add focused tests under `tests/scripts/devstack-native-acceptance.test.ts`.
- Add repository usage/boundary documentation to `docs/dev/devstack.md` (create if absent).

**Interfaces:** The CLI accepts `--namespace=<slug>`, `--app-root=<absolute>`, `--home=<absolute>`, and `--mode=preflight|run`. Paths must match Task 1's resolver. Preflight is read-only. Run requires Linux/root, acknowledged source/lockfile and a protected purpose/namespace/source marker. It refuses existing/foreign units or state instead of stealing ownership. Root-owned source placement and native dependencies are prepared by the controller through an independently verified existing transport.

Use the hardened existing supervisor-unit properties as the baseline, changing only owned namespace/source/home/runtime/state placement. Create only the derived transient owning supervisor and its workers. Never stop/kill/restart installed Matrix services or rewrite installed `/opt/matrix` contents/envs. Do not invoke either existing disposable-only acceptance script unchanged.

Run requires explicit `--ack-source=<40hex>` and `--ack-lockfile=<64hex>`. The controller prepares `<namespace-root>/.native-acceptance-owner.json` with version1, purpose `matrix-devstack-native-acceptance`, namespace, appRoot, home, sourceSha and lockfileSha256. Require a root-owned0600 single-link regular file with no symlinked ancestors and exact values matching the source checkout/lockfile. Preflight reports readiness without creating the marker, directories or units. Keep this marker outside the command-socket root. On rerun, refuse any live own unit or ambiguous partial state; cleanup may stop only units created by this invocation, retaining source, home and the marker. Include both the derived runtime directory and its sibling command-socket directory in the supervisor's narrowly scoped writable paths.

Reuse the native acceptance scripts' actual SDK and inference-broker protocol knowledge in focused helpers without importing an auto-running destructive entry point. Exercise the real native executable and transport with a fake broker; no provider call or production credential is needed.

Retain a machine-readable receipt containing source/lockfile/build hashes, Node/SDK/native paths and versions, actual SDK result, fixed systemd properties/cgroups/root/mount/net namespace evidence, denied network/credential/cross-instance access, recovery/cleanup evidence and before/after installed service invocation/PID/restart/artifact/socket metadata. No raw user data, environment or credentials.

- [ ] Write failing tests for foreign marker/unit/path refusal, read-only preflight, failed partial start and cleanup ownership.
- [ ] Implement bounded command execution/timeouts, symlink-safe marker reads, exact unit names and cleanup in `finally`.
- [ ] Prove fake-broker native SDK result, isolation failures, own restart/reconcile/drain and unchanged peer/legacy state; never substitute a mocked SDK result for native acceptance.
- [ ] Run focused tests and commit/report the harness and documentation.

## Controller-owned native qualification and delivery

- Verify ENG-432 and publish each independently reviewable layer through the repository native-stack workflow; no merge.
- Review each task diff and a final exact whole-branch diff; preserve original worktree/data.
- Verify the exact Dev identity with the supported owner-authenticated API before each host operation. Use an existing supported operator transport; no invented CLI flags, unpinned SSH or manual auth-proof fabrication.
- Capture read-only Dev baseline including Linux/x64, cgroups, tools, installed artifact hashes, unit invocation IDs and socket inodes. A failed privileged capability check is a blocker, never a reason to borrow another host.
- Prepare only the owned source/home and build native dependencies from the frozen lockfile on Linux. Run the harness once after local checks and code review. Stop only owned test units afterward; preserve acknowledged source/data and receipts.
- Repeat affected application/real-account gates later under the integrated source and monetary probe plan; native fake-broker proof alone does not complete Stage2 or all Preview acceptance.
- Update the existing site documentation PR or open a linked separate site PR, with actual supported operations and remaining gates.
