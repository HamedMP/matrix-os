# Implementation Plan: Persistent Terminal Sessions Across Deployments

**Stack base**: PR #1092 | **Updated**: 2026-07-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/109-persist-terminal-sessions/spec.md`

## Summary

Move production terminal ownership out of the replaceable gateway into a stable,
root-owned supervisor and one fixed systemd template unit per immutable runtime.
The gateway becomes an unprivileged protocol client and owns only browser attach
PTYs. Durable receipts describe identity and recovery intent; ephemeral one-shot
descriptors carry bounded launch data; the S2-proven `v0.44.3-matrix.1` Zellij
build provides confirmation-gated, bounded resurrection after explicit owner
recovery without destructive banner reflow.

Production implementation is gated by two disposable-VPS proofs. The first stack
layer adds a production-representative spike harness and records S1/S2 evidence.
Only a passing evidence manifest authorizes the later runtime, gateway, UI, and
updater layers.

## Technical Context

**Language/Version**: TypeScript 5.5+ on Node.js 24; Bash for installer/spike orchestration; one minimal Linux C acceptor for `SO_PEERCRED`
**Primary Dependencies**: Hono, Zod 4 (`zod/v4`), node-pty 1.1, Zellij `v0.44.3-matrix.1` (pinned 0.44.3 source plus reviewed resurrection patch), systemd, native Node runtime bundled under `/opt/matrix/runtime/node`
**Storage**: Owner-controlled bounded JSON receipts/name index under `$MATRIX_HOME/system/terminal-runtime`; ephemeral descriptors/locks under `/run`; Zellij cache under owner storage
**Testing**: Vitest contract/unit/integration tests; shell contract tests; disposable Ubuntu preview-VPS spike and acceptance workflows
**Target Platform**: Ubuntu customer VPS, systemd system manager, cgroup v2, x86_64, `matrix` owner account
**Project Type**: Monorepo web application plus stable VPS host services
**Performance Goals**: protocol inspection under 250 ms locally; readiness within 30 s; attach latency comparable to current Zellij attach; reconciliation bounded to 128 inactive records plus live units
**Constraints**: no production direct-spawn fallback; no user-derived launch argv/environment; one cgroup per runtime; exact-version resurrection proof; ≤128 KiB descriptors; ≤128 pending/inactive sets; 10-minute descriptor TTL; seven-day inactive retention
**Scale/Scope**: one owner per VPS, up to 128 inactive recovery sets, aggregate `TasksMax=2048`, per-runtime `TasksMax=512`, protocol v1 compatible with current and previous gateway bundle

## Constitution Check

*GATE: Must pass before Phase 0 research and was re-checked after Phase 1 design.*

| Principle | Gate | Result |
|---|---|---|
| Owner data | Receipts, aliases, and history stay in owner-controlled storage; explicit Delete removes runtime state only after cgroup emptiness | PASS |
| Headless core | Supervisor protocol and lifecycle work without the browser; Canvas/Desktop only render additive state | PASS |
| Defense in depth | Owner-only peer credentials, strict Zod schemas, bounded frames/files/collections, fixed systemd target, generic client errors | PASS |
| TDD | Every production phase starts with failing negative/contract tests; S1/S2 precede implementation | PASS |
| Worktree/PR/Greptile | Manual worktree, Graphite stack, Conventional Commit titles, 5/5 per layer | PASS |
| Documentation | Spec 107 correction is downstack; private public-site update remains the final verified layer | PASS with documented cross-repository dependency |

The only language exception is a small Linux C socket acceptor. Node's public
`node:net` API exposes Unix stream sockets but not `SO_PEERCRED`; relying on the
undocumented `socket._handle.fd` would weaken the privilege boundary. The native
acceptor performs only bind/accept, kernel credential capture, bounded framing,
and exec of one fixed handler. It passes credentials and the connected socket on
anonymous file descriptors, never argv or environment. All validation and state
logic remains strict TypeScript.

## Gate Sequencing

1. Build the exact PR host bundle and deploy it to `pr-<number>` through the
   existing preview-VPS workflow.
2. Let the same-repository, `preview-vps`-gated workflow wait for that exact
   deployment and run the fixed terminal-runtime harness through the existing
   HMAC-authenticated, bounded terminal command contract. Preview-only bundle
   assets and the current legacy sudo grant provide root execution without a
   new production endpoint or SSH credential.
3. Upload a redacted evidence artifact containing versions, unit definitions,
   PID/cgroup snapshots, cache inventory, bounded counts, corruption outcomes,
   and SHA-256 digests. Never upload terminal contents or credentials.
4. Require both `S1=pass` and `S2=pass` in the signed-off evidence summary.
5. If either fails, amend `spec.md` and obtain review before creating the
   production-foundation stack layer.

