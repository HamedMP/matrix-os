# Technical Design Hypotheses: Conversational Recipe Bots

Status: proposed, not implemented or experimentally verified. Product requirements are in [spec.md](spec.md). Source baseline: Matrix `5f9fc5362`, inspected 2026-09-26. The spike must record exact Matrix and Pi revisions and revise unsupported assumptions.

## Existing Foundations and Gaps

| Foundation | Evidence / gap |
|---|---|
| Recipe ideas | `packages/ui/src/chat-agents/AgentRecipesPanel.tsx` lists 71 inspirations plus Jev. `recipe-handoff.ts` currently sends only five skill names and five integrations and omits routines. These metadata entries are not executable skill packages. |
| File-owned bots | `packages/gateway/src/chat/agent-store.ts` writes definitions under `agents/custom/chat-bots/<owner-key>/`, serializing owner mutations through Postgres. Preserve identities and ownership. |
| Recipe admission | `agent-recipe.ts` pins resolved skill instructions and hashes. Existing contract caps are eight skills, eight integrations, and 24 KiB of skill instructions; some inspiration entries exceed those counts. Do not truncate them silently. |
| Harness eligibility | `packages/contracts/src/chat-agent-context.ts` currently admits Hermes/Codex bot drivers; ordinary Pi selection is not sufficient. Existing agent admission also requires full access. A future Matrix bot capability policy must replace that assumption explicitly. |
| Pi transport | `coding-agents/pi-provider.ts` supports RPC dialogs/steering but exposes only read and ask_user, disables ambient skills/extensions, and refuses broader sandbox modes. Preserve that safety contract. |
| Browser | `packages/mcp-browser` has Playwright, persistent profiles, URL guards, and a single active session. `server.ts` wraps the implementation in Claude SDK MCP and returns screenshot paths as text. Extract a harness-neutral service boundary and image transport; prove concurrency and full desktop use separately. |
| Scheduling | `packages/gateway/src/cron/service.ts` supports once/interval/cron; `server.ts` starts it and `server/home-utility-routes.ts` exposes job operations. The gap is durable bot/task binding, event deduplication, grants, and restart-safe routine execution, not absence of all scheduling. |
| Durable execution | Canonical Chat repositories/events and `specs/523-chat-background-runtime/` provide reuse points. Existing Codex supervision is not evidence that Pi survives gateway restarts. |
| Collaboration | `specs/121-collaboration-session-sharing/` and `specs/525-collaboration-ux-redesign/` own human authorization and shared Chat semantics. Guest collaboration ([PR #1941](https://github.com/HamedMP/matrix-os/pull/1941), `specs/535-guest-collaboration/`, in review) makes guest AI permission opt-in per resource and owner-paid, and preserves the existing one-run-per-Chat queue: the canonical Chat projection carries a single `activeRun` and further turns queue in `gateway/src/chat/queue-repository.ts`. Bot participants must extend that authority model, not bypass it. |
| Integrations | Gateway/platform integration broker already handles service inventories and connection flows. Pipedream secrets stay platform-owned. Account connectivity is not a bot or group grant. |
| Isolated scope runtime | `packages/scope-runtime/` and `matrix-scope-runtime.service` already supervise shared-Chat AI workloads outside the gateway. Each workload is a transient systemd unit with `DynamicUser`, `PrivateNetwork=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, a private root, 1 GiB `MemoryMax`, and 200% `CPUQuota` (`profile.ts`). Model and network access leave only through the broker socket, whose protocol admits `inference.messages`, `inference.responses`, and bounded `egress.fetch` GET (`broker-protocol.ts`). Signed eligibility pins exact `claude-code` and `codex` adapter versions (`gateway/src/collaboration/shared-ai-eligibility.ts`). This is the bot execution boundary to extend, not a second boundary to rebuild. |
| Funded model access | Matrix AI usage-mode authorization rejects a new funded request with `rate_limited` while the owner has any reserved, starting, in-flight, or settling usage-mode reservation (`packages/platform/src/ai-funded-metering-repository.ts`). Concurrent bots on the managed route contend for one owner-wide slot, shared with the owner's own Chat. |
| Run evidence UI | `packages/ui/src/chat-agents/ChatContextReceipt.tsx` renders a run's admitted agent snapshot, pinned skills, and selected integrations from server state. It is historical per-run evidence, not a live view of current grants. |
| Channels | Gateway channel adapters (`packages/gateway/src/channels/`) and the planned Matrix messaging bridge (`specs/077-matrix-messaging-bridge/`) carry owner conversations outside Matrix Chat. Bots are not reachable there today. |

## Runtime Choice to Test

Candidate: a Matrix-owned worker using `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. Matrix owns task state, context selection, tools, authorization, persistence, and UI. The candidate must project through `CanonicalChatProviderAdapter` and Provider V3; it must not create a competing settings or transcript store.

Compare against `pi-coding-agent` SDK only if the core forces substantial duplication of compaction/session functionality. Use one selected runtime in the final vertical slice. Pin mutually compatible published package versions that satisfy the seven-day package-age policy; never assume current main documentation matches an installed version. Do not introduce SQLite or a parallel JSONL source of truth. Pi schema adaptation stays internal; public contracts use Zod 4.

### Execution Boundary: Extend the Scope Runtime

Run Pi as a third pinned adapter inside the existing scope runtime, not in the gateway process and not in a new parallel service. The worker inherits the profile's dynamic user, private network, private root, and resource caps. It holds no provider credentials: model calls leave through broker inference actions whose access source Provider V3 resolved at admission, and every tool call leaves through the broker as a run-bound capability request. The broker, not the worker, reaches integrations, the computer service, owner files outside the scope root, and handoff dispatch.

Direct and group bot runs enter the same boundary. A direct-chat run is admitted by the owner principal. A group run is admitted through the existing shared-AI eligibility and scope-bound run path. In both cases the gateway binds these into the signed run context at admission: bot ID and role revision, conversation and participant set, task and handoff identity, resolved access source, and the capability set of account, action, and audience grants. The broker checks that context on every request. A worker cannot widen it; a handoff produces a newly admitted run with a capability subset. The spike must validate group handoffs through the same admission path production will use.

Browser and desktop control cannot run inside a workload without network access. The computer is a separate supervised service with its own Unix identity, owner-private browser profiles, and filtered egress: pinned DNS resolution, private, link-local, and metadata ranges blocked, redirects revalidated, and subresources and downloads covered. The worker reaches it only through broker computer actions that carry the observation ID and fencing generation. The agent loop keeps its no-network guarantee, and SSRF enforcement stays in one egress point.

Open questions for S0: whether `pi-ai` can target the broker's `inference.messages` or `inference.responses` shapes, or whether the OpenAI-compatible managed route needs a new broker action; whether 1 GiB and 200% CPU fit a Pi worker carrying image context; and how a worker that outlives a gateway restart reattaches to the broker. If the scope runtime cannot host Pi, the spike report must say why, and any replacement must reuse the same profile, supervisor, and broker protocol instead of adding a parallel service. A workload surviving gateway restart does not make gateway-hosted tools continuously available: persist blocked tool dispatch and resume after revalidation, without replaying uncertain effects.

Pi is the executor, not an autonomous authority. Each execution receives an immutable recipe/context revision, model/access source resolved by Provider V3, and server-issued capability references. No access grant may be inferred from role prose, skill text, tool arguments, or a group mention. Model suitability for images, tools, and long tasks is evaluated explicitly; do not assume the generic default is vision-capable.

### Runtime Decision Record

The spike decides which executor runs bot work and records the decision against these criteria with observed evidence, not documentation.

| Criterion | Pi core (candidate) | Hermes (current always-on agent) | Claude Agent SDK (kernel) |
|---|---|---|---|
| Access sources through Provider V3 | Multi-provider `pi-ai`; broker-backed inference unproven | Multi-provider | Anthropic models only; cannot serve the managed GLM default |
| Matrix owns loop, checkpoints, and tool dispatch | Library embedding; Matrix owns the loop | Separate agent process with its own session semantics | SDK owns the loop; Matrix resumes by session |
| Runs inside the scope-runtime profile | Unproven | Unproven | `claude-code` adapter already qualified |
| Memory, skills, scheduling | None; Matrix builds them on owner Postgres | Built in, in Hermes-owned state under `HERMES_HOME` | None beyond sessions |
| Release stability | Pre-1.0; 0.87.1 was the newest release on 2026-09-26, so pins under the seven-day package-age policy trail upstream | Pinned per host bundle | Stable V1 API |

Pi is the candidate because the kernel principle is model-agnostic routing, the managed default model is not an Anthropic model, and effect-unknown checkpoints require Matrix to own the loop. Hermes is the comparison baseline; this spec asserts no Hermes failure that has not been measured. A third runtime is a permanent maintenance cost, so the decision report must name which runtime Pi replaces for bot execution, or justify keeping all three.

### SDK, Tool Discovery, and Jev Qualifications

- Pi core and the coding SDK are different layers. `beforeToolCall` is a core hook; coding extensions expose a `tool_call` blocking hook. Verify the selected pinned API rather than mixing signatures. Session entry import/reconstruction must preserve tool-call/result pairing, compaction and branch state; do not assume `SessionManager.inMemory(entries)` is a supported API or that transcript replay restores a suspended JavaScript call.
- Use bounded integration search/describe/call discovery or activate selected typed tools lazily. The broker validates the resolved action schema, account, grants, and audience even when the model sees one proxy tool. Compare model accuracy and context cost before deciding a single proxy always wins. Do not carry forward an unmeasured fixed MCP token-cost claim.
- Pi hooks are useful policy interception points, not a complete effects sandbox. A permitted bash command or browser click can contain side effects beyond its label. Apply enforcement at credential/network/filesystem boundaries and gate consequential UI operations; record attempted, denied, approved, and observed effects with access-controlled audit retention.
- Jev's candidate can expose only its preview tool, but it must retain owner/account binding, admission policy, immutable tool definitions, no ambient extensions, and inaccessible broader credentials. Remove Hermes-specific profiles/pins only after replacement authority and negative tests pass. Retain version pinning and runtime qualification for Pi itself.
- Basic role/preferences and group-scoped memory are required in the first vertical slice. A temporary spawned subagent is not a saved bot participant: stable identity, memberships, independent direct chats, and durable handoffs need Matrix state.

## State Ownership and Atomicity

- Files remain authoritative for bot identity/configuration and authored skills, using existing paths, atomic writes, revision checks, and owner locks.
- Owner-controlled Postgres/Kysely owns runs/events, onboarding waits, participants, grants, handoffs, runtime memory, checkpoints, approvals, and outbox work. Derived UI summaries are projections.
- Instantiation reserves an operation keyed by `(owner, clientRequestId)` in a transaction. That operation fixes bot/chat IDs and a creation-payload hash. Concurrent retries return the same operation; conflicting payloads reject. An owner lock serializes the exclusive file create. Chat, bot binding, and activation commit together in a subsequent transaction after the file exists.
- Filesystem and database changes are not one atomic transaction. A crash may leave a reserved operation or definition file without an active chat. Both are explicitly recoverable; neither is dispatched. Startup and periodic reconciliation complete the reserved operation or show a recoverable failure using its fixed IDs. Never delete an existing edited bot to repair an orphan.
- Related database writes, event publication outbox records, and capacity reservations share a transaction. Enforce optimistic revisions in UPDATE predicates or row locks; use unique constraints and ON CONFLICT for logical singleton creation.
- One task has one coordinator; each handoff has a unique parent/recipient/request identity, a budget reservation, and an outbox record. Membership and grants are rechecked before dispatch and before publishing results.
- Checkpoints distinguish prepared, dispatched, observed-complete, and effect-unknown. A lost response to an external mutation is not permission to replay it. Query remote state or request human resolution; do not promise exactly-once external execution.
- Durable approvals bind owner, bot, run, tool, normalized arguments, account, recipient/audience, expiry, and policy revision. Approval claims are transactional and invalidated by changed arguments or revoked authority.

## Conversational Setup and Collaboration

Use canonical message parts for questions, account choices, connection requests, approvals, and results. A connection request is an inspectable persistent interaction, not an ephemeral text link. A question blocks only its dependent task; optional missing integrations leave independent work runnable. Record deferred/declined dependencies so the bot does not nag.

The broker creates owner-bound OAuth state and an allowlisted return destination. A browser return never proves connection success: re-read the broker's authoritative account state, correlate the pending interaction, and atomically enqueue at most one continuation. If offline, the next authorized chat read reconciles completion. Provider callbacks remain platform-owned.

Direct-chat memory is private by default. Group contexts contain group-visible history plus explicitly granted source material; a bot joining a group does not load its private transcript or private memory. Private source retrieval for a group task requires an output-audience grant before the result can enter the group's model context. Authorization must cover the destination as well as the source. A policy check on final text alone cannot undo an earlier private-context leak.

Group membership is not authority to impersonate the owner. Existing editor/viewer roles continue to govern prompting; only the account owner or explicitly delegated grant administrator can extend service authority. Model-generated handoffs carry capability subsets and never create new grants. Unaddressed group requests choose a coordinator deterministically from persisted group configuration and expose that choice; no broadcast-to-all default.

Bot messages are not automatic prompts to every other bot. Only an explicit addressed assignment or authorized handoff activates another worker. Parent-task cancellation propagates to descendants, revokes pending dispatch, and retains leases until worker exit is confirmed. Human discussion remains a non-triggering path under existing collaboration semantics.

Group bots keep the one-run-per-Chat queue instead of adding parallel execution sessions to a Chat. At most one bot run posts into a group Chat at a time. Delegated work runs as a child task bound to the parent task, not in the recipient bot's private direct chat, and posts its attributed result back through the group's queue. Whether canonical Chat can host task-scoped runs or needs a task conversation type is a Spike B question. Whether a guest may address a bot follows the resource's guest AI permission and the owner's access-source limits. Addressing a bot never extends the bot's service grants to the guest, and guest-requested bot work cannot use authority broader than the guest's resource permission. If guest collaboration changes these rules before implementation, this design follows it.

### Authority View

A bot's description of its own access is model output and is not authoritative. Each bot has a read-only view rendered from server state: connected accounts and grants (service, owner-visible account label, actions, audience, expiry), active routines, pending interactions, and remembered items with provenance. It applies the `ChatContextReceipt.tsx` principle of rendering admitted server state, but reads current state rather than one run's snapshot. Changes still happen through conversation and the grant service. The view may offer revocation, which only reduces authority, and it is not a configuration form. Group members see only the group-visible subset.

## Memory Model

- **Kinds**: preferences (scoped instructions such as "keep it short"), facts (owner-supplied or source-derived statements with a source reference), and episodes (summaries of completed tasks with artifact links).
- **Record**: each item stores kind, scope (bot-private, conversation, or group with an audience grant), provenance (message or source reference and time), revision, and optional expiry, in owner Postgres. Export writes owner files.
- **Writes**: the bot proposes writes through a broker memory tool; the gateway validates scope and persists them. An owner-stated preference is written on acknowledgment and appears as a visible remembered-item message part. Content from emails, pages, or tool results cannot create a standing preference or fact without owner confirmation, which blocks persistent prompt injection.
- **Retrieval**: bounded per run. Preferences for the bot and conversation are always admitted; facts and episodes are admitted by relevance within a token budget. Group runs retrieve only group-scoped items plus explicitly granted items.
- **Correct and forget**: a correction creates a new revision; forgetting removes the item from future admission and marks derived summaries or compactions that cite it for regeneration.

## Model Access, Funding, and Concurrency

- Each run resolves one access source through Provider V3 and records it with the run.
- On Matrix AI usage-mode routes the owner has one funded request in flight. The bot scheduler queues model turns across the owner's bots for that slot instead of surfacing `rate_limited` as task failure, and queued turns show a waiting state. Interactive owner turns take precedence over background bot work. Own-account access sources may use the per-owner worker limit concurrently.
- Group handoffs on a funded route therefore alternate model turns. The active-work deadline excludes queue wait; a separate queue-wait bound ends in a truthful blocked state.
- Computer use needs a vision-capable model with reliable coordinate grounding. The managed GLM default is not assumed to qualify. The spike selects one explicitly vision-capable access source and records per-step and per-task cost. Before computer use runs on funded credit, the owner sees the cost basis; starter credit is not assumed to cover computer-use tasks.
- Task currency budgets use the same reservation path as other funded requests; there is no parallel accounting.

## Computer and Tool Boundaries

A typed capability service exposes integrations/MCP, browser, desktop, bounded files/commands, artifact generation, and handoffs. Reuse existing business services through dependency injection rather than reproducing them per harness.

- Prefer structured APIs where supported, browser accessibility/DOM next, visual desktop actions where required. All paths must reach the same authorization policy.
- Images must reach a vision-capable model as bounded image content, not just local file paths. Record viewport and coordinate transforms and reject actions referring to stale observations.
- Run the persistent graphical session in the computer service described above, with a visible user takeover path. The spike must prove a real screenshot/action/observation loop outside DOM-only browser automation.
- Measure capacity before admitting sessions. The spike records resident memory and CPU for one session (display server, window manager, Chromium) alongside the gateway, shell, Postgres, and Hermes on the smallest supported plan, and states whether computer use needs a larger plan or a separate machine. Until measured, admit one graphical session per owner.
- One mutating controller owns each desktop session. Leases use fencing generations, so a stale worker cannot click after takeover or reacquisition. User takeover pauses queued agent actions until control is explicitly returned.
- Browser profiles and cookies are owner-private. Do not run concurrent Chromium instances against the same userDataDir or casually copy cookie databases. Initially serialize access to a profile; later profile/screen concurrency requires its own proof.
- A worker must not read gateway/platform credentials, DB connections, control sockets, or unrelated account profiles. A child process and cwd are not a sandbox. Qualify an OS-enforced user/mount/network boundary before enabling shell or code tools; sanitized environment variables alone are insufficient.
- Browser navigation and all requests/redirects/downloads require SSRF controls. Existing DNS preflight has residual rebinding risk; production acceptance requires pinned/filtered egress that also covers browser subresources and command execution. Reject redirects unless revalidated. No cloud metadata access.
- For UI sites whose consequential actions cannot be intercepted reliably, use a restricted session or user takeover at the commit step. Do not claim a prompt-only “ask before sending” rule enforces read-only access.

## Security Architecture

### Proposed Transport/Auth Matrix

These are proposed contracts for planning, not routes added by this PR. Existing route families retain their current principal middleware. The implementation plan must enumerate final mounted paths before code lands.

| Route or boundary | Authentication and authorization | Public? |
|---|---|---|
| Existing GET `/api/chat-agents`, `/api/chat-agents/recipe-catalog` | Authenticated Matrix principal; owner-scoped definitions; public catalogue metadata carries no private account data | No |
| Proposed POST `/api/chat-agents/instantiate` | Authenticated owner; recipe version and idempotency validation; server chooses IDs and approved runtime | No |
| Existing PATCH `/api/chat-agents/:agentId` | Authenticated owner; write-time revision check; conversational changes use this same authority | No |
| Existing POST `/api/chats`, POST `/api/chats/:chatId/turns`, GET `/api/chats/:chatId` | Existing owner/shared-session principal and role policy; bot identity cannot substitute for a human principal | No |
| Proposed GET/POST/DELETE `/api/chats/:chatId/bot-participants[/:botId]` | Session membership for reads; authorized session manager plus bot-owner consent for mutations; reject conflicting scope | No |
| Proposed POST `/api/chats/:chatId/interactions/:interactionId/resolve` | Exact authorized responder; bound bot/task/account/audience; transactional claim; reject expired or replayed response | No |
| Existing POST `/api/chats/:chatId/runs/:runId/inputs/:requestId`, `/approvals/:approvalId`, `/cancel`, `/steer` | Existing authenticated run controls with current owner/role checks; approval is scoped to the effect | No |
| Existing `/api/integrations` inventory and POST `/connect`, `/call` | Owner principal and broker policy; new bot calls additionally require task/account/action/audience capability | No |
| Existing integration connected webhook | Broker's verified HMAC and bounded payload, external account mapped server-side; no user-supplied owner authority | Signature-authenticated |
| Proposed POST `/api/bot-computers/:computerId/control` | Owner or explicitly authorized controller; action union, observation ID, fencing generation | No |
| Proposed WS `/api/bot-computers/:computerId/stream` | Authenticated browser-compatible query-token allowlist entry; owner/session membership and origin checks; short-lived scoped token redacted from logs | No |
| Proposed GET `/api/chat-agents/:agentId/authority` | Authenticated owner, or session member for the group-visible subset; returns grants, routines, pending interactions, and memory metadata; no credentials or account identifiers beyond owner-visible labels | No |
| Scope-runtime broker socket / tool dispatch | Existing broker authentication; run-bound expiring capabilities bound at admission; the worker has no network, credentials, or broad gateway bearer | No |
| Computer service control (broker-internal) | Reached only from the broker with a run capability, observation ID, and fencing generation; never exposed to workers directly | No |

Read projections exclude credentials, private account metadata, and inaccessible artifacts. Validate path/query/body/WS/IPC values using bounded schemas, including action discriminants, identities, revisions, URLs, paths, pagination, and cursor sizes. Apply bodyLimit to all mutations including DELETE. Explicit CORS origin allowlist; no wildcard. Generic client errors with allowlisted client-store messages; detailed redacted server diagnostics. Missing dependencies return unavailable/503, not false not-found. No raw Response throws from services.

### Data Sent Outside the Owner Runtime

The selected model receives only admitted task context, bounded tool results, and necessary screenshots. Integration calls send only their scoped action payloads through the existing platform broker. Browser requests go to user-authorized destinations. Screenshots, cookies, provider tokens, private messages, and customer identifiers do not belong in public spike evidence. Group visibility grants do not authorize public publication.

## Integration Wiring and Startup

Candidate modules are new small services; names below describe intended responsibilities, not existing APIs.

1. Open the existing owner DB resource, initialize migrations, and bootstrap the existing bot definition store.
2. Initialize bot-operation reconciliation, task/event/outbox repositories, grant policy, and pending-interaction service using that shared DB. Only the DB owner closes it.
3. Connect the integration broker client and Provider V3 resolver; register capabilities only when their dependencies are present. Surface missing optional capabilities without claiming readiness.
4. Initialize the computer service client, egress policy, screenshot store, controller leases, and the scope-runtime supervisor client. Reconcile running workloads and expired leases before dispatch.
5. Register the Pi adapter with scope-runtime eligibility and the canonical run pipeline; inject repositories, tool services, policy, memory, funding-slot scheduler, and event sink. Bridge Pi schema types behind Zod contracts; never use globalThis.
6. Mount authenticated HTTP/WS controls and shared UI clients; start bounded outbox dispatch and recurring cleanup last.
7. Shutdown stops admission, drains/clears subscribers, stops dispatch, persists pending controls, then detaches only durably supervised workers or confirms termination. Preserve uncertain worker/resource ownership. Close owned services and DB last.

## Resource Limits and Failure Modes

Proposed spike limits are enforced server-side and adjustable only through validated operator configuration. Production sizing follows measurement; no unbounded defaults.

| Resource | Initial bound and recovery policy |
|---|---|
| Bots | Existing 100 per owner; archive does not silently erase history |
| Workers/group | Two concurrent workers per owner where the access source permits concurrency; on Matrix AI usage-mode routes model turns queue for the owner's single funded slot, with a 10-minute queue-wait bound; max two bots in spike group; production admission cap initially eight bots/group |
| Task tree | 12 handoffs, depth 3, 60 tool actions, 10-minute active-work deadline, and separately enforced shared token/currency budget; all descendants charge the same parent budget |
| Pending interactions | 32 per owner; one blocking question per task; 24-hour expiry persisted; OAuth pending state at most 15 minutes; expired waits release active workers |
| Tool/network calls | API 10s, browser/download 30s, bounded command 60s; caller cancellation plus AbortSignal timeout; at most two retries for proven idempotent transient failures |
| Desktop/profile lease | One controller/profile; 30s lease renewed every 10s; fencing after expiry or takeover; one graphical session per owner until capacity is measured, with more sessions gated on a documented plan size |
| Memory | 2,000 items per bot and 4 KiB per item; 2K-token admitted memory budget per run initially; episodes summarize before eviction; preferences are never evicted silently, and reaching the cap asks the owner to consolidate |
| Events | Durable paging; 256 KiB control payload limit or tighter existing route limit; max 256 queued outbound events/subscriber and 64 subscribers/owner; disconnect slow clients and resume by cursor |
| Context | System prompt under 7K tokens; existing 24 KiB admitted skill budget retained initially; lazy capability loading with immutable version/hash references; retain every declared requirement even when only relevant skill bodies are loaded |
| Screenshots | At most 2 MiB encoded/frame and 100 MiB temporary evidence/owner; 24h TTL and five-minute symlink-safe recurring sweep; no live screenshot cache beyond two frames/session |
| Temporary files/logs | Private exclusive files, 24h TTL, 100 MiB total temp cap/owner and 10 MiB rotated log cap/worker; cleanup on exit plus recurring lstat-based sweep; authored user artifacts require explicit deletion |
| In-memory registries | Bounds inherited from worker/control/subscriber/session limits; TTL sweep before admission; evict associated listeners/timers and drain on shutdown |

Failure handling must cover connection timeout/revocation, worker crash, gateway restart, unavailable model/funds, DB transaction failure, stale edits, repeated OAuth callback, control takeover, blocked egress, orphaned definitions, artifact write failure, and uncertain remote effects. Never reinterpret infrastructure failure as empty data. REST changes notify realtime subscribers only after commit; failing senders are evicted without blocking delivery to others.

## Rollout and Migration

Keep the existing Pi coding adapter and Hermes behavior available during qualification. Introduce the candidate through the canonical adapter and Provider V3, with explicit bot capability eligibility; do not relabel Pi as Hermes to pass the current driver checks. Preserve existing IDs, file definitions, revisions, selected accounts/models, and canonical history. Old native Hermes checkpoints remain with Hermes; switching execution creates an explicit new runtime session from authorized canonical context. No automatic credential or browser-cookie migration.

Keep conversation, participant, grant, memory, and approval models independent of the Matrix Chat surface so a later milestone can host a bot conversation in a messaging channel with the same bot identity. A channel approval must show the exact proposal or deep-link to Matrix; a channel reply cannot approve an effect the channel did not display.

Use normal VPS-native host bundles for test deployment; no Docker-based customer rollout or bundle copying. Spike qualification occurs on a disposable test VPS, never by changing the owner's main machine. Before paid provisioning, record the selected plan, lifetime, and cost ceiling; use an existing authorized disposable host when available. At the end, ask the owner whether to delete a newly created test VPS. Local-only fixture tests are supplemental evidence.

## Research References and Verification Boundary

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview): named persistent agents, shared computer, coordination, and demonstrations.
- [Grok Bot skills/routines](https://docs.x.ai/grok-bot/skills-routines-and-automations): reusable methods and explicit triggers.
- [Muse announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/): persistent personal computer, progressive context, background action, approval.
- [Pi core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) and [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md): integration candidates. Branch documentation is mutable; pin exact tested versions in the spike.
- [Existing Pi probe](../126-provider-input/research/providers.md): v0.81.0 RPC dialog probe and historical companion-package mismatch; not proof of the proposed core runtime.
- [Marketplace research](../121-chat-agent-templates/xai-marketplace-research.md): metadata provenance; retained historical hashes do not prove prompt equivalence.

These sources inform requirements. This specification claims no measured Grokbot/Muse equivalence or verified Pi durability. The requested spec-first order preserves the constitution's experimental-verification intent by postponing binding SDK choices until the spike report.

## Review of the Alternative SDK Proposal (2026-09-26)

Adopt the separate supervised boundary (realized through the existing scope runtime; see Execution Boundary), canonical adapter, brokered credentials, bounded lazy tool discovery, durable approvals, and pinned-runtime ideas. Keep the exact internal driver identifier provisional until Provider V3 and canonical schemas are planned; adding a string to isChatAgentDriver alone is insufficient.

Correct three factual shortcuts: Matrix already has a cron service; its Pi adapter loads an explicit Matrix-owned ask_user extension while disabling ambient extensions; Hermes currently forces session yolo but also has an approval bridge, so yolo does not establish that every Matrix/broker approval is absent. Interim/final text consistency checks are observable failure paths, not a measured explanation of every Hermes failure.

Grok Bot documents Enterprise audit logs and separate Action Recording, so do not claim an across-the-board lack of auditability. Its per-user shared computer/logins are documented; finer bot-scoped authority is a design objective to prove, not an established competitive win. Meta documents a separate Sentinel and secure credential storage; our broker token alone does not reproduce that egress boundary. Sources: [Grok Bot security FAQ](https://docs.x.ai/grok-bot/security-faq), [Muse announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/).

Keep the requested spec-first sequence. Follow publication with a tiny package/API probe (S0) before the staged spikes. Include basic memory, named-bot group collaboration, visual computer use, and one durable wakeup in feasibility testing instead of postponing them behind a generic single-agent assistant. Production scheduling breadth, learning, and full catalogue migration remain later work. `docs/dev/coding-agent-shells.md` still describes the old Pi print transport; its correction belongs in the subsequent runtime documentation change, not evidence that the current RPC bridge is missing.
