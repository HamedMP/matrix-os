# Cross-harness Routine CLI Implementation Plan

> For agentic workers: use Trellis implement/check sub-agents with the subagent-driven-development review discipline.

Goal: implement all approved five-harness entry paths with a remembered default target and current independent action authorization.
Architecture: existing citty CLI -> trusted current source -> shared remembered-target resolver -> canonical Bot routines. A's approval/scheduler/cancellation remain canonical.
Tech stack: TypeScript strict, Node24+, Zod4, Hono, Kysely/Postgres, Vitest, pnpm10.33.4.
Spec: specs/650-cross-harness-routine-cli/spec.md

## Global constraints

No real credentials/grants/jobs, GUI, deployment, merge or new MCP. Work only in this existing independent worktree. Tests precede production changes. Preserve all A semantics; source identity never comes from a model.

## Review focus

- A remembered target must not restore missing control rights or expired source identity.
- Target deletion/shared conversion/binding replacement races must not silently route to another Chat.
- Changing default must not retarget a queued request or invalidate receipt idempotency.
- Old native subprocesses must not inherit a newer source turn's scope.
- Cancellation acceptance must never imply known stopped effects.

### Task 1: Source/action policy and remembered route foundation

Files: new packages/contracts/src/bots/routine-cli.ts; new packages/gateway/src/bots/routine-cli-targets.ts; new packages/gateway/src/bots/repositories/routine-cli-preferences.ts; small database.ts/database-migrations.ts composition; tests/gateway/bots/routine-cli-targets.test.ts and routine-cli-preferences.test.ts.
Interfaces: createRoutineCliTargetService(deps) with remember/reset/getDefault/resolve; injected current source and live target reader; explicit action scope. Preference app-state row keyed owner+Computer, optimistic revision, no bearer/scopes. Typed safe errors.
- [x] Write target/default cross-harness, removed/shared/archived/foreign/ambiguous target, missing scope/closed source/no fallback and stale preference revision failing tests; observe failures.
- [x] Implement minimal contracts, current resolver and durable preference operations; observe Green.
- [x] Run strict targeted checks; independent Trellis review; commit this bounded foundation.

### Task 2: Source request/receipt and canonical service adapter

- [x] Internal source-generation and per-invocation capability foundation: reviewed with 129 scoped tests and 10 native PostgreSQL cases. Lifecycle/exact-action callbacks remain fail-closed integration boundaries.
- [x] Durable ledger/safe views and actual outer transaction rollback reviewed with167 scoped and17 native PostgreSQL cases. The atomic admission port is still a fixture/integration seam; real canonical adapters and process restart remain pending.
- [x] Shared canonical control and post-commit cancellation adapter reviewed with118 scoped and24 native PostgreSQL cases; actual control caller rollback and delayed-control revision fencing qualified with explicit external runtime fixtures.
- [x] Real canonical proposal/task claim/private admission/approval/recovery adapter reviewed with287 scoped and78 native PostgreSQL cases (including2 compiled-process fixtures). Claim metadata is immutable and required dependencies checked at construction. Host/source/model callbacks remain fixtures; no harness/live qualification.

Files: new routine-cli-source.ts/request-service/repository/routes; small startup/bots route registration; corresponding tests.
Consumes Task1 source/target/action types. Produces internal source-capability operations, durable owner+Computer request receipts and real canonical target-admission correlation. Actual HTTP/startup and trusted source producers remain Tasks3/4/5/6/7; existing-target Bot-binding reuse remains Task5.
- [x] Fail duplicate/lost-response/restart/changed input/stale revision and source revocation/dispatch race cases first.
- [x] Wire actual internal canonical target service hooks, never fabricated runtime/task; preserve A source/model and approval constraints.
- [x] Add safe DTO/cancellation unknown tests, Green and independent review. No source mock pass described as live.

### Task 3: CLI command tree and actual process execution

