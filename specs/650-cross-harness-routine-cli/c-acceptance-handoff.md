# Cross-harness routine CLI: C acceptance handoff

This is an exact-source review handoff, not end-to-end approval. Creation is a proposal pending human approval; scheduled execution remains canonical Matrix Bot work. No system crontab, manage_cron, cron.json writes, replacement scheduler or new documentation MCP service is introduced. Nima retains capability-discovery/skill ownership.

## Historical implementation dependencies

These pins identify the original pre-rebase candidate. The later replay uses the merged ENG-93 backend from main. Use the current PR heads and current-head evidence for a new review.

- ENG-93 chain: #3017 `cfdb3feeecc4a4afe6ea4924e892b165aebd46a4` → #3018 `884a7531fec374d416a6eca339a728482b60e62f` → #3019 `ea76546f23349d1869a7554d812825999b778e47` → #3041 `e43ca79412df8562b9e12fb3a5fac3134c522170`.
- Included newer backend: [#3054](https://github.com/HamedMP/matrix-os/pull/3054), `8637d40db013fe6d9bf4992780381742c11382bc`.
- B published prefix: [#3072](https://github.com/HamedMP/matrix-os/pull/3072), `cda1dd49e8ea4977b213ddff838ba1b677bb93c8`.
- [#3075](https://github.com/HamedMP/matrix-os/pull/3075), `06ebed0f779387a041d674ee83f9a4e9e78ca567`: exact 49-file canonical-admission composition.
- [#3076](https://github.com/HamedMP/matrix-os/pull/3076), `41d45777e4c0686a1eca7396d3ea7ae687f96f35`: receipt-link compatibility. Native stack #3077 contains these layers and the validation continuation.
- Included native transport: [#3085](https://github.com/HamedMP/matrix-os/pull/3085), `cfa7baf0ed6b426651f84195f9962ee860c07449`, over #3083 `f8f577fbeb740c9c955246f598dfce2c8e4f58aa`. It still grants no source authority.
- Included A UI/navigation through #3082: `66690c39ac5b356acb4bbfd901a3fffef32bcd81`, including #3073. Local UI composition `95f14a6f17bda565a4630a7083bfbaab77975d7e` preserves B destination/AbortSignal behavior; its continuation `8c694abfad3e4f03f28899d62f69103bac64e8a5` adds only the current native test/documentation parent.
- Included reliability: [#3084](https://github.com/HamedMP/matrix-os/pull/3084), `02eaa0fcac9db3137fbea3846f13626ff785279d`. B composition `afc636c6201fb2e8be266b34469d152576552eb9` also forwards the clock into the shared CLI control repository. Test-prerequisite continuation `46673d49a66f76aa07480018d0f3d7a47affca4c` pins the schema validator and preserves activated-tool/real-backend fixture wiring; use the final PR head for checkout identity.
- Separate docs: [matrix-os-site #319](https://github.com/FinnaAI/matrix-os-site/pull/319), `7f9e3aae5241db507a46548a539c6c6c53f00d10`.

The historical review layers compose backend, CLI and UI behavior. Match the current Gateway, CLI, native peer and UI before live acceptance. Keep current-head tests and actual harness/account evidence separate. See [interfaces.md](./interfaces.md) for the contract.

## Evidence lanes

| Lane | Actual evidence | Limit |
| --- | --- | --- |
| Clean core `06ebed0` | Canonical typecheck/patterns pass; 220 authority cases, 83 CLI/PostgreSQL cases; compiled separate-process PostgreSQL lane 4/4, zero skips | Source/model/host/provider fixtures are synthetic; no native account claim |
| Clean receipt `41d4577` | Canonical typecheck/patterns pass; 62 CLI cases and 3 pooled-Postgres owner-edit cases, zero skips | Matching strict v1 readers required |
| A UI composition | 93 related UI/desktop component cases and explicit TypeScript5 check pass | Shared sources only; no new live surface or account pass |
| A reliability composition | Clock regression first fails twice through actual row-lock contention, then focused4 pass; related534 and CLI/PG281 pass, zero skips; compiled-process PostgreSQL4 pass at `afc636c` | Source/account/model/systemd are named fixtures; final checkout needs its own build identity and checks |
| Original inherited-control composition | Linux ARM64 Node24:12 inherited +11 handoff +20 control +34 stdout cases; creator-death guard fault and test-cleanup Red/Green; repository types, patterns and22 related cases pass | Kernel transport only; protected image, product keeper and actual harness/account joins remain open |
| Fixture repairs | Independent scoped reviews; 78 original platform/Terminal cases, 19 Shell cases, 24 migration cases, 16 tool/close/artwork cases | Migration lane is 10 pooled-Postgres plus 14 PGlite component cases; exact continuation checkout is revalidated separately |
| Public Codex artifact | Actual 0.162.1 full package: two policies × original shim, relocated shim and direct Rust; six version/config-read cases; raw protocol results equal | x64 emulation on ARM64, current_exe unobserved, no thread/turn/account/model call; auxiliary resources not functionally exercised |
| Private Zellij source | Component IPC suite 80/0/0, including framing, kernel peer observation, environment gate and lifecycle; named guard faults detected | Actual private client/listener/router/PTY/static-helper path, shipped x64/systemd and native-source authority are not qualified |
| Site | 530 tests, actual page HTTP200, 375/768/1440px without document overflow | Dev preview, external browser requests blocked; not auth/runtime acceptance |

The earlier full composed working-tree root run failed: 38 suites, 112 tests, 137 skipped, one source-map reporter error. Some B-owned stale fixture expectations are repaired here; several unrelated/environment failure groups and reporter origin remain unresolved. Targeted passes do not establish full CI. Product jobs skipped for Draft PRs are not product-test passes.

The first wider reliability run exhausted its disposable PostgreSQL WAL storage and failed; those results remain failures. A fresh bounded fixture with checkpoints passed the compiled4 lane. A later healthy run exposed17 additional failures: an undeclared Ajv resolved an incompatible major, the packing helper assumed adjacent Corepack, and one delegated-exit fixture omitted the backend now required by pure preflight. Explicit Ajv6.14, activated pnpm10.33.4 and the real execution dependency fixed those prerequisites; all281 original integration assertions then passed. No protocol, permission check or assertion was weakened.

## Required live acceptance

Use an owner-selected existing test Computer and authorized account. No live target has been inferred from login/catalog/profile state. The test bundle must include the exact compatible implementation/UI/native source set; no customer environment, channel promotion or production permission change is authorized by this handoff.

1. Start an actual supported Claude managed source. Verify its real native process/run binding through the trusted runtime producer. A public ID, agentHint, first connector or claimed PID is insufficient. Missing legal binding is a failed prerequisite requiring the minimal adapter design; never inject a fixture context to obtain a pass.
2. Select an eligible owner-private recipe Bot Chat through the existing Routine destination UI. Invoke the real published CLI entry; ordinary Claude uses the literal quoted MATRIX_ROUTINE_JSON heredoc in the usage documentation. Preserve the original mutation UUID.
3. Observe a proposal awaiting human approval. Human routine approval, native/background-model consent and integration authorization are separate gates; the CLI must not enable broad background consent. A browser opened or model listed is not approval/provider acceptance.
4. After the owner approves the exact definition/digest, observe the canonical Matrix Bot scheduled occurrence, durable claim/run, actual native return and bounded permitted effect. Record source/model grant and integration state separately. No independent per-harness scheduler.
5. Cover repeated UUID with the same payload, changed payload under the same UUID, stale revision, missing consent/permissions and cross-user/Chat/Bot attempts. Controls use the freshly observed revision. Recurring resume selects a future slot without paused backlog; an elapsed one-time task stays paused until a future-time edit receives exact owner approval. Archive retains history.
6. Pause/archive an actual active run and reconcile cancellation. Request acknowledgement is not proof that a worker or external effect stopped. Lost acknowledgement/crash/unknown outcomes retain original UUID/target and never trigger implicit replay or HTTP fallback.
7. After owner edit replaces the approval link, original receipt can show routine:null plus routineLink:unavailable. This is unknown association, not deletion/archive/stop evidence. Exit 0, `not_observed`, or `approved` alone does not prove activation or stopped execution. Both top-level `data.kind: unknown` and a receipt with `receipt.disposition: unknown` exit 75 and require reconciliation.
8. Bridge/source failure requires explicit recovery/relaunch without restoring old authority. Ordinary I/O and unknown reservations remain truthful. OpenCode native Chat adaptation remains deferred; unsupported ordinary Terminal sources cannot count as harness passes.

Record exact code/bundle commits, actual native executable/producer identity, account source, owner approvals, invoked command/UUID/revision, native return and cleanup. Never record credentials in public artifacts. Real Zellij/systemd/shipped-target acceptance, five ordinary TUI native-event/root gates and final whole-branch review remain open.
