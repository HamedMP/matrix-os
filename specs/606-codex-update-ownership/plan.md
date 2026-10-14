# ENG-298: Codex update ownership implementation plan

> Execute inline with the executing-plans and test-driven-development skills.

**Goal:** Make Terminal updates and managed Codex consumers resolve the same explicitly promoted CLI without Hermes redirecting npm globals to a second installation.
**Spec:** Linear ENG-298 description and Hamed's complete 2026-10-14 exploration/plan; Slack thread 1791983925.023589.
**Architecture:** Preserve Hermes's private Node and command links because its own tools may need them. Reconcile both runtime-local and Hermes-local global npm configuration to the managed prefix, preserving unrelated options and owner npm overrides. Redirect only recognized npm-created local Codex shims to the managed binary after it exists. Explicitly promote the already recorded 0.162.1 contracts; retain exact runtime version gates.
**Stack:** Bash host installers, Node filesystem APIs, TypeScript/Vitest.

## Global constraints

- Work only in this manual worktree, starting at main 0348437bc120a37d861904fa7969066e8bbe9222.
- Do not change user Main, customer VPSes, production, Slack, handoff behavior, or ENG-268 auth/UI code.
- Current main contains exec/app-server 0.162.1 records for linux-x64 and darwin-arm64; qualification records are not live model-availability evidence.
- Retain explicit version admission; no arbitrary latest or automatic future-version promotion.
- Local regression evidence cannot replace current-head Greptile 5/5, actual green CI Results, current-main freshness and an independent approving review. Follow docs/dev/fast-ci.md; approval last.

## Task 1: npm ownership and migration

Files: scripts/reconcile-agent-npm-prefix.mjs; tests/platform/agent-npm-prefix.test.ts; distro/customer-vps/host-bin/matrix-install-hermes and matrix-install-tool-pack; scripts/build-host-bundle.sh.
Interface: CLI reads MATRIX_RUNTIME_HOME, HERMES_HOME and MATRIX_NODE_PREFIX, all absolute; invoked as the runtime owner by both installers. Managed prefix defaults to /opt/matrix/runtime/node.

- [ ] Write failing subprocess tests: runtime and Hermes npmrc prefixes converge; other options persist; Hermes node/npm/npx links persist; old npm Codex shim redirects; unrelated command stays; missing managed binary preserves old shim; repeat repair is idempotent; config symlinks fail without writing their target.
- [ ] Run tests and record expected failures before implementation.
- [ ] Implement atomic npmrc rewrite and exact recognized-shim migration, with no credential reads and no package deletion. Wire after successful installs and ship runtime npmrc for new bundles.
- [ ] Run focused tests and existing host-bundle/developer-tools tests. Commit.

## Task 2: explicit promotion and evidence

Files: managed installers, Dockerfile/Dockerfile.dev, packages/contracts/src/index.ts, packages/scope-runtime/src/worker-common.ts, relevant version tests, docs/dev/vps-deployment.md; evidence in this spec.
Interface: all shared-runtime consumers use the promoted 0.162.1; scope-runtime's separate stale 0.154.0 gate must be aligned rather than widened.

- [ ] Write failing version-coherence assertions covering all installation surfaces and scope-runtime, retaining unknown-version rejection.
- [ ] Run failing assertions, promote explicit pins, rerun regression suites and protocol verifier where available.
- [ ] Document update command, owner overrides, restart/rehash needs, retention of old package bytes, future unqualified-version behavior, scope-runtime compatibility and model-availability limits.
- [ ] Run appropriate typechecks/pattern scan, review final diff and prepare an English case/evidence packet. Commit.

## Review focus

Existing owner npmrc overrides remain authoritative; report them without reading credentials. Preserve custom Codex commands. Do not repoint a shim before a managed binary exists. Do not let symlink config redirect an atomic write outside its intended file. Process/schema fixtures establish compatibility only within their exercised scope. Independent live Hermes/browser and account-specific model checks remain separate acceptance work.

## Decisions

- Use the existing visible `matrix-install-tool-pack codex` command rather than adding a new public CLI command.
- Preserve Hermes Node/npm links and change its npm prefix; upstream's pinned installer explicitly documents that its own globals pass an explicit --prefix and are unaffected.
- Explicit 0.162.1 promotion is the bounded implementation of ENG-298; automatic qualification/promotion and broad version-gate relaxation are deferred design changes.