## Project Structure

### Documentation

```text
specs/109-persist-terminal-sessions/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http-api.md
│   └── supervisor-protocol-v1.md
├── evidence/
│   └── README.md
└── tasks.md
```

### Spike layer

```text
.github/workflows/terminal-runtime-spikes.yml
scripts/spikes/terminal-runtime/
├── README.md
├── run-remote.sh
├── keeper.mjs
├── matrix-terminal-spike@.service
├── matrix-terminal-spike.slice
└── verify-evidence.mjs
tests/scripts/terminal-runtime-spike.test.ts
```

### Production layers

```text
packages/terminal-runtime/
├── package.json
├── src/
│   ├── contracts.ts
│   ├── client.ts
│   ├── operation-handler.ts
│   ├── keeper.ts
│   ├── receipts.ts
│   ├── descriptors.ts
│   ├── reconciliation.ts
│   └── storage.ts
└── native/
    └── supervisor-acceptor.c

packages/gateway/src/shell/
├── registry.ts
├── runtime-client.ts
└── zellij.ts

distro/customer-vps/
├── host-bin/matrix-terminal-*
└── systemd/matrix-terminal-*.service

shell/src/components/terminal/
tests/terminal-runtime/
```

**Structure Decision**: isolate privileged/runtime contracts in a new package so
the stable host handlers and unprivileged gateway client share schemas without
sharing authority. Keep browser attach behavior in the gateway and lifecycle UI
in the existing terminal surface. Stable wrappers and native support files are
copied outside `/opt/matrix/app` by the host-bundle installer.

## Stack Boundaries

The production implementation is nine Graphite layers above the completed
spike stack. Terminal ownership remains legacy until layer 9. Layers 4 and 5
are intentionally active host-security changes and therefore require their own
disposable-VPS acceptance before later terminal work proceeds.

| Layer | Branch/PR intent | Exit gate |
|---|---|---|
| 1 | `build(terminal): ship verified Zellij runtime` | every preview/release bundle rebuilds, verifies, and embeds exact `v0.44.3-matrix.1` bytes; T009 evidence is immutable |
| 2 | `feat(terminal): define runtime contracts and durable state` | protocol/storage/locking/idempotency tests pass with no installed service |
| 3 | `feat(terminal): install supervised runtime services` | the complete protocol-v1 supervisor passes preview-only cgroup/readiness tests and starts no instance automatically |
| 4 | `refactor(host): move updates behind a root service` | two updates, forced failure, repair, and rollback pass through the typed root boundary |
| 5 | `security(host): remove unrestricted Matrix sudo` | fresh and upgraded VPSes retain required privileged flows without generic sudo/systemctl/shell authority |
| 6 | `feat(terminal): migrate gateway and agent runtimes` | explicit preview supervision passes create/list/attach/rename/delete and sensitive-argv tests while production remains legacy |
| 7 | `feat(terminal): add recovery lifecycle APIs` | recovery, races, deletion, retention, resource pressure, and telemetry tests pass in supervised preview mode |
| 8 | `feat(terminal): add explicit recovery experience` | Canvas/Desktop lifecycle UI, React Doctor, and current screenshots pass |
| 9 | `feat(terminal): activate persistent runtimes` | durable activation, legacy migration, full VPS matrix, spec 107, and canonical public docs match measured behavior |

Each layer stays below 3,000 additions and 50 files; ideal review size is below
1,000 additions and 20 files. Lower-layer review fixes are restacked with
Graphite before validating descendants.

## Activation Source of Truth

Normal application rollback must not revert an activated VPS to gateway-owned
terminal creation. A root-owned compatibility record outside `/opt/matrix/app`
is authoritative and transitions monotonically:

```text
legacy -> preparing -> supervised
```

The layer-6 gateway understands this record while production remains `legacy`.
Layer 9 idempotently migrates validated metadata in `preparing` and commits
`supervised` only after the migration is durable. Once supervised runtime state
exists, normal update and rollback preserve that mode; the previous compatible
gateway continues to use protocol v1. Supervised mode fails closed if the
socket or compatible supervisor is unavailable and never falls back to direct
spawn. Reverting to legacy is a separately authorized maintenance operation,
not an application rollback behavior.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Minimal C acceptor in a TypeScript repository | Linux kernel peer credentials are mandatory at the root boundary | Socket permissions alone do not prove the connecting uid/pid, and undocumented Node internals are not a stable security API |
| Files for runtime identity instead of Postgres | Receipts must survive app rollback/reboot while remaining owner-inspectable and available before gateway/database readiness | Platform Postgres would make terminal recovery depend on replaceable/networked components and violate the selected host-local authority |
