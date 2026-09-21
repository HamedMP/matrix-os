# S07 core Greptile review receipt — #1807

Base: `124/s07` at `b72f47a0a`. Local review fix: `d929f0996`. The coordinator owns restack, push, submission and final review.

## P1 corrections

- The collaboration scope-runtime client now rejects every `runtime.create` without a sandbox manifest, including `chat_ai`. It also checks the advertised sandbox workload and matching scope before forwarding a request. Downstream S09 must pass the actor, scope and authoritative execution-root manifest; absent that, shared AI fails closed.
- The production supervisor derives allowed sandbox mount roots from `MATRIX_HOME` (default `/home/matrix/home`), limited to `projects/` and `worktrees/`. Mount validation tolerates an absent optional root while retaining canonical-path, symlink, directory, world-writable-parent and top-level-hardlink checks. A shared Chat rooted outside those host-managed directories needs an approved root mapping before launch.
- The supervisor advertises `chat_ai` as the sole sandbox workload because the fixed launcher has no terminal PTY adapter. It rejects a sandboxed terminal request even if a supplied adapter claims terminal support. The readiness probe therefore reports sandbox terminal support as false while terminal observation remains available.
- `createSandboxReadinessProbe({ client }).supported` is the integration seam for the preflight readiness route. Its production registration is in the downstream gateway composition packet; S07 has no production readiness route. Until wired, the gateway must keep project/Chat preflight fail closed.

## Tests and gates

- RED: gateway sandbox test rejected expectation failed because bare `chat_ai` resolved; policy capability test found the advertised terminal workload. Initial focused run: 2 failed, 12 passed, 3 skipped.
- RED: production-root test failed with `sandboxRootsForHome is not a function` (1 failed, 13 skipped).
- RED: supervisor terminal test expected `adapter_unavailable` and got `runtime_unavailable` (1 failed, 13 skipped).
- GREEN: `pnpm exec vitest run tests/gateway/scope-runtime-client.test.ts tests/gateway/collaboration-scope-runtime-sandbox.test.ts tests/scope-runtime/collaboration-policy-boundary.test.ts tests/scope-runtime/systemd-launcher.test.ts --maxWorkers=2` — 4 files, 33 passed, 3 skipped.
- GREEN: `PATH=/home/nima/.bun/bin:$PATH bun run typecheck` — exit 0.
- GREEN: `PATH=/home/nima/.bun/bin:$PATH bun run check:patterns` — 0 violations, 5 existing warnings.
- No database behavior changed, so no Postgres suite was run. The three root-systemd host isolation probes remain unrun; they require `COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1` on the disposable host. No host isolation result is claimed.

## Changed paths

`packages/gateway/src/collaboration/scope-runtime-client.ts`, `packages/scope-runtime/src/main.ts`, `packages/scope-runtime/src/sandbox.ts`, `packages/scope-runtime/src/supervisor.ts`, `tests/gateway/collaboration-scope-runtime-sandbox.test.ts`, `tests/gateway/scope-runtime-client.test.ts`, `tests/scope-runtime/collaboration-policy-boundary.test.ts`.
