# Cross-harness routine CLI: C acceptance handoff

This is an exact-source review handoff, not end-to-end approval. Creation is a proposal pending human approval; scheduled execution remains canonical Matrix Bot work. No system crontab, manage_cron, cron.json writes, replacement scheduler or new documentation MCP service is introduced. Nima retains capability-discovery/skill ownership.

## Frozen implementation dependencies

- ENG-93 chain: #3017 `cfdb3feeecc4a4afe6ea4924e892b165aebd46a4` → #3018 `884a7531fec374d416a6eca339a728482b60e62f` → #3019 `ea76546f23349d1869a7554d812825999b778e47` → #3041 `e43ca79412df8562b9e12fb3a5fac3134c522170`.
- Included newer backend: [#3054](https://github.com/HamedMP/matrix-os/pull/3054), `8637d40db013fe6d9bf4992780381742c11382bc`.
- B published prefix: [#3072](https://github.com/HamedMP/matrix-os/pull/3072), `cda1dd49e8ea4977b213ddff838ba1b677bb93c8`.
- [#3075](https://github.com/HamedMP/matrix-os/pull/3075), `06ebed0f779387a041d674ee83f9a4e9e78ca567`: exact 49-file canonical-admission composition.
- [#3076](https://github.com/HamedMP/matrix-os/pull/3076), `41d45777e4c0686a1eca7396d3ea7ae687f96f35`: receipt-link compatibility. Native stack #3077 contains these layers and the validation continuation.
- Separate UI: [#3073](https://github.com/HamedMP/matrix-os/pull/3073), last checked `69ff9654c0dd8fe8ffd6a294691b03444f238d6c`; not included or live-qualified by this code stack.
- Separate docs: [matrix-os-site #319](https://github.com/FinnaAI/matrix-os-site/pull/319), `7f9e3aae5241db507a46548a539c6c6c53f00d10`.

The validation continuation is test-only plus this handoff; use its PR head as the final checkout identity rather than inventing a commit from a local folder name. Match Gateway, CLI, native peer and UI versions before live acceptance. See [interfaces.md](./interfaces.md) for the contract.

## Evidence lanes

| Lane | Actual evidence | Limit |
| --- | --- | --- |
| Clean core `06ebed0` | Canonical typecheck/patterns pass; 220 authority cases, 83 CLI/PostgreSQL cases; compiled separate-process PostgreSQL lane 4/4, zero skips | Source/model/host/provider fixtures are synthetic; no native account claim |
| Clean receipt `41d4577` | Canonical typecheck/patterns pass; 62 CLI cases and 3 pooled-Postgres owner-edit cases, zero skips | Matching strict v1 readers required |
| Fixture repairs | Independent scoped reviews; 78 original platform/Terminal cases, 19 Shell cases, 24 migration cases, 16 tool/close/artwork cases | Migration lane is 10 pooled-Postgres plus 14 PGlite component cases; exact continuation checkout is revalidated separately |
| Public Codex artifact | Actual 0.162.1 full package: two policies × original shim, relocated shim and direct Rust; six version/config-read cases; raw protocol results equal | x64 emulation on ARM64, current_exe unobserved, no thread/turn/account/model call; auxiliary resources not functionally exercised |
| Private Zellij source | Component IPC suite 80/0/0, including framing, kernel peer observation, environment gate and lifecycle; named guard faults detected | Actual private client/listener/router/PTY/static-helper path, shipped x64/systemd and native-source authority are not qualified |
| Site | 530 tests, actual page HTTP200, 375/768/1440px without document overflow | Dev preview, external browser requests blocked; not auth/runtime acceptance |

The earlier full composed working-tree root run failed: 38 suites, 112 tests, 137 skipped, one source-map reporter error. Some B-owned stale fixture expectations are repaired here; several unrelated/environment failure groups and reporter origin remain unresolved. Targeted passes do not establish full CI. Product jobs skipped for Draft PRs are not product-test passes.

## Required live acceptance

Use an owner-selected existing test Computer and authorized account. No live target has been inferred from login/catalog/profile state. The test bundle must include the exact compatible implementation/UI/native source set; no customer environment, channel promotion or production permission change is authorized by this handoff.

1. Start an actual supported Claude managed source. Verify its real native process/run binding through the trusted runtime producer. A public ID, agentHint, first connector or claimed PID is insufficient. Missing legal binding is a failed prerequisite requiring the minimal adapter design; never inject a fixture context to obtain a pass.
2. Select an eligible owner-private recipe Bot Chat through the existing Routine destination UI. Invoke the real published CLI entry; ordinary Claude uses the literal quoted MATRIX_ROUTINE_JSON heredoc in the usage documentation. Preserve the original mutation UUID.
3. Observe a proposal awaiting human approval. Human routine approval, native/background-model consent and integration authorization are separate gates; the CLI must not enable broad background consent. A browser opened or model listed is not approval/provider acceptance.
4. After the owner approves the exact definition/digest, observe the canonical Matrix Bot scheduled occurrence, durable claim/run, actual native return and bounded permitted effect. Record source/model grant and integration state separately. No independent per-harness scheduler.
5. Cover repeated UUID with the same payload, changed payload under the same UUID, stale revision, missing consent/permissions and cross-user/Chat/Bot attempts. Controls use the freshly observed revision. Archive retains history.
6. Pause/archive an actual active run and reconcile cancellation. Request acknowledgement is not proof that a worker or external effect stopped. Lost acknowledgement/crash/unknown outcomes retain original UUID/target and never trigger implicit replay or HTTP fallback.
7. After owner edit replaces the approval link, original receipt can show routine:null plus routineLink:unavailable. This is unknown association, not deletion/archive/stop evidence. Exit0, not_observed or approved alone does not prove activation or stopped execution; only top-level data.kind:unknown exits75.
8. Bridge/source failure requires explicit recovery/relaunch without restoring old authority. Ordinary I/O and unknown reservations remain truthful. OpenCode native Chat adaptation remains deferred; unsupported ordinary Terminal sources cannot count as harness passes.

Record exact code/bundle commits, actual native executable/producer identity, account source, owner approvals, invoked command/UUID/revision, native return and cleanup. Never record credentials in public artifacts. Real Zellij/systemd/shipped-target acceptance, five ordinary TUI native-event/root gates and final whole-branch review remain open.
