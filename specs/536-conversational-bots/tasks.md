# Tasks: Conversational Recipe Bots

**Input**: Design documents from `specs/536-conversational-bots/` ([plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md), [spike-plan.md](spike-plan.md)).

**Organization**: One phase per delivery-stack layer (L0-L18 in [plan.md](plan.md#delivery-stack-github-native-stacked-prs)). Each layer is one independently reviewable PR in a GitHub native stack. Layers L1-L7 are foundational and carry no story label. From L8 onward, tasks carry the user story they serve:

- [US1] Meet and build a bot through chat
- [US2] Connect services gradually
- [US3] Work with bots in a group
- [US4] Finish work on a persistent computer
- [US5] Grow a bot over time

**Tests**: TDD is mandatory (constitution IX). Every layer lists failing tests first, then implementation. A test task is done when the test exists and fails for the right reason; the matching implementation task makes it pass.

## Format

`- [ ] T### [P?] [US?] Description with exact file path`. [P] means the task can run in parallel with other [P] tasks in the same phase, because it touches different files and depends on nothing incomplete.

## Per-layer PR procedure (applies to every checkpoint task)

1. Work in the layer's manual worktree, created from the parent layer's branch, with `gh stack add <branch>`. Never use Agent-tool `isolation: "worktree"`.
2. Run `bun run typecheck`, `bun run check:patterns`, and the layer's focused suites listed in [quickstart.md](quickstart.md). Run `npx react-doctor@latest <project-dir>` for changed React projects, and `bun run build:shell:production` if `shell/` changed.
3. Keep the layer under 3,000 additions and 50 files.
4. `gh stack submit` with a Conventional Commit title. The PR body carries the Invariants section and, for user-visible layers, the surface matrix and screenshots under `docs/pr-evidence/536/<layer>/`.
5. Drive the PR with `/worktree-pr-monitor` until Greptile reports 5/5 on the current head and CI is green.
6. Merge bottom-up only when the layer's base is `main` and its milestone gate has passed. Never delete branches while upper layers are open.

---

## Phase 1: Setup — L0 (PR #1940: spec, plan, tasks)

- [ ] T001 Commit `specs/536-conversational-bots/tasks.md` and push `codex/535-conversational-bots`; update the PR #1940 body with the plan and stack summary
- [ ] T002 Initialize the GitHub stack from `/home/deploy/matrix-os-535-bots` with `gh stack init --base main codex/535-conversational-bots`, adopting the existing branch as the bottom layer; record `gh stack view --json` output in the PR #1940 body
- [ ] T003 Request `@greptileai please review` for PR #1940's current head and resolve findings in `specs/536-conversational-bots/*` until 5/5 (L0 merge gate: docs only)
- [ ] T004 [P] File follow-up issues for pre-existing problems in research R16 (tool-pack Codex/Pi drift in `distro/customer-vps/host-bin/matrix-install-tool-pack`, the cron cache reload in `packages/gateway/src/cron/store.ts`, and the mcp-browser DNS rebinding gap in `packages/mcp-browser/src/security.ts`) using `gh issue create`, with technical descriptions only

---

## Phase 2: Foundational — L1 Contracts (`feat(contracts): add conversational bot schemas`)

**Purpose**: Shared schemas that every later layer depends on. **Gate**: S0 (contracts only; safe to merge after review).

- [ ] T010 [P] Write failing tests in `tests/contracts/bots/bot-schemas.test.ts` for the bot ID regex, instantiate request/response, authority view, interaction payload and resolve unions (question, account_choice, connect_request, approval), grant, memory item, and task status. Cover byte bounds and unknown-key rejection, per `contracts/bots-http-api.md` and `data-model.md`
- [ ] T011 [P] Write failing tests in `tests/contracts/bots/broker-bot-protocol.test.ts` for the `bot.tool` capability union, `bot.event`, `bot.session.save`, and the allowlisted error codes. The `inference.chat_completions` body belongs to the scope-runtime broker protocol in L7, per `contracts/bot-broker-protocol.md`
- [ ] T012 [P] Write failing tests in `tests/contracts/canonical-chat-bot-additions.test.ts` for `CanonicalChatExecutionRootRefSchema` accepting `{kind:"bot_workspace", botId}`, `CanonicalProviderDriverKindSchema` accepting `matrix_bot`, `isChatAgentDriver("matrix_bot")`, and every new event type in `contracts/chat-events.md`
- [ ] T013 [P] Extend `tests/contracts/funded-ai.test.ts`: the issue request `{requestClass}`, empty `{}` mapping to `interactive`, `requestClass` echoed in the issue response, and the allowlisted `SafeError.reason` values (`slot_busy`, `priority_hold`, `priority_queue`, `priority_full`)
- [ ] T014 [P] Implement ID and bot schemas in `packages/contracts/src/bots/ids.ts` and `packages/contracts/src/bots/bot.ts`
- [ ] T015 [P] Implement interaction schemas in `packages/contracts/src/bots/interactions.ts`, reusing `UserInputQuestionListSchema` from `packages/contracts/src/agent-thread-contracts.ts`
- [ ] T016 [P] Implement grant, memory, task, and authority schemas in `packages/contracts/src/bots/grants.ts`, `memory.ts`, `tasks.ts`, and `authority.ts`
- [ ] T017 [P] Implement broker bot protocol schemas in `packages/contracts/src/bots/broker.ts`
- [ ] T018 Add `bot_workspace` to `CanonicalChatExecutionRootRefSchema` and `matrix_bot` to `CanonicalProviderDriverKindSchema` in `packages/contracts/src/canonical-chat-primitives.ts`; update `isChatAgentDriver` in `packages/contracts/src/chat-agent-context.ts`
- [ ] T019 Add the new event types to the closed enum in `packages/contracts/src/canonical-chat-api.ts`, and add event wire versioning (`ChatEventWireVersionSchema`, `projectChatEventTypeForWire`) in `packages/contracts/src/chat-event-wire.ts` so clients on version 0 receive `chat.updated`
- [ ] T020 Add the issue request schema, `requestClass`, and `SafeError.reason` to `packages/contracts/src/funded-ai.ts`
- [ ] T021 Export the bots module from `packages/contracts/src/index.ts`, add a `"./bots"` export in `packages/contracts/package.json`, and add the vitest alias `@matrix-os/contracts/bots` in `vitest.config.ts`
- [ ] T022 Make every existing consumer handle the new union members explicitly. `bot_workspace` fails closed with `unsupported_root`, and `matrix_bot` is not executable yet. Files: `packages/contracts/src/canonical-chat-surface.ts`, `packages/gateway/src/chat/turn-admission.ts`, `packages/gateway/src/chat/queue-admission.ts`, `packages/gateway/src/chat/orchestrator.ts`, `packages/gateway/src/chat/orchestration-input.ts`, `packages/gateway/src/collaboration/run-account-binding.ts`, `packages/gateway/src/collaboration/project-chat-root-inventory.ts`, `packages/gateway/src/startup/collaboration.ts`, `packages/ui/src/collaboration/ProjectSourceSummary.tsx`, `packages/gateway/src/chat/provider-catalog.ts`. Add regression tests in `tests/gateway/chat-execution-root-kinds.test.ts`
- [ ] T023 L1 checkpoint: per-layer PR procedure; branch `536-l1-contracts`

---

## Phase 3: Foundational — L2 Platform funded priority (`feat(platform): enforce interactive funded priority`)

**Purpose**: Owner-wide priority at the reservation point (research R10, `contracts/funded-priority.md`). **Gate**: Spike B funded cases on a platform preview. The platform must deploy before any gateway relies on classes; `{}` remains accepted.

- [ ] T030 [P] Write failing tests in `tests/platform/ai-funded-priority-claims.test.ts`. Interactive request:
  - hits a busy slot → claim plus `slot_busy`
  - claim is never extended
  - the oldest claimant reserves first
  - the claim is consumed on reserve
  - `priority_full` at 16 claims

  Background request:
  - rejected with `priority_hold` while a conflicting claim lives
  - reserves after the claim expires

  Also: a claim survives a rolled-back sibling path (the claim row exists after the 429 is returned); a retry with a new request ID and the same claim key consumes the claim; two turns on one runtime with different claim keys are served oldest first; lease rotation keeps the claim; non-conflicting billing modes are unaffected; and the failure-case 15 race (a bypassing background request and a second runtime of the same owner both try at slot release while a claim waits; both rejected, the interactive request reserves)
- [ ] T031 [P] Extend `tests/platform/ai-funded-policy-routes.test.ts`: the issue body `{requestClass}`, `{}` → interactive, an invalid class → 400 `invalid_request`, per-class cooldown, and `requestClass` in the response
- [ ] T032 [P] Extend `tests/platform/ai-funded-reservation-cleanup-worker.test.ts`: expired claims are deleted in batches of at most 500; live claims are kept
- [ ] T033 Add the `request_class` column and CHECK to `ai_runtime_credentials`, and create `ai_funded_priority_claims` with a PK and an `(owner_id, expires_at)` index, in `packages/platform/src/database/migrations/ai-funded.ts`; bump `PLATFORM_SCHEMA_REVISION` in `packages/platform/src/database/migration-revision.ts` and update `tests/platform/platform-migration-revision.test.ts`
- [ ] T034 Add the Kysely types for the new column and table in `packages/platform/src/db.ts`
- [ ] T035 Accept `{requestClass}` in the issue route (`packages/platform/src/ai-funded-policy-routes.ts`) and thread it into `issueCredential`, with the cooldown keyed per class, in `packages/platform/src/ai-funded-policy-repository.ts`
- [ ] T036 Implement claim evaluation in a new `packages/platform/src/ai-funded-priority-claims.ts`: claims keyed by `(owner_id, machine_id, runtime_slot)` from the stored credential, upsert with `ON CONFLICT` keeping the existing `created_at` and `expires_at`, a conflict-aware hold, an oldest-claimant check, and the cap. Call it from `authorize` in `packages/platform/src/ai-funded-metering-repository.ts`, inside the existing owner advisory lock and transaction, before the active-reservation check. Claim-bearing rejections return a typed outcome so the transaction commits; the route maps it to 429 after commit
- [ ] T037 Delete expired claims in `packages/platform/src/ai-funded-reservation-cleanup.ts`
- [ ] T038 In `packages/proxy/src/funded-relay.ts`, forward the allowlisted reason as the `x-matrix-funded-reason` header on 429 responses, and pass a validated `x-matrix-funded-claim-key` request header through to `authorize` as `claimKey` (never upstream). Test in `tests/proxy/funded-relay.test.ts`: the reason allowlist, a missing reason, a valid key, and an invalid key dropped
- [ ] T039 L2 checkpoint: per-layer PR procedure; branch `536-l2-platform-funded-priority`; the PR body notes that the platform and relay deploy must precede class-aware gateways

---

## Phase 4: Foundational — L3 Gateway funded classes and local queue (`feat(gateway): classify funded requests and queue locally`)

**Gate**: Spike B funded cases.

- [ ] T040 [P] Extend `tests/gateway/funded-ai-credential-manager.test.ts`: one lease per class, independent refresh, and `requestClass` required on `getCredential`
- [ ] T041 [P] Extend `tests/gateway/kernel-credentials.test.ts`: `buildKernelCredentialLaunch` requires and forwards the class
- [ ] T042 [P] Write failing tests in `tests/gateway/funded-admission-queue.test.ts`:
  - interactive first, FIFO within a class
  - cap of 64 waiting requests
  - 2-minute and 10-minute wait bounds ending in `waiting_capacity` → blocked
  - cancellation removes the entry
  - shutdown ends waiters as retryable
  - backoff on `slot_busy`/`priority_queue` (250 ms doubling to 2 s)
  - in-flight requests are never preempted
- [ ] T043 [P] Write failing tests in `tests/gateway/funded-caller-classification.test.ts`, asserting the class passed by each caller in the `contracts/funded-priority.md` table: `dispatcher.ts`, `heartbeat/runner.ts`, `provisioner.ts`, the heal path in `server.ts`, `chat/claude-provider-adapter.ts`, `app-ai/runtime.ts`, `jev/service.ts`, `coding-agents/harness-credentials.ts`, `collaboration/scope-runtime-broker.ts`
- [ ] T044 Replace the single cached lease with a per-class map in `packages/gateway/src/funded-ai-credential-manager.ts` (send the `{requestClass}` body)
- [ ] T045 Thread the class through `packages/gateway/src/kernel-credentials.ts`
- [ ] T046 Implement the bounded owner queue in `packages/gateway/src/funded-ai/admission-queue.ts`, with timers cleared on dequeue and shutdown. It sets `x-matrix-funded-claim-key` to the turn or run ID on each request, and kernel credential launches for interactive runs pass it through `ANTHROPIC_CUSTOM_HEADERS`
- [ ] T047 Classify each caller listed in T043 in its source file: `packages/gateway/src/dispatcher.ts`, `packages/gateway/src/heartbeat/runner.ts`, `packages/gateway/src/provisioner.ts`, `packages/gateway/src/server.ts` (heal), `packages/gateway/src/chat/claude-provider-adapter.ts`, `packages/gateway/src/app-ai/runtime.ts`, `packages/gateway/src/jev/service.ts`, `packages/gateway/src/coding-agents/harness-credentials.ts`, `packages/gateway/src/collaboration/scope-runtime-broker.ts`
- [ ] T048 Construct the queue in `packages/gateway/src/server.ts`, inject it into the canonical adapters and the broker, and drain it on shutdown before the database closes
- [ ] T049 L3 checkpoint: per-layer PR procedure; branch `536-l3-gateway-funded-classes`

---

## Phase 5: Foundational — L4 Bot runtime package (`feat(bot-runtime): add pinned Pi agent loop`)

**Purpose**: The Pi loop that runs inside the sandbox (research R1-R2, R9). **Gate**: S0.

- [ ] T050 Create `packages/bot-runtime/package.json` (private, ESM, exact deps `@earendil-works/pi-agent-core@0.86.1` and `@earendil-works/pi-ai@0.86.1`) and `packages/bot-runtime/tsconfig.json`. Add `pnpm.overrides` for `@earendil-works/chord` and `@earendil-works/pi-telemetry` at `0.86.1` in the root `package.json`. Run `pnpm install` to update `pnpm-lock.yaml`. Add the vitest alias `@matrix-os/bot-runtime` in `vitest.config.ts`
- [ ] T051 [P] Write failing tests in `tests/bot-runtime/agent-loop.test.ts` with a fake `streamFn` provider: prompt → tool call → tool result → completion; sequential execution; images passed as image content
- [ ] T052 [P] Write failing tests in `tests/bot-runtime/before-tool-call.test.ts`: a denied call never reaches `execute`; a hook error becomes a generic denial with no internal text; unknown tools and invalid arguments are denied
- [ ] T053 [P] Write failing tests in `tests/bot-runtime/providers.test.ts`: each pi-ai provider (Anthropic Messages, OpenAI Responses, chat-completions) targets the loopback inference bridge `baseUrl` with a placeholder key, and image-capable models declare `input: ["text", "image"]`
- [ ] T054 [P] Write failing tests in `tests/bot-runtime/session-codec.test.ts`: round-trip of system messages and tool-call/result pairs; the 512 KiB cap triggers compaction through `generateSummaryWithRequest` with a fake request
- [ ] T055 [P] Write failing tests in `tests/bot-runtime/event-projection.test.ts`: `AgentEvent` → `bot.event` with monotonic `seq`, a 64 KiB cap, and dropped `thinking_*` deltas
- [ ] T056 [P] Write failing tests in `tests/bot-runtime/worker-entry.test.ts`: `bot.run`, `bot.steer`, and `bot.cancel` handling; exit statuses `completed`, `waiting_person`, `waiting_capacity`, `blocked`, `failed`, `cancelled`, and `uncertain`
- [ ] T057 [P] Implement the `bot.*` NDJSON frame client for the broker socket (tool, event, and session frames; `AbortSignal.timeout`; allowlisted error mapping) in `packages/bot-runtime/src/broker-client.ts`, with tests in `tests/bot-runtime/broker-client.test.ts` against a fake broker on a temp Unix socket
- [ ] T058 [P] Implement the pi-ai providers for Anthropic Messages, OpenAI Responses, and OpenAI chat-completions (`createProvider` with the loopback bridge `baseUrl`, placeholder key, image-capable models) in `packages/bot-runtime/src/providers.ts`
- [ ] T059 [P] Implement TypeBox tool definitions that forward to `bot.tool` in `packages/bot-runtime/src/tool-proxy.ts`
- [ ] T060 Implement the `Agent` wrapper (sequential tools, fail-closed `beforeToolCall`, steer/abort bridging) in `packages/bot-runtime/src/loop.ts`
- [ ] T061 [P] Implement `packages/bot-runtime/src/session-codec.ts` and `packages/bot-runtime/src/compaction.ts`
- [ ] T062 [P] Implement `packages/bot-runtime/src/events.ts`
- [ ] T063 Implement the command handler in `packages/bot-runtime/src/worker-entry.ts`
- [ ] T064 Add the live S0 probe `scripts/spikes/536/s0-pi-probe.mjs`: a real model through a local broker stub, writing sanitized evidence to `specs/536-conversational-bots/evidence/s0/`. It does not run in CI. Record the owner-approved spend cap before running
- [ ] T065 L4 checkpoint: per-layer PR procedure; branch `536-l4-bot-runtime`

---

## Phase 6: Foundational — L5 Scope-runtime bot profile (`feat(scope-runtime): add isolated bot workload profile`)

**Gate**: S0 (the probe must run under this profile on a disposable VPS).

- [ ] T070 [P] Write failing tests in `tests/scope-runtime/bot-profile.test.ts`: fixed properties equal the chat profile except `RuntimeMaxSec=900` and the bot-runtime mount; the digest is pinned; the `scope-runtime-chat-v1` digest is unchanged
- [ ] T071 [P] Extend `tests/scope-runtime/supervisor.test.ts`: multi-profile capability, `matrix-bot` accepted only for `bot_agent`, and adapter matching per profile
- [ ] T072 [P] Extend `tests/scope-runtime/systemd-launcher.test.ts`:
  - `bot_agent` launch with a `~/bots/<id>` root
  - rejection of symlinks and other roots
  - `validateRuntimeSources` per profile
  - provenance reconciliation of bot units
  - stale runtime-map entries removed when a unit exits
- [ ] T073 [P] Write failing tests in `tests/scope-runtime/bot-worker.test.ts`: argument validation for `bot_agent`, command-socket delegation to `@matrix-os/bot-runtime` `worker-entry`, and exit-code mapping
- [ ] T074 [P] Extend `tests/deploy/customer-vps/scope-runtime-systemd.test.ts`: the bot-runtime bundle path is present and read-only
- [ ] T075 Refactor `packages/scope-runtime/src/profile.ts` into a profile catalog and add `packages/scope-runtime/src/bot-profile.ts`
- [ ] T076 Add `profileId`, the `bot_agent` workload, and the profiles list to `packages/scope-runtime/src/protocol.ts`
- [ ] T077 Generalize adapter checks in `packages/scope-runtime/src/supervisor.ts` and `packages/scope-runtime/src/systemd-launcher.ts` (`isFixedChatAdapter`, `validateRuntimeSources`, `supportedAdapters`), and fix the stale-entry cleanup in `supervisor.ts`
- [ ] T078 Add the `~/bots` allowed root in `packages/scope-runtime/src/sandbox.ts` and the bot-runtime path in `packages/scope-runtime/src/main.ts`
- [ ] T079 Extract the loopback inference bridge from `packages/scope-runtime/src/worker.ts` into `packages/scope-runtime/src/inference-bridge.ts` and add the chat-completions path (shared-chat behavior unchanged, covered by `tests/scope-runtime/worker.test.ts`). Move side-effect-free worker helpers into `worker-common.ts` and bundle the Chat worker with esbuild so its single-file mount stays self-contained. Implement the sandbox-side entry `packages/scope-runtime/src/worker-bot.ts`, which starts the bridge, serves the multi-connection command socket, and hands both to the bot runtime's `worker-entry.ts`. Relayed `runtime.bot` commands carry identifiers only; the worker loads the run with `bot.run.load` and images with chunked `bot.input.image`
- [ ] T080 Build the bundled bot worker (`packages/bot-runtime/dist/bot-worker.mjs`, esbuild, Node built-ins only) in `scripts/build-host-bundle.sh`; it ships inside `/opt/matrix/app/packages` and is bind-mounted read-only at `/opt/matrix/scope-sdk/bot-runtime`. Give the supervisor unit `ProtectHome=tmpfs` with a read-only bind of `/home/matrix/home/bots`, and create that directory in `distro/customer-vps/cloud-init.yaml` and `distro/customer-vps/host-bin/matrix-sync-agent` before the supervisor starts
- [ ] T081 Accept multi-profile capability with exact per-profile digests in `packages/gateway/src/collaboration/scope-runtime-client.ts`; add a regression in `tests/gateway/scope-runtime-client.test.ts`
- [ ] T082 Update pinned digests and adapter order in `scripts/spikes/collaboration/production-supervisor-acceptance.mjs`
- [ ] T083 L5 checkpoint: per-layer PR procedure; branch `536-l5-scope-runtime-bot-profile`; run `scripts/spikes/536/s0-pi-probe.mjs` under the profile on a disposable VPS and record S0 evidence (go/no-go on Pi)

---

## Phase 7: Foundational — L6 Gateway bot state (`feat(gateway): add bot state repositories`)

**Gate**: Spike A.

- [ ] T090 [P] Write failing tests in `tests/gateway/bots/migrations.test.ts`: versioned migrations apply once, in order, one transaction each, and survive restart (pattern from `packages/gateway/src/collaboration/database-migrations.ts`)
- [ ] T091 [P] Write failing tests in `tests/gateway/bots/operations-repository.test.ts`: reserve idempotency, `409` on a payload-hash conflict, and transitions to `file_created`, `active`, and `failed_recoverable`
- [ ] T092 [P] Write failing tests in `tests/gateway/bots/interactions-repository.test.ts`: one blocking pending interaction per task (partial unique index), the 32-per-owner cap under concurrent inserts, claim at revision, and expiry
- [ ] T093 [P] Write failing tests in `tests/gateway/bots/grants-repository.test.ts`: unique live grant, revocation, and audience filter
- [ ] T094 [P] Write failing tests in `tests/gateway/bots/memory-repository.test.ts`: the 2,000 cap in the insert transaction, full-text search ranking, unconfirmed items excluded, and forget marking sessions for recompaction
- [ ] T095 [P] Write failing tests in `tests/gateway/bots/tasks-repository.test.ts` and `tests/gateway/bots/checkpoints-repository.test.ts`: task transitions, cascading cancel, and checkpoint phases with `effect_unknown` reconciliation
- [ ] T096 [P] Write failing tests in `tests/gateway/bots/sessions-repository.test.ts`, `tests/gateway/bots/connect-requests-repository.test.ts`, and `tests/gateway/bots/approvals-repository.test.ts`
- [ ] T097 Implement the v1 migrations for all M1 tables in `data-model.md` in `packages/gateway/src/bots/database-migrations.ts`, and the runner in `packages/gateway/src/bots/database.ts`
- [ ] T098 [P] Implement `packages/gateway/src/bots/repositories/operations.ts` and `bindings.ts`
- [ ] T099 [P] Implement `packages/gateway/src/bots/repositories/interactions.ts` and `connect-requests.ts`
- [ ] T100 [P] Implement `packages/gateway/src/bots/repositories/grants.ts` and `approvals.ts`
- [ ] T101 [P] Implement `packages/gateway/src/bots/repositories/memory.ts`
- [ ] T102 [P] Implement `packages/gateway/src/bots/repositories/tasks.ts`, `checkpoints.ts`, and `sessions.ts`
- [ ] T103 L6 checkpoint: per-layer PR procedure, split to stay under the PR size limit: `536-l6a-gateway-bot-state` (T090, T091, T095, T096 sessions, T097, T098, T102) and `536-l6b-gateway-bot-interactions` (T092-T094, the rest of T096, T099-T101)

---

## Phase 8: Foundational — L7 Scope-runtime host, registry, broker, private admission (`feat(gateway): share scope runtime host with private bot admission`)

**Gate**: Spike A.

- [ ] T110 [P] Write failing tests in `tests/gateway/scope-runtime-host.test.ts`: the host starts without collaboration configured, there is exactly one broker socket, `authorize` dispatches to the owning registry, and shutdown drains in order
- [ ] T111 [P] Write failing tests in `tests/gateway/bots/runtime-registry.test.ts`: bind, authorize, and expire; capacity 64 with a TTL sweep before admission; stale generation rejected
- [ ] T112 [P] Write failing tests in `tests/gateway/bots/bot-workspace-root.test.ts`:
  - resolution of `bot_workspace` under `~/bots/<botId>`
  - symlink and replaced-path rejection
  - device/inode fingerprint
  - `root_changed`
  - `invalid_root`
- [ ] T113 [P] Write failing tests in `tests/gateway/bots/private-admission.test.ts`: owner-only admission, handle derivation, manifest contents, no collaboration scope required, and shared routes unable to address a private handle
- [ ] T114 [P] Write failing tests in `tests/gateway/bots/broker-bot-actions.test.ts`:
  - tools allowed only for bot-registry runtimes
  - `inference.chat_completions`
  - `bot.tool` validation plus checkpoint writes before and after
  - `bot.event` projection and ordering
  - `bot.session.save` revision
  - limits and allowlisted errors
- [ ] T115 [P] Add regression coverage in `tests/gateway/shared-ai-runtime.test.ts` and `tests/gateway/scope-runtime-broker.test.ts`: shared-chat behavior is unchanged after the extraction
- [ ] T116 Extract the broker server, supervisor client, and registry composition from `packages/gateway/src/collaboration/shared-ai-runtime.ts` into `packages/gateway/src/scope-runtime-host/index.ts`
- [ ] T117 Implement `packages/gateway/src/bots/runtime-registry.ts`
- [ ] T118 Implement `packages/gateway/src/chat/bot-workspace-root.ts` and call it from `packages/gateway/src/chat/execution-root.ts`
- [ ] T119 Implement private admission and manifests in `packages/gateway/src/bots/admission.ts`
- [ ] T120 Dispatch broker authorization by registry, and add the bot actions in `packages/gateway/src/bots/broker-actions.ts`, wired from `packages/gateway/src/collaboration/scope-runtime-broker.ts`
- [ ] T121 Replace the L1 fail-closed `bot_workspace` handling with real handling where bot runs need it (`turn-admission.ts`, `queue-admission.ts`, `orchestrator.ts`)
- [ ] T122 Start the host in `packages/gateway/src/server.ts` before collaboration wiring and pass it into `packages/gateway/src/startup/collaboration.ts`
- [ ] T123 L7 checkpoint: per-layer PR procedure, split to stay under the PR size limit: `536-l7a-scope-runtime-host` (T110-T113, T115-T119, T122) and `536-l7b-bot-broker-actions` (T114, T120). T121's orchestrator dispatch for bot runs lands with the adapter in L8; turn and queue admission already refuse a bot root on a Project chat

---

## Phase 9: L8 Instantiation, bot adapter, orchestration (US1, US4) (`feat(bots): create recipe bots and run them in the bot runtime`)

**Independent test**: POST instantiate twice with one `clientRequestId` → the same bot, chat, and workspace. Send a message → the bot runs in the bot workload through the broker. Kill the gateway mid-tool → `effect_unknown`, no replay. **Gate**: Spike A.

- [ ] T130 [P] [US1] Write failing tests in `tests/gateway/bots/instantiation.test.ts`:
  - idempotent creation
  - `409` on a payload conflict
  - `429` at 100 bots
  - crash between each step recoverable with fixed IDs
  - exclusive workspace create
  - an edited bot is never deleted
- [ ] T131 [P] [US1] Write failing tests in `tests/gateway/bots/instantiate-route.test.ts`: auth, `bodyLimit`, Zod validation, typed error mapping, `503` when a dependency is missing
- [ ] T132 [P] [US1] Write failing tests in `tests/gateway/bots/bot-chat-adapter.test.ts` with a fake supervisor: `start`, `resume`, `cancel`, `steer`, `submitInput`, and `submitApproval`; event mapping; `waiting_person` exit and resume
- [ ] T133 [P] [US4] Write failing tests in `tests/gateway/bots/task-orchestration.test.ts`: status transitions, active-ms deadline excluding waits, budget caps (60 tool actions), and cancellation
- [ ] T134 [P] [US4] Write failing tests in `tests/gateway/bots/restart-reconciliation.test.ts`: reattach by generation; otherwise the checkpoint becomes `effect_unknown` and is never replayed; `recover` and `detachOnShutdown`; failure cases 2 and 3
- [ ] T135 [P] [US1] Extend `tests/gateway/chat-agent-context.test.ts`: `matrix_bot` bots are admitted by capability set without `full_access`; Hermes and Codex behavior is unchanged
- [ ] T136 [P] [US1] Write failing tests in `tests/gateway/bots/system-prompt.test.ts`: the prompt stays under 7K tokens with the largest launch-set recipe
- [ ] T137 [US1] Implement the reserved operation, file create under the owner lock, workspace create, and activation transaction in `packages/gateway/src/bots/instantiation.ts`
- [ ] T138 [US1] Implement `POST /api/chat-agents/instantiate` in `packages/gateway/src/bots/routes.ts`, registered from `packages/gateway/src/server.ts`
- [ ] T139 [US1] Implement the `matrix_bot` `CanonicalChatProviderAdapter` in `packages/gateway/src/bots/chat-adapter.ts`
- [ ] T140 [US4] Implement `packages/gateway/src/bots/task-orchestrator.ts`
- [ ] T141 [US4] Implement startup and periodic reconciliation (bounded batch, timer cleared on shutdown) in `packages/gateway/src/bots/reconciliation.ts`
- [ ] T142 [US1] Register `matrix_bot` as a non-user-selectable driver in `packages/gateway/src/chat/provider-catalog.ts`, and in `executableDriverKinds` and the adapter registry in `packages/gateway/src/server.ts`
- [ ] T143 [US1] Add the `runtime: "matrix_bot"` selection and `recipeRef` in `packages/gateway/src/chat/agent-store.ts`; add the capability-set policy in `packages/gateway/src/chat/agent-context.ts`
- [ ] T144 [US1] Implement `packages/gateway/src/bots/system-prompt.ts`
- [ ] T145 L8 checkpoint: per-layer PR procedure, split to stay under the PR size limit: `536-l8a-bot-instantiation` (T130, T131, T136, T137, T138, T144, creation reconciliation from T141, and `recipeRef` from T143, with the server-side M1 recipe catalog) and `536-l8b-bot-chat-adapter` (T132-T135, T139, T140, run reconciliation from T141, T142, and the capability-set policy from T143). Jev Inbox Triage joins the recipe catalog in L9, once its owner-bound Gmail capability is a bot tool

---

## Phase 10: L9 Interactions, grants, connections, approvals, memory, authority (US1, US2, US4) (`feat(bots): add conversational setup, grants, and memory`)

**Independent test**: Story 2 independent test (Gmail connected, Calendar disconnected, decline, later connect, resume) against the fixture broker; the authority view matches the database throughout. **Gate**: Spike A.

- [ ] T150 [P] [US1] Write failing tests in `tests/gateway/bots/interaction-service.test.ts`: question create and resolve, exactly one continuation, expiry releases the worker, and no nagging after a decline in the same task
- [ ] T151 [P] [US1] Write failing tests in `tests/gateway/bots/interaction-route.test.ts`: responder-only, stale revision `409`, `expired`, kind mismatch `400`, and `bodyLimit`
- [ ] T152 [P] [US2] Write failing tests in `tests/gateway/bots/grant-service.test.ts`: checks before dispatch and before publish, revocation mid-task, audience mismatch, and never exposing account IDs
- [ ] T153 [P] [US2] Write failing tests in `tests/gateway/bots/connect-correlation.test.ts`: baseline diff with one, several (`ambiguous` → account choice), or no new connections; duplicated and forged completions; the 15-minute expiry; the reconcile tick
- [ ] T154 [P] [US4] Write failing tests in `tests/gateway/bots/approvals.test.ts`: exact binding, invalidation on changed arguments or policy revision, deny once then approve a second proposal, and a single claim
- [ ] T155 [P] [US1] Write failing tests in `tests/gateway/bots/memory-service.test.ts`: owner-stated preferences stored confirmed; tool-sourced items stored unconfirmed and excluded; 2K-token retrieval budget; forget and recompaction flag; failure case 7 (an email cannot create standing memory)
- [ ] T156 [P] [US1] Write failing tests in `tests/gateway/bots/authority-route.test.ts`: the response matches repository state after grant, revoke, forget, and confirm; no external account IDs; owner-only
- [ ] T157 [P] [US2] Write failing tests in `tests/gateway/bots/integration-capability.test.ts`: `bot.tool` `integration.call` goes through `packages/gateway/src/integrations/platform-proxy.ts` only with a matching grant; the worker never receives a bearer
- [ ] T158 [US1] Implement `packages/gateway/src/bots/interactions.ts` and `POST /api/chats/:chatId/interactions/:interactionId/resolve` in `packages/gateway/src/bots/routes.ts`
- [ ] T159 [US2] Implement `packages/gateway/src/bots/grants.ts` and `DELETE /api/chat-agents/:agentId/grants/:grantId`
- [ ] T160 [US2] Implement `packages/gateway/src/bots/connect-requests.ts`, using the integrations inventory and `/sync` through `packages/gateway/src/integrations/platform-proxy.ts` with a 10-second timeout
- [ ] T161 [US2] Add the `integration.inventory` and `integration.call` capabilities to `packages/gateway/src/bots/broker-actions.ts`
- [ ] T162 [US4] Implement `packages/gateway/src/bots/approvals.ts`
- [ ] T163 [US1] Implement `packages/gateway/src/bots/memory.ts` and the memory `forget`/`confirm` routes
- [ ] T164 [US1] Implement `GET /api/chat-agents/:agentId/authority` in `packages/gateway/src/bots/authority.ts`
- [ ] T165 [US1] Publish the `contracts/chat-events.md` events after commit through the chat outbox from each bots service
- [ ] T166 L9 checkpoint: per-layer PR procedure, split to stay under the PR size limit:
  - `536-l9a-bot-interactions-memory`: T150, T151, T155, T158, T163, and T165 for creation, question, task, and memory events.
  - `536-l9b-bot-grants-connections`: T152, T154, T157, T159, T161, T162, the server-side integration client, account choices, approvals bound to a task so they survive the continuation run, declined requests that are never repeated in a task, and grant revocation.
  - `536-l9c-bot-connections-authority`: T153, T156, T160, T164, starting and completing connection requests, and Jev in the recipe catalog.

---

## Phase 11: L10 Shared UI plus Web Canvas and Web Desktop (US1, US2, US4) (`feat(ui): conversational bot setup in Web Chat`)

**Independent test**: Story 1 independent test in Web Canvas and Web Desktop. Screenshots of creation, a question card, a connect card, the authority panel, and a remembered item. **Gate**: Spike A plus surface evidence.

- [ ] T170 [P] [US1] Write failing tests in `tests/contracts/bots/view-model.test.ts` for shared derivations (interaction card state, authority grouping, task status copy)
- [ ] T171 [P] [US1] Write failing tests in `tests/ui/bots/instantiate-from-recipe.test.tsx`: a launch-set recipe instantiates and opens the direct chat; retry reuses `clientRequestId`; failure keeps the panel open with a generic error
- [ ] T172 [P] [US2] Write failing tests in `tests/ui/bots/interaction-cards.test.tsx`: question, account choice, connect request, and approval, in loading, expired, resolved, and error states, with allowlisted error strings
- [ ] T173 [P] [US1] Write failing tests in `tests/ui/bots/authority-panel.test.tsx`: grants, memory with source, confirm/forget, and revoke; state cleared only after server success
- [ ] T174 [P] [US1] Write failing tests in `tests/shell/bot-chat-parity.test.tsx`: Web Canvas and Web Desktop both render bot identity, interaction cards, and remembered parts through `shell/src/components/ChatApp.tsx`
- [ ] T175 [US1] Implement `packages/contracts/src/bots/view-model.ts`
- [ ] T176 [US1] Implement the API client with an error allowlist in `packages/ui/src/chat-agents/bots/client.ts`
- [ ] T177 [US1] Route launch-set recipe selection to instantiation in `packages/ui/src/chat-agents/AgentRecipesPanel.tsx` and `packages/ui/src/chat-agents/recipe-handoff.ts`; keep prompt handoff for non-launch recipes
- [ ] T178 [P] [US2] Implement `packages/ui/src/chat-agents/bots/InteractionCard.tsx`
- [ ] T179 [P] [US1] Implement `packages/ui/src/chat-agents/bots/BotAuthorityPanel.tsx`
- [ ] T180 [P] [US1] Implement `packages/ui/src/chat-agents/bots/RememberedItemPart.tsx` and `packages/ui/src/chat-agents/bots/BotTaskStatus.tsx`, using `AgentAvatar`/`RecipeRabbit` states
- [ ] T181 [US1] Map the new events and render the components in `shell/src/lib/canonical-chat-client.ts` and `shell/src/components/ChatApp.tsx`
- [ ] T182 [US1] Run `npx react-doctor@latest shell` and `npx react-doctor@latest packages/ui`; capture screenshots to `docs/pr-evidence/536/l10/` following the shell screenshot recipe
- [ ] T183 L10 checkpoint: per-layer PR procedure, including `bun run build:shell:production`; branch `536-l10-web-bot-ui`

---

## Phase 12: L11 Electron Desktop, Web Mobile, Native Mobile (US1, US2, US4) (`feat(desktop,mobile): conversational bots parity`)

**Independent test**: the Story 1 and Story 2 flows on each surface, with evidence naming the surface and revision. **Gate**: M1 surface parity (FR-014) and Spike A.

- [ ] T190 [P] [US1] Write failing tests in `tests/desktop/bot-chat.test.tsx` for the Electron transcript: bot identity, interaction cards, authority panel entry, and remembered parts
- [ ] T191 [P] [US1] Write failing tests in `apps/mobile/__tests__/bot-transcript.test.ts` for the Native Mobile transcript projection of bot events and pending interactions
- [ ] T192 [P] [US1] Write failing tests in `tests/shell/bot-chat-mobile.test.tsx` for the Web Mobile runtime (`bun run dev:mobile-shell` presentation)
- [ ] T193 [US1] Wire Electron Desktop in `desktop/src/renderer/src/features/chat/canonical-chat-presentation.ts` and `desktop/src/renderer/src/components/conversation/transcript.tsx`
- [ ] T194 [US1] Wire Native Mobile in `apps/mobile/lib/canonical-chat-transcript.ts` and its transcript components
- [ ] T195 [US1] Wire Web Mobile layout adaptations in `shell/src/components/mobile/MobileShell.tsx`, where it renders `ChatApp`
- [ ] T196 L11 checkpoint: per-layer PR procedure, including the mobile gates from `docs/dev/mobile-shell.md`; branch `536-l11-bot-surface-parity`. **Milestone M1 gate**: run Spike A (steps 1-4, 8, 9 and failure cases 1-7, 11, 12, 17) on a disposable VPS and record results in `specs/536-conversational-bots/evidence/spike-a/`

---

## Phase 13: L12 Routines (US5) (`feat(bots): durable conversational routines`)

**Independent test**: ask for a follow-up in two minutes, restart the gateway, and see exactly one run; pause through conversation. **Gate**: the Spike A wakeup case.

- [ ] T200 [P] [US5] Write failing tests in `tests/gateway/bots/routine-scheduler.test.ts`: `ON CONFLICT` deduplication across restart, IANA timezone handling, a missed fire runs once, pause/resume, and the interval restart case
- [ ] T201 [P] [US5] Write failing tests in `tests/gateway/bots/routine-activation.test.ts`: routines activate only after an explicit approval interaction capturing timing, timezone, delivery chat, and effects; a recipe mention does not activate
- [ ] T202 [P] [US5] Write failing tests in `tests/gateway/bots/routine-route.test.ts` for `PATCH /api/chat-agents/:agentId/routines/:routineId`
- [ ] T203 [P] [US5] Write failing tests in `tests/ui/bots/routine-card.test.tsx`
- [ ] T204 [US5] Add the v2 migration (`bot_routines`, `bot_routine_fires`) in `packages/gateway/src/bots/database-migrations.ts`, and `packages/gateway/src/bots/repositories/routines.ts`
- [ ] T205 [US5] Implement `packages/gateway/src/bots/routine-scheduler.ts` (bounded tick, cleared on shutdown)
- [ ] T206 [US5] Add routine activation through approval interactions in `packages/gateway/src/bots/interactions.ts`, and the route in `packages/gateway/src/bots/routes.ts`
- [ ] T207 [US5] Implement the routine card and authority listing in `packages/ui/src/chat-agents/bots/RoutineCard.tsx` and wire it in all three renderers
- [ ] T208 L12 checkpoint: per-layer PR procedure; branch `536-l12-bot-routines`

---

## Phase 14: L13 Groups part 1 (US3) (`feat(bots): bots as group participants`)

**Independent test**: invite two bots to a group; mention one → only that bot runs; the group-visible authority subset excludes private data. **Gate**: Spike B.

- [ ] T210 [P] [US3] Write failing tests in `tests/gateway/bots/participants.test.ts`: add and remove, the 8-bot cap, one coordinator, and bot-owner consent
- [ ] T211 [P] [US3] Write failing tests in `tests/gateway/bots/group-admission.test.ts`: collaboration `request_ai` authority and guest AI permission (failure case 16); group runs mount the shared root or a task workspace, never the private workspace
- [ ] T212 [P] [US3] Write failing tests in `tests/gateway/bots/mention-routing.test.ts`: only the addressed bot runs; bot messages do not trigger other bots; an unaddressed task goes to the deterministic coordinator
- [ ] T213 [P] [US3] Write failing tests in `tests/gateway/bots/group-privacy.test.ts`: private memory, direct history, and grants never enter group context without an audience grant; failure cases 6 and 13
- [ ] T214 [US3] Add the v3 migration (`bot_participants`) and `packages/gateway/src/bots/repositories/participants.ts`
- [ ] T215 [US3] Implement `packages/gateway/src/bots/participants.ts` and the participant routes
- [ ] T216 [US3] Add group admission in `packages/gateway/src/bots/admission.ts` via `packages/gateway/src/collaboration/shared-ai-runtime.ts` authority; allow shared chats for registered participants in `packages/gateway/src/chat/agent-context.ts`
- [ ] T217 [US3] Implement the mention router and coordinator selection in `packages/gateway/src/bots/group-router.ts`
- [ ] T218 [US3] Build the participant UI and group authority subset in `packages/ui/src/chat-agents/bots/GroupParticipants.tsx`, wired in all renderers
- [ ] T219 L13 checkpoint: per-layer PR procedure; branch `536-l13-bot-groups`

---

## Phase 15: L14 Groups part 2 (US3) (`feat(bots): bounded handoffs between group bots`)

**Independent test**: Story 3 independent test (Research Rabbit to Brief Rabbit, one verified artifact, attributed). **Gate**: Spike B (steps 6-7, failure cases 9, 10, 14, 15).

- [ ] T220 [P] [US3] Write failing tests in `tests/gateway/bots/handoffs.test.ts`: capability subset containment, depth 3, 12 per tree, request-ID idempotency, and no new grants
- [ ] T221 [P] [US3] Write failing tests in `tests/gateway/bots/task-workspaces.test.ts`: `~/bots/<botId>/tasks/<taskId>` creation and cleanup policy
- [ ] T222 [P] [US3] Write failing tests in `tests/gateway/bots/group-queue.test.ts`: one bot run posts at a time (one-run-per-Chat); funded turns queue behind the owner's interactive turn
- [ ] T223 [P] [US3] Write failing tests in `tests/ui/bots/handoff-attribution.test.tsx`
- [ ] T224 [US3] Add the v4 migration (`bot_handoffs`) and implement `packages/gateway/src/bots/handoffs.ts` and the `handoff.create` capability in `broker-actions.ts`
- [ ] T225 [US3] Implement task workspaces in `packages/gateway/src/bots/task-workspaces.ts`
- [ ] T226 [US3] Implement the cancellation cascade and budget accounting in `packages/gateway/src/bots/task-orchestrator.ts`
- [ ] T227 [US3] Build the handoff and attribution UI in `packages/ui/src/chat-agents/bots/HandoffChain.tsx`, wired in all renderers
- [ ] T228 L14 checkpoint: per-layer PR procedure; branch `536-l14-bot-handoffs`. **Milestone M3 gate**: run Spike B on a disposable VPS with the L2 platform preview and record results in `specs/536-conversational-bots/evidence/spike-b/`

---

## Phase 16: L15 Computer service (US4) (`feat(computer): isolated bot computer service`)

**Gate**: Spike C.

- [ ] T230 [P] [US4] Write failing tests in `tests/computer-service/leases.test.ts`: fencing generations, stale-action rejection, and takeover pausing queued actions (failure case 8)
- [ ] T231 [P] [US4] Write failing tests in `tests/computer-service/egress-proxy.test.ts`: private, metadata, and redirect-to-private addresses blocked with a pinned lookup; subresources and downloads covered (failure case 18)
- [ ] T232 [P] [US4] Write failing tests in `tests/computer-service/screenshots.test.ts`: 2 MiB frame cap, image content (not paths), and the symlink-safe TTL sweep
- [ ] T233 [P] [US4] Write failing tests in `tests/deploy/customer-vps/computer-service.test.ts`: the unit is present in the bundle, cloud-init, sync-agent, and golden-snapshot activation; installer oneshot retries
- [ ] T234 [US4] Create `packages/computer-service/` (package.json, `src/server.ts` on `/run/matrix/computer.sock`, `src/display.ts`, `src/browser.ts`, `src/leases.ts`, `src/screenshots.ts`)
- [ ] T235 [US4] Implement `packages/computer-service/src/egress-proxy.ts`, reusing the address rules from `packages/gateway/src/integrations/custom-mcp/security.ts` and the pinned lookup from `packages/gateway/src/integrations/custom-mcp/pinned-lookup.ts`, extracted into a shared module
- [ ] T236 [US4] Add `distro/customer-vps/systemd/matrix-computer.service` and the `matrix-install-computer` oneshot; register them in `distro/customer-vps/cloud-init.yaml`, `distro/customer-vps/host-bin/matrix-sync-agent`, and `distro/customer-vps/host-bin/matrix-golden-snapshot-activate`
- [ ] T237 L15 checkpoint: per-layer PR procedure; branch `536-l15-computer-service`

---

## Phase 17: L16 Gateway computer use and takeover (US4) (`feat(bots): computer use with takeover`)

**Independent test**: Story 4 independent test (website with no connector, a visual dialog, saved artifact evidence, takeover). **Gate**: Spike C.

- [ ] T240 [P] [US4] Write failing tests in `tests/gateway/bots/computer-capability.test.ts`: the `computer.act` capability carries the observation ID and generation; screenshots reach the model as bounded image content
- [ ] T241 [P] [US4] Write failing tests in `tests/gateway/bots/computer-stream-route.test.ts`: the query-token allowlist entry in `packages/gateway/src/auth.ts`, origin check, frame caps, and slow-client disconnect
- [ ] T242 [P] [US4] Write failing tests in `tests/gateway/bots/computer-capacity-gate.test.ts`: disabled on the starter plan until measured; a truthful unavailable state
- [ ] T243 [P] [US4] Write failing tests in `tests/ui/bots/computer-takeover.test.tsx`
- [ ] T244 [US4] Implement `packages/gateway/src/bots/computer-client.ts` and the `computer.act` capability
- [ ] T245 [US4] Implement `WS /ws/computer/:computerId` in `packages/gateway/src/bots/computer-stream-route.ts`, with its allowlist entry
- [ ] T246 [US4] Implement the capacity gate in `packages/gateway/src/bots/computer-capacity.ts`, using the plan from `packages/contracts/src/billing-catalog.ts`
- [ ] T247 [US4] Build the takeover UI in `packages/ui/src/chat-agents/bots/ComputerTakeover.tsx`, wired in Web Canvas, Web Desktop, and Electron Desktop; view-only on mobile
- [ ] T248 L16 checkpoint: per-layer PR procedure; branch `536-l16-bot-computer-use`. **Milestone M4 gate**: run Spike C with a capacity measurement on the smallest supported plan and record results in `specs/536-conversational-bots/evidence/spike-c/`

---

## Phase 18: L17 Channel hosting (US1, US2) (`feat(channels): host bot conversations in Telegram`)

**Independent test**: a bot conversation continues in Telegram with the same identity, grants, and memory scopes; an approval requested there shows the exact proposal or deep-links to Matrix.

- [ ] T250 [P] [US1] Write failing tests in `tests/gateway/bots/channel-binding.test.ts`: channel thread ↔ bot conversation binding, with no second identity or grant model
- [ ] T251 [P] [US2] Write failing tests in `tests/gateway/bots/channel-approvals.test.ts`: a free-text reply cannot approve an effect the channel did not display exactly
- [ ] T252 [US1] Implement `packages/gateway/src/bots/channel-binding.ts` and wire it into `packages/gateway/src/channels/manager.ts` and `packages/gateway/src/channels/telegram.ts`
- [ ] T253 L17 checkpoint: per-layer PR procedure; branch `536-l17-bot-channels`

---

## Phase 19: L18 Polish and cross-cutting

- [ ] T260 Run `/update-docs`; correct the Pi transport description in `docs/dev/coding-agent-shells.md`; add `docs/dev/bot-runtime.md` (profile, broker actions, recovery, limits); add the relevant AGENTS.md gotchas
- [ ] T261 Report actual coverage for `packages/bot-runtime`, `packages/computer-service`, and `packages/gateway/src/bots` via `bun run test:coverage`, and add those packages to the coverage `include` list in `vitest.config.ts`
- [ ] T262 Open the separate site documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` for verified M1 behavior (bot setup, integrations, authority view, limitations); repeat per milestone
- [ ] T263 Update `specs/536-conversational-bots/recipe-coverage.md` launch-set rows from "Not tested" to validated or blocked, with evidence links from Spike A
- [ ] T264 L18 checkpoint: per-layer PR procedure; branch `536-l18-docs`

---

## Dependencies and execution order

```text
L0 ─► L1 ─┬─► L2 ─► L3 ───────────────────────────────┐
          ├─► L4 ─► L5 ─┐                              │
          └─► L6 ───────┴─► L7 ─► L8 ─► L9 ─► L10 ─► L11 ─► L12
                                                     └─► L13 ─► L14 (needs L2, L3)
                                  L7 ─► L15 ─► L16 (needs L9)
                                                     L11 ─► L17
All ─► L18
```

- A GitHub stack is linear, so the layers are ordered L1-L18 in one chain. Branches that do not depend on each other (for example L2 and L4) can still be developed in parallel worktrees and rebased into order with `gh stack rebase`.
- Within a layer, all [P] test tasks run first and in parallel; implementation tasks follow in the order listed.
- Milestone merge gates: M1 = L1-L11 plus S0 and Spike A; M2 = L12; M3 = L13-L14 plus Spike B; M4 = L15-L16 plus Spike C; M5 = L17.

## Parallel examples

```text
L1: T010, T011, T012, T013 together; then T014, T015, T016, T017 together
L4: T051-T056 together; then T057, T058, T059, T061, T062 together; then T060, T063
L6: T090-T096 together; then T098-T102 together after T097
L9: T150-T157 together
L10: T170-T174 together; then T178, T179, T180 together
```

## Implementation strategy

1. **MVP**: L0-L10 plus S0 and Spike A. This delivers recipe → bot with conversational setup, gradual integrations, approvals, memory, and the authority view in Web Canvas and Web Desktop.
2. **M1 complete**: add L11 for surface parity and validate the eight launch-set recipes.
3. **Increments**: M2 routines (L12), M3 groups (L13-L14), M4 computer use (L15-L16), M5 channels (L17). Each ships with its site docs PR.
4. **Stop conditions**: stop at any failed decision gate in [spike-plan.md](spike-plan.md#decision-gate) (for example, effects bypassing grants or blind replay after restart) and revise before building further layers on top.