Files: sync-client/src/cli/commands/routines.ts, routine-client.ts, index/redirect/completion; tests/cli/routines*.test.ts.
Consumes approved request wire schema and v1 output; produces fixed actual CLI verb mapping, strict bounded stdin/JSON/exit and no-retry reconciliation.
- [x] Add failing CLI parsing/identity rejection/process transport tests first.
- [x] Implement existing citty commands, actual published-bin IPC/fixed invoker, exact source-only Hono auth consumer and packed lazy execution with explicitly cached public dependency links.
- [x] Independent Task3 review and fresh parent verification:222 scoped unit/process/auth regressions and7 native transport/packaged cases, strict types/publish/syntax/whitespace. Strict UTF8 and early Node20 API compatibility regressions fixed; no actual Node20/native producer/startup/live qualification.

### Task 4: Owner default selection/review UI

Files: shared packages/ui Bot/private Chat chooser/default control and existing shell integrations; relevant presentation tests.
Consumes authenticated owner route and current target/permission DTOs. Initial owner choice can persist; valid defaults do not prompt again. Display target and permit explicit switch in same interaction; existing generated proposals require replacement+fresh approval.
Task4a owns default routing UI. Task4b owns the approved exact one-operation action controller, owner proof/submit path and shared Chat/Terminal approval UI (routine-action-policy-design.md). No blanket implementation approval is pending. Terminal uses real session/incarnation/launch and no synthetic Chat/run; Chat preserves/verifies actionDigest end-to-end. Full-access-only is an intermediate state. Native Bash/read-only restrictions, plan/review/shared/org/unsupported ceilings and all actual-account/deploy permission limits remain unchanged.
- [x] Task4a: failure-first owner HTTP/real target CAS+recovery, shared web/native current-Chat destination, stale async/auth scope and no-grant tests.
- [x] Task4a independent review and fresh parent checks: 198 Vitest, 48 Native Mobile Jest, 9 native PostgreSQL; scoped types pass. Full Native Mobile types remain blocked at 59 baseline/current diagnostics with zero added/removed.
- [x] Task4b: failure-first exact action controller, trusted current-source policy, Platform-only owner proof and bounded canonical/Terminal decision ports; independent review fixed stale authority callbacks and portable Native token/fetch/read cancellation.
- [x] Shared Web Canvas/Web Desktop/Electron and applicable Native Mobile cards/inbox/browser confirmation wired; parent frozen-diff 453 unit/component, 110 PostgreSQL, 46 Native Mobile tests and seven scoped type lanes pass. Actual native/Terminal source producers and live acceptance remain Tasks5–7; full Native types and broad baseline lint/scanner/root-suite blockers remain explicit.

### Task 5: Claude/Codex/Hermes ordinary Chat and offered delegated Claude

Own existing adapter lifecycle seams; per-turn source capability; actual CLI child/tool invocation. Hermes child channel and Codex native resumed-turn evidence gates must be primary-source verified.
- [x] Task5a ordinary Claude and offered delegated Claude: actual admitted source → published CLI/private IPC → HTTP/PG/canonical path; real existing-binding reuse and immutable target ceiling. Independent review closed pre-close authority and cross-entrypoint lock-order defects; 128 PostgreSQL/221 related tests before fixes, then 59 affected PostgreSQL/83 affected unit tests and strict scoped types pass after original-fault restoration. Native/model/auth fixtures and separate pinned Linux ARM64 protocol observations do not establish a combined live run.
- [x] Task5b Codex ordinary Chat source and named native turn/resume fixtures: actual admitted registry/workspace/manager, retained anonymous service-wrapper/shim bridge, dynamic callback to the same CLI/HTTP/PG; exact per-turn/queued authority and unknown-ACK no-retry. Independent review closed receiver EOF, overflow recursion, late shutdown handshake and missing renewal/resume cases; scoped second review closed host revocation under overflow. Final 16 real PostgreSQL cases and 6 affected tests pass, earlier wider lanes and fault restoration retained. Actual systemd/native/account qualification remains explicitly open; required real-manager lane fails missing prerequisites.
- [x] Task5c Hermes ordinary Chat: actual admitted adapter/held-FD native fixture → published CLI/HTTP/PostgreSQL source path,115 scoped tests/17 PostgreSQL cases and strict types pass. Actual pinned public core API/genuine CLI selection and9 callbacks pass; an observed native result-contract defect drove bounded JSON-text serialization and4 covering tests. Refined fault injection verifies native middleware skip/independent handler denial. Scoped fix review is clean. Full TUI/native worker/installed dependencies/provider/account/combined acceptance remain open.
- [x] Add failure-first source isolation/revocation/actual CLI process tests.
- [x] Implement scoped hooks without broad shell authority; review/commit.

