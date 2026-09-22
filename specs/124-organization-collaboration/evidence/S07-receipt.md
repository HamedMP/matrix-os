# S07 receipt — execution sandbox and task policies (T035–T039)

Base: `124/s06` @ 8c3e761f4 (S06 in progress; S07 is restacked by the coordinator). Layers: `124/s07` @ 75e758713 (T035 tests, T036, T039 readiness), `124/s07-terminal` @ 2c164b5c0 (T035 terminal tests, T038, T039 enforcement).

## What landed

- **T036 sandbox policy** (`packages/scope-runtime/src/sandbox.ts`, `protocol.ts`, `supervisor.ts`, `systemd-launcher.ts`): an additive systemd policy on top of the pinned fixed profile (the fixed profile digest is unchanged). A strict `ScopeRuntimeSandboxManifest` (actor, scope, worktree host path + mode + fingerprint, network `none`/`broker_only`, optional limits that may only narrow the fixed ceilings) rides on `runtime.create`; the supervisor advertises `sandbox { policyVersion, policyDigest, workloads }` in its capability profile and refuses a bare `terminal` workload (`invalid_request`). The launcher validates the mount source against configured `sandboxRoots` (absolute, canonical, no symlinked component, directory, not swappable through a world-writable parent, no hardlinked top-level file) and appends `BindPaths`/`BindReadOnlyPaths` of the worktree at `/workspace/project`, `PrivateNetwork`, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, `ProtectHome`, `ProtectSystem=strict`, `InaccessiblePaths` for owner credential locations and `UnsetEnvironment` for the forbidden credential variables. Nothing is derived from prompt text.
- **Gateway client** (`scope-runtime-client.ts`): the catalog pins the sandbox policy digest; a supervisor without it is `unsupported_profile`; `createRuntime` forwards the manifest and refuses sandboxed or terminal launches the capability cannot honour.
- **T039 readiness** (`sandbox-readiness.ts`): projects and standalone Chats are `unsupported` until the sandbox policy is available; files, folders, apps and terminal observation are unaffected.
- **T038 task profile** (`terminal-task-profile.ts`, `terminal-adapter.ts`, `terminal-dispatcher.ts`): `sandbox_shell` (session bound to `scope-runtime-terminal-v1` with the pinned policy digest) lets a Contributor hold the controller; `host_shell` is the owner's terminal, controllable by Contributors only through the owner's explicit share (`contributorControl`, withdrawable per terminal); a Viewer observes either; a sandbox capability never implies host shell control.
- **T039 enforcement** (`revocation-enforcer.ts`, `wiring.ts`): `DirectSessionService.onEnded` with reason `denied`/`expired`/`revoked` releases the actor's terminal controller, stops every sandbox runtime bound to the actor in that scope (`SandboxRuntimeRegistry`, cap 256) and blocks further terminal input (bounded TTL/LRU set, cap 4,096, default 20 min) until `admit` on a fresh session. `closed`/`shutdown` are not revocations.

## Tests (observed)

- RED: `tests/scope-runtime/collaboration-policy-boundary.test.ts`, `tests/gateway/collaboration-scope-runtime-sandbox.test.ts` → `Cannot find module …/sandbox.js` / `…/sandbox-readiness.js`; `tests/gateway/collaboration-terminal-sandbox.test.ts` → `Cannot find module …/terminal-task-profile.js`.
- GREEN: `pnpm exec vitest run tests/scope-runtime tests/gateway/collaboration-scope-runtime-sandbox.test.ts tests/gateway/collaboration-terminal-sandbox.test.ts` plus the terminal, wiring, routes, foundation, direct-sessions, org-precondition, scope-runtime-client and shared-ai-runtime suites: 21 files, 166 passed, 3 skipped.
- Unrun (explicit `skipIf`, reason in the test name): the three host probes that need `COLLABORATION_PROBE_SCOPE_RUNTIME_HOST=1` on a root systemd host (credential files unreachable, network denied and /proc invisible, git credential helper unreachable). A disposable enrolled VPS is required; no result is claimed.
- Gates: `tsc --noEmit` clean for `@matrix-os/scope-runtime` and `@matrix-os/gateway`; `bun run check:patterns` 0 violations (5 pre-existing warnings). Full `bun run test` left to CI (host-load rule).

## Deferred / open gates

- T037 filtered workspaces, task profiles beyond `sandbox_shell`/`host_shell`, and the publication broker are deferred from V1 (tasks.md).
- Isolated PID namespaces (`PrivatePIDs=`) need systemd ≥ 257 evidence on the customer image; the policy relies on `ProtectProc=invisible` + `ProcSubset=pid` + `PrivateUsers` from the fixed profile until then.
- The scope-runtime worker does not yet run a PTY. The S07 core review repair advertises `chat_ai` only; `terminal` is deliberately absent from the sandbox workloads and remains unsupported until a real PTY adapter exists. The supervisor refuses terminal launch, and readiness reports the limitation.
- Hardlink check is bounded to the worktree's top-level files; deeper hardlinks are a residual risk recorded here, mitigated by `ProtectSystem=strict` and `ProtectHome`.
- Coordinator patches: `packages/scope-runtime/package.json` gains the `./sandbox` export; `wiring.ts` constructs `CollaborationRevocationEnforcer` and passes `onEnded` to `DirectSessionService`; the launcher's `sandboxRoots` and S08/S09's `SandboxRuntimeRegistry.bind` calls are wired by the packet that creates sandboxed runs (S09 T047/T048).

