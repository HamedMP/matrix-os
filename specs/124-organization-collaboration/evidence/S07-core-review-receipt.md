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

## Review round (2026-09-21)

Unresolved Greptile threads on #1807 at head `f3f58b0a1`:

| Thread | Outcome |
| --- | --- |
| P1 `scope-runtime-client.ts` shared Chats bypass sandbox (outdated) | Fixed by `c8f11f852`: `createRuntime` rejects every launch without a manifest (`if (!input.sandbox) throw runtime_unavailable`). |
| P1 `systemd-launcher.ts` sandbox roots unconfigured | Fixed by `c8f11f852`: `main.ts` passes `sandboxRootsForHome(MATRIX_HOME ?? "/home/matrix/home")` (`projects/`, `worktrees/`); the launcher's empty default only applies to callers that configure nothing. |
| P1 `sandbox.ts` terminal support overstated | Fixed by `c8f11f852`: `SCOPE_RUNTIME_SANDBOX_CAPABILITY.workloads` is `["chat_ai"]`; the readiness probe reports `sandboxTerminalSupported()` false (locked by the "sandbox readiness probe" test). |
| P1 `sandbox-readiness.ts` readiness probe unwired | No production `ReadinessProbes` composition exists in this ancestry (`evaluateCollaborationReadiness` is only called from tests), so the production seam is the shared AI eligibility that `createSharedAiRuntime` reconciles into every Chat scope. `28cd30c4a` derives that eligibility through `createSandboxReadinessProbe(...).sandboxRunsSupported()` and returns the probe as `readiness` from the runtime for the preflight route composition. |
| P1 `scope-runtime-client.ts` shared Chat launches always fail | Valid: the production Chat adapter omitted the manifest and the production catalog did not pin the policy, so every launch died with `runtime_unavailable` after the UI had offered the run. RED `7c6183c7e` (4 failures). GREEN `28cd30c4a`: `SHARED_AI_PROFILE_CATALOG` pins `SCOPE_RUNTIME_SANDBOX_POLICY_{VERSION,DIGEST}`; `ScopeRuntimeChatClient.createRuntime` and the adapter carry `sandbox?: ScopeRuntimeSandboxManifest` (same shape as S09) and the adapter fails closed before launch without a scope-matching manifest; `createSharedAiRuntime` takes a `sandboxManifests` source, resolves the manifest inside `prepare` and refuses preparation without one; eligibility is `null` unless the probe and a source are both present. |

Consequence recorded for the coordinator: this layer has no execution-root resolver, so production wiring passes no `sandboxManifests` and shared AI reports **no eligibility** (unavailable before any launch) until the S09 layer supplies its root resolver through `sandboxManifests` (or adapts the eligibility gate when it restacks). That is the locked "no sandbox-less shared runs" state, made truthful instead of failing at launch.

Follow-up in the same round: the real-Postgres wiring characterization "enables M2 only after the exact scope-runtime profile is available" went RED under the pinned catalog (its fake supervisor advertised no sandbox policy and nothing supplied a manifest). Split as a test commit that updates the fake supervisor to advertise the pinned policy, wires a manifest source and adds two disabled-state cases (no policy; no source), then a fix commit that adds the `sandboxManifests` passthrough on `enableSharedAi`. `server.ts` passes no source on this layer, so production logs `shared AI disabled` until S09 wires its resolver.

Checks: adapter, sandbox, client, shared-ai-runtime and registry suites → **42/42**; wiring suite on real Postgres **12/12** (plus sandbox/adapter rerun 23/23); `bun run typecheck` exit 0 (all packages, rerun after the wiring change); `bun run check:patterns` 0 violations, 5 pre-existing warnings.

## Review round 3 (2026-09-21)

Greptile scored #1807 **2/5** at head `9299e4337` with **no unresolved threads**; the verdict named three
blockers. Each is answered below.

