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

Files: new routine-cli-source.ts/request-service/repository/routes; small startup/bots route registration; corresponding tests.
Consumes Task1 source/target/action types. Produces authenticated source operations, durable owner+Computer request receipt and real target-admission correlation.
- [ ] Fail duplicate/lost-response/restart/changed input/stale revision and source revocation/dispatch race cases first.
- [ ] Wire actual canonical target service hooks, never fabricated runtime/task; preserve A source/model and approval constraints.
- [ ] Add safe DTO/cancellation unknown tests, Green/review/commit. No source mock pass described as live.

### Task 3: CLI command tree and actual process execution

Files: sync-client/src/cli/commands/routines.ts, routine-client.ts, index/redirect/completion; tests/cli/routines*.test.ts.
Consumes approved request wire schema and v1 output; produces fixed actual CLI verb mapping, strict bounded stdin/JSON/exit and no-retry reconciliation.
- [ ] Add failing CLI parsing/identity rejection/process transport tests first.
- [ ] Implement commands and packaging; Green/review/commit.

### Task 4: Owner default selection/review UI

Files: shared packages/ui Bot/private Chat chooser/default control and existing shell integrations; relevant presentation tests.
Consumes authenticated owner route and current target/permission DTOs. Initial owner choice can persist; valid defaults do not prompt again. Display target and permit explicit switch in same interaction; existing generated proposals require replacement+fresh approval.
- [ ] Fail persistence across harness switch, no repeated picker, invalid default blocked, separate action approval tests first.
- [ ] Wire common Web Canvas/Web Desktop/Electron behavior and applicable mobile review boundary; scoped tests/review/commit. Do not occupy A's GUI.

### Task 5: Claude/Codex/Hermes ordinary Chat and offered delegated Claude

Own existing adapter lifecycle seams; per-turn source capability; actual CLI child/tool invocation. Hermes child channel and Codex native resumed-turn evidence gates must be primary-source verified.
- [ ] Add failure-first source isolation/revocation/actual CLI process tests.
- [ ] Implement scoped hooks without broad shell authority; review/commit.

### Task 6: OpenCode, native Pi and managed Pi

Own native owned-tool extensions and typed worker-host fixed CLI invocation; keep native read-only/pure policy.
- [ ] Fail explicit executable/argv/env/cwd/scope misuse and actual CLI invocation cases first.
- [ ] Verify supported APIs, implement narrow path, test/review/commit. Unknown hook is not accepted support.

### Task 7: Five-harness Matrix Terminal entry

Own server-managed launch/session/incarnation, safe nonserialized capability channel and actual Hermes launcher/readiness additions; no agent hint as authentication.
- [ ] Fail five launch cases, secret argv/startup/history exposure, restore/reincarnation and revoked-source use.
- [ ] Implement existing-launch integration, test/review/commit.

### Task 8: Integration evidence, Draft publication and docs

- [ ] Reuse native PostgreSQL/process helpers for source/target/receipt concurrency and restart. Run relevant strict types/patterns/packaged runners.
- [ ] Create/attach separate Drafts with exact dependency SHAs and invariants. Do not merge/APPROVE/deploy.
- [ ] Record five Chat x five Terminal positive matrix, native/managed Pi and offered delegated Claude separately; missing live permissions/GUI/account evidence stays pending.
- [ ] Short execution help/docs; private site docs Draft after scope check, no duplicate Nima discovery/skills. C is synchronized by coordinator, not unsolicited messages.