## Review repairs — 2026-09-21

Base: `124/s07-terminal` @ `eb6a4b4c7`. Test commit: `7386bb2fe`. Fix commit: `62daf9e52`.

- Fresh verified direct-session creation and renewal notify the revocation enforcer, clearing the actor/scope block. Action-budget `exhausted` is session-local and no longer releases another valid session's terminal controller.
- Pending runtime stops keep a bounded 256-entry tracking map with oldest-entry eviction; a separate count retains `settle()` awareness of every in-flight stop, including evicted entries. Runtime RPCs retain their existing request cap and timeout.
- The shell registry now persists `contributorControl` at creation and bind, supports exact owner/incarnation-checked withdrawal, and clears the flag when a terminal process is recreated. The terminal adapter carries the setting into bind.
- Real Postgres exposed an existing terminal directory-outbox JSONB serialization defect; the terminal adapter now writes its JSONB fields with explicit casts.
- RED: five focused review regressions failed before the fix. Real Postgres terminal-scope activation/reopen failed 2/8 on invalid JSONB input before the serialization fix.
- GREEN: four focused suites passed 103/103 on PGlite/filesystem; terminal-scope suite passed 8/8 on real Postgres (`MATRIX_TEST_POSTGRES_URL` from the local test environment). `bun run typecheck` passed; `bun run check:patterns` found 0 violations and 5 existing warnings; `git diff --check` passed.
- Host systemd sandbox probes remain unrun and are not claimed. The `124/s07` core layer separately configures production sandbox roots under `${MATRIX_HOME}/projects` and `${MATRIX_HOME}/worktrees`; the S09 shared Chat layer must supply a resolved actor/scope/root manifest before `chat_ai` execution.

## Review fixes (2026-09-21)

- **F3 host-shell Contributor control defaulted to granted (P1), `124/s07-terminal`.** `resolveTerminalTaskPolicy`, the dispatcher, the adapter bind and the registry create/bind all read `contributorControl !== false` / `?? true`, so sharing an owner's host shell handed Contributors the controller with no owner decision. RED `4fe20ec10` (7 failures: profile default, dispatcher default, registry create/bind default, adapter bind default, missing owner-only runtime/dispatcher method, missing route). GREEN `ec141583a`: default is withheld everywhere (absent or malformed reads as false); the owner opts in or withdraws through `PATCH /api/collaboration/scopes/:scopeId/terminal` with a strict Zod body `{ contributorControl: boolean }`, authorized under the owner-only `manage_members` capability and re-checked by `CollaborationTerminalDispatcher.setContributorControl` (owner role and capability, active terminal); the adapter records it on the exact bound incarnation via `ShellRegistry.setContributorControl` (owner/incarnation-checked, persisted in the terminal-session schema field that already existed); withdrawing drops any non-owner controller lease immediately. The frozen `CollaborationTerminal` contract is untouched; the PATCH returns `{ terminal, contributorControl }`. The spec rule "Terminal Viewer observes only; Contributor may hold the controller" now applies to host shells only after the opt-in; sandbox shells are unchanged.
- **Sandbox terminal workload truthfulness.** The advertised sandbox workloads were already `["chat_ai"]` after the S07 core review repair (`terminal` absent, `sandboxTerminalSupported()` false). Added the invariant test `advertises exactly the workloads the fixed launcher can start` (probes `buildFixedSystemdRunArgs` per workload and compares with `SCOPE_RUNTIME_PROFILE.sandbox.workloads` and each adapter), green at birth, and made the launcher check launchable workloads against `SCOPE_RUNTIME_SANDBOX_CAPABILITY.workloads` so the two cannot drift.
- Fixture updates: `collaboration-terminal-authorization` and `collaboration-terminal-websocket` modelled Contributor control on a host shell and now record the owner's opt-in explicitly (`contributorControl: true`); `collaboration-terminal-sandbox` line that encoded default-true now expects withheld.
- Gates: 15 files / 193 passed / 3 skipped (terminal sandbox, scope, authorization, control, websocket, events, discussion, foundation, routes, wiring, shell-registry, scope-runtime supervisor, launcher, policy boundary, scope-runtime sandbox) on real Postgres; gateway and scope-runtime `tsc` clean; patterns 0 violations / 5 inherited warnings. Not done here: shell/desktop UI has no `contributorControl` surface yet (no references under `shell/`, `desktop/`, `apps/mobile`), so the owner opt-in is API-only until a UI packet adds the toggle across Web Canvas, Web Desktop and Electron Desktop.