| Verdict blocker | Outcome |
| --- | --- |
| "the production readiness integration remains incomplete" | Valid for this layer. RED `e341772ac`, GREEN `4a228442e`. |
| "production shared AI still has no manifest resolver" | Expected and locked; explained below, now also recorded at the call site. |
| "relay eviction leaks upstream sockets" | Lower layer (`124/s05-relay`, #1804); evidence below, no change on this layer. |

**Readiness integration.** `createSharedAiRuntime` returned the sandbox probe as `readiness` and
`enableSharedAi` dropped it, so the probe's `supported()` had no production reader at all: nothing could
report a shared project or Chat as `unsupported` when the supervisor stopped advertising the pinned sandbox
policy. The runtime now answers `sandboxSupported(subject)` — it calls `client.refreshCapability()` first,
because the startup capability is only a snapshot, then applies the probe — and the gateway wiring exposes
the same seam, returning false whenever shared AI is not running. That is exactly the input the preflight
readiness composition consumes (`createGatewayReadinessProbes({ sandboxSupported })` in the capability
routes layer), so the probe is now reachable from production rather than only from a test. RED test drives
`evaluateCollaborationReadiness` through the wiring seam against the real fake supervisor: with the policy
advertised, `project` and `chat` are not `unsupported`; after the host drops the policy mid-test, the next
evaluation is `unsupported` for both; `file` stays shareable; and both shared-AI-disabled cases answer
false. `evaluateCollaborationReadiness` still has no HTTP caller in this ancestry — the preflight route
lands with the capability routes — and that remains deferred scope, not a dead seam.

**No manifest resolver in production.** This is the locked "no sandbox-less shared runs" decision, not a
regression. This layer owns the manifest contract and the fail-closed gate but has no execution-root
resolver, so `server.ts` passes no `sandboxManifests` source and shared AI reports **no eligibility**
(disabled before any launch) instead of offering runs that would die at launch with `runtime_unavailable`.
S09 plugs its execution-root resolver into `sandboxManifests` when it restacks. The call site in
`server.ts` now states this in place so the deferral is visible in the diff.

**Relay upstream leak (not this layer).** Confirmed in `packages/platform/src/platform-websocket-upgrade.ts`,
introduced with the relay reservation sweep on `124/s05-relay` (`d23bb705c`): the direct branch registers
`directUpgrade.onEvict(() => { socket.destroy(); })`, which tears down the client socket only. The upstream
TLS socket to the home is destroyed solely by `socket.on('error', onSocketError)`, and `socket.destroy()`
emits `close`, not `error`; `socket.once('close', directUpgrade.release)` only frees the counts. An
idle-evicted reservation therefore leaves the upstream connection open until the home or the network closes
it. Routed to the #1804 owner; the fix belongs in that layer's upgrade listener.

**Gates.** `collaboration-wiring` **14/14** on real Postgres (the two new assertions plus the new readiness
test); sandbox, scope-runtime client, policy boundary and chat execution adapter suites **36/36** (3 skipped
host-only); `bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 pre-existing warnings. No
React files changed, so react-doctor does not apply.

### Fail-closed evidence for "production shared AI is dead on this layer"

The gate is deliberate and holds at four points; none of them may be weakened to make a launch succeed.

- `packages/gateway/src/collaboration/scope-runtime-client.ts:229` — `createRuntime` rejects with
  `runtime_unavailable` when a launch carries no sandbox manifest, so no shared run can reach the supervisor
  under the wider owner profile.
- `packages/gateway/src/collaboration/shared-ai-runtime.ts:123` — `deriveSharedAiEligibility` returns `null`
  without a manifest source, so the scope reports no eligibility rather than offering a run that would die at
  launch; `shared-ai-runtime.ts:271` resolves the per-run manifest from that source inside `prepare`.
- `packages/gateway/src/collaboration/wiring.ts:315,340` — `enableSharedAi` accepts and forwards an optional
  `sandboxManifests` source; the seam exists on this layer and is unset, not missing.
- `packages/gateway/src/server.ts:4363` — production passes no source, with the reason recorded in place.

S09 supplies the execution-root resolver through that same `sandboxManifests` seam when it restacks onto this
layer, at which point production shared AI becomes eligible with every run sandboxed. Until then "disabled" is
the correct reported state.
