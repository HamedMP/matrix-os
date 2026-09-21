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
- The scope-runtime worker does not yet run a PTY, so `terminal` workloads are advertised by the policy but not by the launcher's adapters: readiness reports sandbox terminals as unsupported (honest) until the worker gains the adapter.
- Hardlink check is bounded to the worktree's top-level files; deeper hardlinks are a residual risk recorded here, mitigated by `ProtectSystem=strict` and `ProtectHome`.
- Coordinator patches: `packages/scope-runtime/package.json` gains the `./sandbox` export; `wiring.ts` constructs `CollaborationRevocationEnforcer` and passes `onEnded` to `DirectSessionService`; the launcher's `sandboxRoots` and S08/S09's `SandboxRuntimeRegistry.bind` calls are wired by the packet that creates sandboxed runs (S09 T047/T048).