### Task 6: OpenCode, native Pi and managed Pi

- [x] Task6aH OpenCode host/source/fixed CLI preparation: actual canonical admission, held descriptor and observed-call correlation to CLI/Hono/PostgreSQL. Initial25PG/53unit/47shared-regression checks and gateway types pass; review then fixed terminal-call authority and FD/SSE ordering. Final15 affected units,34 required PG,5 selected legacy contracts, scoped types/lint pass; scoped rereview is clean. Native bootstrap deliberately remains unavailable.
- [ ] DEFERRED BY OWNER (2026-11-01): Task6aN native OpenCode exclusive discovery/offline dependency readiness and stable public callID adaptation. Do not implement this native API change in the current scope; host preparation remains and native bootstrap stays unavailable. Continue the other entries.
- [x] Task6b native Pi1.0.0: actual admitted source/held FD/current native-call correlation to shared CLI/Hono/PG;33 PG,64 affected units,18 resource/FD and39 shared regressions pass with strict scoped types. Independent review fixed pre-lease staging failure/orphan cleanup with4 focused cases; scoped rereview clean. Four separate actual native production-extension/API/FD/result/cancel/discovery probes pass with a fixed local model fixture. Combined native-to-Matrix, real account, systemd/platform/build/full gates remain open;0.99.2 routine support is unqualified.
- [x] Task6c managed Matrix Pi uses its actual canonical run/registry binding and pinned AgentTool consumer through the typed Unix broker/shared CLI, with no invented BotTask. Initial24 PG/64+65 affected regressions pass; review-driven live framing/cancellation repair passes8 selected PG/29 transport-schema/legacy-stream cases and scoped types. Independent scoped rereview is clean. Actual supervisor/compiled worker/profile/account/package/systemd/full gates remain open.

Own native owned-tool extensions and typed worker-host fixed CLI invocation; keep native read-only/pure policy.
- [ ] Fail explicit executable/argv/env/cwd/scope misuse and actual CLI invocation cases first.
- [ ] Verify supported APIs, implement narrow path, test/review/commit. Unknown hook is not accepted support.

### Task 7: Five-harness Matrix Terminal entry

Own server-managed launch/session/incarnation, safe nonserialized capability channel and actual Hermes launcher/readiness additions; no agent hint as authentication.
- [ ] Fail five launch cases, secret argv/startup/history exposure, restore/reincarnation and revoked-source use.
- [ ] Implement existing-launch integration, test/review/commit.
- [x] Task7a: OS per-writer proof, PTY/broker and CLI client foundation reviewed;53 targeted tests/types/lint pass and actual Linux component probes pass. Two minor cap/cleanup and client coverage findings are mandatory first work in7b. Production Terminal source remains unavailable; component evidence is distinct from authority/systemd/package qualification.
- [ ] Task7b: retained hosted launch/private protocol, I/O attach/resize and immutable full runtime closure with backward-compatible generation/GC.
- [ ] Task7c: authenticated canonical Terminal admission, five real launchers/readiness and actual source/CLI/backend authority integration.

### Task 8: Integration evidence, Draft publication and docs

- [ ] Reuse native PostgreSQL/process helpers for source/target/receipt concurrency and restart. Run relevant strict types/patterns/packaged runners.
- [ ] Create/attach separate Drafts with exact dependency SHAs and invariants. Do not merge/APPROVE/deploy.
- [ ] Record five Chat x five Terminal positive matrix, native/managed Pi and offered delegated Claude separately; missing live permissions/GUI/account evidence stays pending.
- [ ] Short execution help/docs; private site docs Draft after scope check, no duplicate Nima discovery/skills. C is synchronized by coordinator, not unsolicited messages.