## Review round (2026-09-21)

Unresolved Greptile threads on #1808 at head `52c2790ef`:

| Thread | Outcome |
| --- | --- |
| P1 `wiring.ts` fresh sessions remain blocked | Fixed by `10db38769`: `DirectSessionService` gained `onAdmitted`, and `wiring.ts:188` calls `revocationEnforcer.admit(scopeId, actorId)` on every verified creation or renewal. Locked by "releases the controller, stops bound runtimes and refuses further input after a lease loss" (admit path) in `collaboration-terminal-sandbox.test.ts`. Greptile kept the thread because the closed-over subscribe line still exists. |
| P1 `revocation-enforcer.ts` exhaustion revokes valid sessions (outdated) | Fixed by `10db38769`: `REVOKING_REASONS` is `expired`/`denied`/`revoked`; `exhausted` is session-local. Locked by "keeps another valid session's controller when one action budget is exhausted". |
| P1 `terminal-adapter.ts` host control withdrawal lost | Fixed by `10db38769` + `17122646e`: `shell/registry.ts` persists `contributorControl` on create (line 336), bind (438) and `setContributorControl` (452–474), defaults to withheld (`?? false`), and the adapter reads it from the bound session (`terminal-adapter.ts:179`). Locked by "lets only the owner grant or withdraw Contributor control…". |
| P2 `revocation-enforcer.ts` pending operations unbounded | Fixed by `10db38769`: `maxPending` (256, oldest-entry eviction) with a separate in-flight counter so `settle()` still waits for evicted stops. Locked by "caps tracked stop operations while leaving every started stop running". |
| P2 `revocation-enforcer.ts` runtime bindings never evict | Valid. RED `043241c30` (2 failures: capacity throw, no age sweep). GREEN `04bc9652e`: at capacity the oldest binding is stopped and evicted instead of refusing the new one; bindings older than `maxAgeMs` (default 6h, bounded 1s–7d) are stopped and evicted by `sweep()`, run on every bind and by an unref'd 60s timer (`startTimer:false` for tests, `close()` clears it); eviction stops are awaitable through `settle()`. Fail closed: a runtime never outlives its revocation tracking. |

Checks: terminal sandbox/control/scope/authorization/websocket and wiring suites → **43/43** with the terminal-scope suite on real Postgres (`MATRIX_TEST_POSTGRES_URL`); `bun run typecheck` exit 0 (all packages); `bun run check:patterns` 0 violations, 5 pre-existing warnings. No production caller constructs `SandboxRuntimeRegistry` on this layer; S09 wires it and should pass nothing extra (defaults start the sweep timer) and call `close()` on shutdown.

## Review round 3 (2026-09-21, #1808 at `ab4bab247`)

Greptile scored **4/5** with one thread and a two-part verdict.

**P2 "Missing request body limit" (`terminal-routes.ts:44`, PATCH terminal). The finding is wrong.**
The PATCH handler is already behind Hono `bodyLimit`: the collaboration composition registers one
shared mutation limit for every mutating method before any resource module registers a handler
(`routes.ts:21-29`, `routes.on(["POST", "PATCH", "DELETE"], "/api/collaboration/*", mutationLimit)`
with `COLLABORATION_HTTP_BODY_LIMIT` = 96 KiB), and `registerTerminalRoutes` runs after it
(`routes.ts:33`). So the limit applies before `readJson` buffers anything, exactly as the
repository directive requires; a per-route limit here would be a second copy of the same rule.

Proven rather than argued: the oversized-body case in `collaboration-routes.test.ts` now drives a
97 KiB PATCH at `/api/collaboration/scopes/:scopeId/terminal` with a valid actor proof over the
exact bytes and asserts **413**, alongside the existing POST case. That also guards the shared
registration, since dropping `PATCH` from the method list would fail the test.

**Verdict part 2, "relay teardown can leave a still-connecting upstream socket orphaned".** Not
this layer. `packages/platform/src/platform-websocket-upgrade.ts` belongs to `124/s05-relay`, where
the client-close path was already fixed (`3378857c7`). The residual is the connect race:
`activeUpstream` is assigned only inside the TLS connect callback, so a client socket destroyed
while the handshake is in flight tears down nothing and the callback then writes and pipes into a
destroyed socket; on an idle stream no byte flows to raise the error that would clean it up.
Reported to the coordinator for that layer, with the same evidence recorded in the S06 receipt.

**Gates.** `collaboration-routes`, `collaboration-terminal-scope` (real Postgres),
`collaboration-terminal-authorization` and `collaboration-terminal-control` → **50/50 across 4
files**; `bun run typecheck` exit 0; `bun run check:patterns` 0 violations, 5 pre-existing
warnings. No React file changed.
