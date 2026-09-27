# Research: Conversational Recipe Bots

Phase 0 output for [plan.md](plan.md). Baseline: Matrix `5f9fc5362` plus this branch, inspected 2026-09-27. Each entry records the decision, the rationale from the code or package, and the alternatives considered. Items marked **spike-verified later** remain hypotheses until the named stage of [spike-plan.md](spike-plan.md) records evidence.

## R1. Pi packages and version pin

- **Decision**: Pin `@earendil-works/pi-agent-core@0.86.1` and `@earendil-works/pi-ai@0.86.1` exactly, with pnpm overrides pinning `@earendil-works/chord` and `@earendil-works/pi-telemetry` to `0.86.1`. Do not use `pi-coding-agent`.
- **Rationale**: 0.86.1 (published 2026-09-20, MIT) is the newest release that satisfies the seven-day `minimumReleaseAge`. The core `Agent` class provides everything bots need: TypeBox tools, a fail-closed `beforeToolCall` hook (a blocked call returns an error result and `execute` is never called), `abort()`, `steer()`/`followUp()`, ordered event subscription, rebuilding from `initialState.messages`, and message-level compaction through `generateSummaryWithRequest`. Node `>=22.19.0`, no native dependencies, and no install scripts in Earendil packages (chord's `esbuild` postinstall is already allowlisted and unused at runtime). Releases 0.81 to 0.86 broke APIs, and an earlier Matrix probe failed on a caret range, so exact pins and overrides are mandatory.
- **Usage constraints**:
  - Use `toolExecution: "sequential"`.
  - Wrap `beforeToolCall` so that a thrown error becomes a generic denial, because Pi sends the thrown message to the model.
  - Never register Pi's root-exported bash, read, edit, or write tools.
  - Revalidate every tool argument with Zod at the broker.
  - The transcript contains `role: "system"` messages. Persist them or rebuild them deterministically.
  - `Agent` accepts no external `AbortSignal`, so bridge cancellation to `abort()`.
- **Alternatives**:
  - `pi-coding-agent` SDK: rejected. It adds a TUI, JSONL sessions, `auth.json`, and built-in coding tools that bots must not have.
  - Waiting for 0.87.x: rejected because it adds nothing required.
  - Hermes as the bot executor: kept as the comparison baseline in the runtime decision record.

## R2. Model routes and broker transport

- **Decision**: Bot inference uses pi-ai custom providers (`createProvider`) whose `baseUrl` points at the scope runtime's existing loopback inference bridge, `http://127.0.0.1:<port>` inside the workload's private network namespace. The broker socket speaks newline-delimited JSON frames, not HTTP. The existing worker (`packages/scope-runtime/src/worker.ts`, `startInferenceBridge`) already translates SDK HTTP requests into broker `inference.*` frames. Extract it into `packages/scope-runtime/src/inference-bridge.ts`, reuse it for bot workloads, and add the chat-completions path. **M1 buffers each model call**: the bridge and broker return a complete response, with the existing 512 KiB cap. The bot runtime therefore sets per-call `max_tokens` so a response stays under the cap (16K output tokens), and a `max_tokens` stop continues in the next turn rather than failing. Bot replies appear per model call, not per token, matching today's shared scope-runtime Chat. Token streaming needs ordered broker stream frames and is a named follow-up after M1. The provider carries a placeholder API key, which the broker replaces with the real credential. Three wire APIs are needed:
  - Anthropic Messages (owner Anthropic key or profile; Matrix AI Claude routes)
  - OpenAI Responses (owner OpenAI account)
  - OpenAI chat-completions (managed Cloudflare Workers AI route, default `@cf/zai-org/glm-5.3-flash`, which accepts text and image input)
- **Rationale**: All three pi-ai adapters accept a custom `baseUrl` and `fetch`, and support image input. The broker already proxies Messages and Responses byte for byte. It needs a new `inference.chat_completions` action for the managed GLM route, and a bot-profile variant of the body schemas that allows `tools` (the shared-chat schemas enforce `tools: max(0)`). Provider SDK retries are off by default (`maxRetries: 0`), which keeps billing predictable.
- **Alternatives**:
  - Giving the worker a real credential or network access: rejected, because it breaks the no-network profile.
  - A Matrix-specific wire protocol: rejected, because it duplicates pi-ai.

## R3. Execution boundary: a bot workload profile in the scope runtime

- **Decision**: Add a second scope-runtime profile, `scope-runtime-bot-v1`, with workload `bot_agent` and adapter `matrix-bot`, instead of changing the pinned `scope-runtime-chat-v1` profile. The bot profile:
  - Keeps the same isolation properties: `DynamicUser`, `PrivateNetwork`, `ProtectSystem=strict`, private root, and no capabilities.
  - Uses a lifetime that fits the task active-work deadline: `RuntimeMaxSec=900` against the 10-minute deadline.
  - Mounts the pinned bot-runtime bundle read-only.
  - Uses its own digest.
  - Gets a new worker entry that runs one Pi turn loop per run and exits at a checkpoint when the run waits on a person.
- **Rationale**: The current profile is built for single-turn text chat:
  - The worker only accepts `chat_ai`.
  - `executeChat` returns plain text.
  - The broker rejects tools at three layers.
  - `RuntimeMaxSec=90` is inside the pinned digest.
  - Events are chunked text, with no tool or activity events.

  Changing that profile would change its digest, invalidate stored shared-chat eligibility, and refuse turns queued before the upgrade. A separate profile isolates the change. Long human waits end the workload at a durable checkpoint (R9), so no workload runs for hours.
- **Coordinated changes**, all in one host-bundle release with the supervisor restart that `matrix-sync-agent` already performs:
  - supervisor adapter/profile catalog and multi-profile capability advertisement
  - launcher `isFixedChatAdapter` and `validateRuntimeSources` generalization
  - worker argument validation
  - gateway client catalog and digest checks
  - `tests/scope-runtime/supervisor.test.ts` digest pin
  - the production acceptance script
- **Pi packaging**: bundle the pinned Pi packages as dependencies of the bot-runtime worker in the host bundle (`/opt/matrix/scope-sdk/bot-runtime`). Do not install them in the tool-pack prefix, which installs Pi `latest` and already drifts the Codex pin (see R16).
- **Alternatives**:
  - Adding `pi` as an adapter under `scope-runtime-chat-v1`: rejected for the digest and queued-turn reasons above.
  - Running the loop in the gateway process: rejected, because it gives up restart isolation and the blast radius of third-party SDK code.
  - A new parallel `matrix-agentd` service: rejected by spec review.

## R4. Private admission and the bot workspace

- **Decision**:
  - **Workspace**: each bot gets a workspace at `~/bots/<botId>/`, created exclusively inside the reserved creation operation and validated with `resolveWithinHome`.
  - **Root kind**: add a `bot_workspace` execution-root kind (`{ kind: "bot_workspace", botId }`). The resolver validates it, rejects symlinks, and fingerprints it with sha256 over owner, kind, bot ID, and the directory's device and inode.
  - **Sandbox roots**: add `~/bots` to the supervisor and gateway allowed roots (`sandbox.ts`, `isAllowedSandboxRoot`). Roots are not part of the sandbox policy digest.
  - **Scope handle**: private runs use `scope_<first 32 hex of sha256("bot-private:" + ownerId + ":" + botId)>`. It matches the existing handle regex, and the supervisor never looks it up.
  - **Registry**: a new `BotRuntimeRegistry` binds runtime handle, generation, owner, bot, chat, task, root fingerprint, access source, and capability set. It lives beside `SharedAiRuntimeRegistry`, with the same TTL and capacity pattern.
- **Rationale**: Shared admission requires a collaboration scope UUID, `request_ai` authority, and a `project` or `worktree` root under `~/projects` or `~/worktrees`, and fails `unavailable` otherwise. The supervisor only checks that the manifest handle equals the runtime handle. Consumers read `.projectId` and must handle the new kind explicitly:
  - `canonical-chat-surface.ts`
  - `turn-admission.ts`
  - `queue-admission.ts`
  - `orchestrator.ts`
  - `run-account-binding.ts`
  - `project-chat-root-inventory.ts`
  - `ProjectSourceSummary.tsx`

  `ResolvedChatExecutionRoot.projectSlug` becomes optional, or is set to a reserved non-project value that the orchestrator branches on.
- **Broker composition**: move the broker server, supervisor client, and registries out of `createSharedAiRuntime` into a `ScopeRuntimeHost`. The host starts whenever the scope runtime is available, not only when collaboration is configured. Its `authorize` callback dispatches on the registry that owns the runtime handle. There is still one broker socket.
- **Alternatives**:
  - Hidden projects per bot: rejected, because they pollute project lists and project authority.
  - A single-member collaboration scope per bot: rejected, because it misuses collaboration roles and the invitation model.

## R5. Canonical Chat driver for bots

- **Decision**: Add driver kind `matrix_bot`. The Provider V3 harness is named "Matrix bot runtime". It is not listed in the general Chat model picker and is only resolved for bot runs.
  - Its canonical adapter implements `start`, `resume`, `cancel`, `steer`, `submitInput`, `submitApproval`, `recover`, and `detachOnShutdown` over the bot workload.
  - `isChatAgentDriver` accepts `matrix_bot`.
  - The `full_access` requirement is replaced for bots by the server-issued capability set.
- **Rationale**: The canonical registry allows one adapter per driver kind, and the existing native `pi` coding adapter already owns `pi`. The spec rejects relabeling another harness to pass driver checks. Access sources still resolve through Provider V3 (managed Matrix AI, owner Anthropic, owner OpenAI).
- **Alternatives**:
  - Reusing `pi`: rejected because of the adapter collision and because the permission models differ.

## R6. Bot state and migrations

- **Decision**: New owner Postgres tables use the versioned-migration pattern from collaboration (`bot_schema_migrations`, with each version applied in its own transaction). They do not use ad hoc `CREATE TABLE IF NOT EXISTS`. Bot definitions stay in the existing `agent-store.ts` files, with the store's owner lock and revision checks. A new `bot_chat_bindings` table links bots to chats; today nothing links a chat to a bot, and a bot is only attached per turn by mention.
- **Rationale**: The gateway has no Kysely Migrator; chat uses idempotent bootstrap and collaboration uses versioned steps. Versioned steps are required for later `ALTER`s such as memory `tsvector` columns and M3 participant tables.
- **Alternatives**:
  - Extending chat bootstrap DDL: rejected because it cannot express ordered migrations.

## R7. Conversational interactions

- **Decision**: Add a durable `bot_interactions` table and a new canonical activity family (`interaction.requested`, `interaction.resolved`, `interaction.expired`), with typed kinds:
  - `question`: reuses `UserInputQuestionListSchema` bounds
  - `account_choice`: server-listed connection IDs, never free text
  - `connect_request`: service, requested access, and a connect-request ID
  - `approval`: the exact normalized effect
  - `takeover`: M4

  Resolution goes through `POST /api/chats/:chatId/interactions/:interactionId/resolve` with a transactional claim. New outbox event types extend the closed enum in `canonical-chat-api.ts`.
- **Rationale**: Existing `input.requested` and `approval_request` are tied to an active run and routed to `adapter.submitInput`. They validate only labels and cannot outlive a run. Setup questions and connection requests must survive run exit and gateway restart.
- **Alternatives**:
  - Overloading `input.requested` with accounts as labels: rejected because it carries no typed IDs, no persistence beyond the run, and no connect action.

## R8. Integration grants and connection correlation

- **Decision**:
  - **Grants**: a gateway-owned `bot_grants` table records bot, service, connection ID, account label, action risk classes (`read`, `write`, `send`), audience, expiry, revision, and revocation.
  - **Enforcement**: bot runs call integrations only through broker `bot.tool` actions. The gateway grant service checks the grant, the resolved action schema, and the audience before calling the existing platform proxy (`integrations/platform-proxy.ts`, 30-second timeout). Workers never hold a Hermes or MCP integration bearer.
  - **Connect correlation**: `/connect` responses are paired with a durable `bot_connect_requests` row (15-minute expiry).
    - The platform does not push new connections to the VPS and has no request ID in its webhook. Completion is detected by polling `/sync` and the inventory for a new connection of the requested service created after the request time.
    - Exactly one new matching connection completes the request.
    - More than one creates an `account_choice` interaction.
    - None by expiry expires the request.
    - A browser return only triggers a reconcile; it never proves success.
- **Rationale**: The platform's `pendingLabels` correlation is in memory, keyed by user and app, with a 10-minute TTL, and is lost across Cloud Run instances. Jev's owner-bound binding, with admission rechecks before and after each read, is the model for grant checks. The existing `integration-capabilities.json` `approvedAgents` gate only covers audit actions.
- **Alternatives**:
  - A platform push channel: deferred. It needs platform-to-VPS delivery, which does not exist today.
  - Trusting the return URL: rejected.

## R9. Durability, checkpoints, and restart

- **Decision**:
  - **Transcripts**: bot conversations persist Pi `AgentMessage` transcripts, including system messages, in `bot_agent_sessions`, bounded at 512 KiB per session with compaction beyond that.
  - **Checkpoints**: each tool dispatch writes a checkpoint (`prepared` → `dispatched` → `observed_complete` | `effect_unknown`) before and after the broker call.
  - **Workload exit**: a workload exits when a run waits on a person. A resumed run starts a new workload from the transcript.
  - **Gateway restart**: reconciliation marks dispatched checkpoints without an outcome as `effect_unknown` and never replays them. Read-only actions that are proven idempotent may be retried.
- **Rationale**: Pi rebuilds from messages but cannot resume a suspended JavaScript call. Today's shared scope runs are marked lost on gateway restart (`shared-run-loss.ts`), and the supervisor's in-memory runtime map can keep stale entries (capacity 32). The bot adapter implements `recover` and `detachOnShutdown` so that live workloads can be reattached by generation. A reattach failure falls back to the checkpoint.
- **Alternatives**:
  - Long-lived workloads spanning human waits: rejected on capacity and lifetime grounds.

## R10. Funded AI priority

- **Decision**, following the platform-enforced design in the technical design:
  - **Platform credential class**: `ai_runtime_credentials.request_class` (`interactive` | `background`, default `interactive`, with a CHECK constraint). The issue route replaces `EmptyBodySchema` with `{ requestClass }`, and the issuance cooldown becomes per runtime and per class.
  - **Priority claims**: new `ai_funded_priority_claims (owner_id, machine_id, runtime_slot, created_at, expires_at)`, keyed to the requesting runtime's interactive slot so claims survive relay retries and lease rotation. Claim logic lives in `authorize` under the existing owner advisory lock:
    - An interactive authorization that meets a conflicting active reservation upserts a claim and returns retryable `rate_limited` through a typed outcome, so the transaction commits the claim instead of rolling it back.
    - A background authorization conflicting with a live claim is rejected.
    - The oldest live claimant reserves first, and its reservation deletes its claim.
    - Claims expire after 2 minutes and are capped at 16 per owner.
  - **Schema revision**: bump `PLATFORM_SCHEMA_REVISION`.
  - **Gateway**: `funded-ai-credential-manager.ts` caches one lease per class instead of one shared lease. `kernel-credentials.ts` takes a class. Callers are classified:
    - dispatcher chat and voice: interactive
    - heartbeat, batch, and heal: background
    - canonical Claude chat and app AI: interactive
    - collaboration broker: the requester's class
    - Jev: background
    - bot runs: background, unless the turn answers a person who is waiting
  - **Local queue**: a per-owner gateway queue orders the requests it sees for UX. Priority correctness comes from the platform claim.
  - **Relay**: the relay (`packages/proxy/src/funded-relay.ts`, Cloud Run) needs no change for class, because `authorize` reads the class from the stored credential. Its per-replica in-memory admission is checked in Spike B.
- **Rationale**: The owner-wide conflict check lives in `authorize` (`ai-funded-metering-repository.ts` around lines 495-503) and already runs under an owner advisory lock. A shared gateway lease cannot carry a class.
- **Alternatives**:
  - A gateway-only queue: rejected in review, because it cannot see other runtimes or processes that call the relay directly.

## R11. Memory retrieval

- **Decision**: `bot_memory_items` in owner Postgres. Retrieval per run:
  - Always admit the bot's preferences and conversation preferences.
  - Admit facts and episodes by Postgres full-text rank (`tsvector` over content) plus recency, within a 2K-token budget.
  - Skip embeddings in M1.
- **Rationale**: This needs no new dependency or external service, keeps data owner-local, and is enough for a scoped preference and fact memory.
- **Alternatives**:
  - An embedding index: deferred until retrieval quality is measured.

## R12. Routines (M2)

- **Decision**: Routines live in `bot_routines` with durable fire claims: `bot_routine_fires` keyed by `(routine_id, scheduled_for)`, using `ON CONFLICT DO NOTHING`. A gateway routine scheduler computes due fires from cron expressions and an IANA timezone, claims them transactionally, and admits a canonical bot turn. `~/system/cron.json` is not used.
- **Rationale**: The existing cron service only sends static messages to channels. It cannot start canonical runs, loses missed interval ticks, and likely has a cache-reload bug (R16). Bot routines need binding, deduplication, grants, and restart safety.
- **Alternatives**:
  - Extending cron.json jobs: rejected because they have no transactional claims.

## R13. Groups (M3)

- **Decision**:
  - A `bot_participants` table on shared chats; bot identity uses `CanonicalChatMessage.actorId`.
  - Admission goes through the existing collaboration scope and `request_ai` authority, subject to the guest AI permission from spec 535.
  - Group runs mount the shared Chat's root, or a task workspace at `~/bots/<botId>/tasks/<taskId>/` that is created per group task and never includes the private workspace.
  - Handoffs are child tasks, with the capability subset recorded in `bot_handoffs`.
  - The one-run-per-Chat queue is preserved.
  - `agent-context.ts` stops rejecting shared chats only for registered bot participants.
- **Rationale**: Agent context rejects collaboration chats today. The `actorId` column already exists.
- **Alternatives**:
  - Mention-only binding without participants: rejected because it gives no stable membership or removal semantics.

## R14. Computer service (M4)

- **Decision**: A new `matrix-computer.service` (user `matrix-computer`, `MemoryMax` set per plan) on a Unix socket `/run/matrix/computer.sock`. It follows the `TerminalRuntimeSocketClient` pattern.
  - **Display stack**: Xvfb, a minimal window manager, and Chromium through Playwright, installed by a lazy `matrix-install-computer` oneshot.
  - **Egress**: through an in-service proxy that reuses `gateway/src/integrations/custom-mcp/security.ts` address rules and the `createPinnedCustomMcpLookup` pinned-DNS pattern. Existing mcp-browser DNS preflight has a rebinding gap.
  - **Screenshots**: returned as bounded image content, not paths.
  - **Takeover**: a stream at `WS /ws/computer/:computerId`, added to the query-token allowlist in `gateway/src/auth.ts`. nginx already routes `/ws`.
  - **Capacity**: disabled on the 4 GB starter plan until Spike C measures capacity.
  - **Unit registration**: the unit is added in all four places — `cloud-init.yaml`, `matrix-sync-agent` install blocks, `matrix-golden-snapshot-activate`, and `build-host-bundle.sh` (whole-directory copy).
- **Rationale**: Customer VPSes have no display or browser stack. mcp-browser runs inside the kernel process with one session and no leases. The custom-MCP security module is the strongest existing SSRF implementation.
- **Alternatives**:
  - Extending mcp-browser in process: rejected because there is no isolation, lease, or fencing.

## R15. Stacked PR workflow

- **Decision**: Use GitHub native stacked pull requests through the official `gh stack` extension (`gh extension install github/gh-stack`, installed 2026-09-27), at the owner's request. PR #1940 (spec and plan) is the bottom layer targeting `main`, and each implementation phase is a layer above it.
  - Commands: `gh stack init --base main` (adopting existing branches), `gh stack add`, `gh stack submit`, `gh stack sync`, `gh stack rebase`, and `gh stack merge` (bottom-up only).
  - The repository's stacked-PR safety rules still apply:
    - Merge only when a layer's base is `main`.
    - Never delete branches while later layers are open.
    - Never loop merges.
    - Every layer needs Greptile 5/5 on its current head.
- **Rationale**: The owner explicitly asked for GitHub stacked PRs. This supersedes the Graphite default in AGENTS.md for this feature, and the conflict is recorded in the plan. GitHub stacks retarget automatically when a lower layer merges, and branch protection and CI run on every layer.
- **Caveat**: The feature is in public preview. If `gh stack submit` exits 9 (stacked PRs not enabled for the repository), that is an environment blocker. Report it rather than falling back silently.

## R16. Pre-existing issues found (not fixed by this feature)

- The tool pack installs Codex `0.156.1` and Pi `latest`, while the scope runtime pins Codex `0.154.0`. `verifyCodexBinary` therefore likely disables the Codex scope adapter on hosts with the tool pack installed.
- The cron service's file watcher restarts cron, but `store.list()` returns a cached copy, so jobs written by the kernel may not load until the gateway restarts.
- mcp-browser DNS preflight does not pin the resolved address (DNS rebinding).

File these as separate issues. The bot design does not depend on fixing them.
