# Data Model: Conversational Recipe Bots

Phase 1 output for [plan.md](plan.md). Owner tables live in the owner-controlled Postgres used by the gateway and are created by versioned migrations (`bot_schema_migrations`, one transaction per version; see research R6). Platform tables live in platform Postgres (research R10). Bot definitions remain files written by `packages/gateway/src/chat/agent-store.ts`.

Common rules:

- IDs are server-generated. Clients never choose a bot, chat, task, interaction, grant, or memory ID. The one exception is `clientRequestId`, an idempotency key.
- Every mutable row has `revision bigint`, enforced in the `UPDATE ... WHERE revision = :base` predicate.
- `owner_id` is on every owner row and in every unique index, so one owner's rows never collide with or reveal another's.
- Text columns carry the byte bounds listed below, enforced by Zod at the route or broker boundary and by `CHECK (octet_length(...) <= n)` in DDL.
- Soft-deleted or forgotten rows are excluded from normal reads. Deletes filter `deleted_at IS NULL` or `forgotten_at IS NULL`.

## Existing (unchanged ownership)

| Entity | Store | Notes |
|---|---|---|
| Bot definition | `agents/custom/chat-bots/<sha256(owner)>/bot_<id>.md` | JSON header plus instructions; owner lock table `chat_agent_owner_locks`; 100 per owner; revision-checked. Adds `runtime: "matrix_bot"` in the stored selection and a server-owned `recipeRef {recipeId, version}`. |
| Chat, message, turn, run, run event, outbox | `chats`, `chat_messages`, `chat_turns`, `chat_runs`, `chat_run_events`, `chat_outbox` | Bot-authored messages set `actor_id = bot_<id>`. Bot runs use `driver_kind = matrix_bot`. |

## Owner tables (gateway, versioned migrations)

### `bot_operations` (M1)

Reserves idempotent bot creation.

| Column | Type | Rules |
|---|---|---|
| owner_id | text | PK part |
| client_request_id | text | PK part; `CanonicalChatRequestIdSchema` (`req_...`), matching the API |
| bot_id | text | unique; `^bot_[A-Za-z0-9_-]{8,64}$` |
| chat_id | text | unique; fixed at reservation |
| workspace_rel_path | text | `bots/<botId>`; derived server-side |
| payload_hash | text | sha256 of the normalized creation request |
| status | text | `reserved` → `file_created` → `active`; or `failed_recoverable` |
| created_at, updated_at | timestamptz | |

State transitions:

- `reserved` (transaction 1) → `file_created` (after the exclusive file and workspace create under the owner lock) → `active` (transaction 2 commits the chat, `bot_chat_bindings`, and activation).
- Any step may fail to `failed_recoverable`. Startup and periodic reconciliation retry with the same IDs.
- A retry with the same payload hash returns the operation. A different hash returns `409 conflict`.

### `bot_chat_bindings` (M1)

| Column | Type | Rules |
|---|---|---|
| owner_id, bot_id, chat_id | text | PK `(owner_id, bot_id, chat_id)` |
| kind | text | `direct` or `group` |
| created_at, removed_at | timestamptz | |

Partial unique index `(owner_id, bot_id) WHERE kind = 'direct' AND removed_at IS NULL`: one live direct chat per bot.

### `bot_agent_sessions` (M1)

| Column | Type | Rules |
|---|---|---|
| session_id | text | PK |
| owner_id, bot_id, chat_id | text | unique `(owner_id, bot_id, chat_id)` |
| messages | jsonb | Pi `AgentMessage[]`, including `system` entries; ≤512 KiB |
| compacted_through_seq | bigint | canonical message sequence covered by the compaction summary |
| token_estimate | integer | |
| runtime_versions | jsonb | exact Pi versions and the bot-runtime bundle digest |
| revision | bigint | |
| updated_at | timestamptz | |

When `messages` would exceed 512 KiB, the worker compacts before continuing. Compaction output replaces older entries in one revision-checked update.

### `bot_tasks` (M1; handoff columns M3)

| Column | Type | Rules |
|---|---|---|
| task_id | text | PK |
| owner_id, bot_id, chat_id | text | |
| parent_task_id | text | nullable; FK to `bot_tasks` |
| coordinator_bot_id | text | M3 |
| status | text | `queued`, `running`, `waiting_person`, `waiting_capacity`, `blocked`, `completed`, `failed`, `cancelled` |
| run_id | text | current canonical run |
| budget | jsonb | `{handoffs, depth, toolActions, microUsd}` used against caps (12, 3, 60, owner cap) |
| active_ms | bigint | excludes person and capacity waits; deadline 600000 |
| blocked_reason | text | allowlisted code |
| revision, created_at, updated_at | | |

Transitions:

- `queued` → `running` → `completed` | `failed` | `cancelled`.
- `running` ⇄ `waiting_person` (pending blocking interaction).
- `running` ⇄ `waiting_capacity` (funded queue).
- `running` → `blocked` (missing root, revoked grant, budget reached, unavailable tool). Blocked tasks resume only after revalidation.
- Cancelling a parent cascades to descendants in one transaction.

### `bot_tool_checkpoints` (M1)

| Column | Type | Rules |
|---|---|---|
| checkpoint_id | text | PK |
| owner_id, task_id, run_id | text | |
| tool_call_id | text | unique `(run_id, tool_call_id)` |
| action | jsonb | normalized capability, target, and argument hash; no secrets |
| effect_class | text | `read`, `write`, `send`, `computer` |
| phase | text | `prepared` → `dispatched` → `observed_complete`; or `effect_unknown` |
| outcome_ref | text | provider receipt or artifact ID when known |
| created_at, updated_at | timestamptz | |

After a crash, reconciliation marks `dispatched` rows with no outcome as `effect_unknown`. Those are never replayed automatically. A `read` action proven idempotent may be retried at most twice.

### `bot_interactions` (M1)

| Column | Type | Rules |
|---|---|---|
| interaction_id | text | PK |
| owner_id, bot_id, chat_id, task_id | text | |
| kind | text | `question`, `account_choice`, `connect_request`, `approval`, `takeover` (M4) |
| payload | jsonb | discriminated by kind; ≤16 KiB |
| responder_actor_id | text | exact authorized responder |
| blocking | boolean | |
| status | text | `pending` → `resolved` or `expired` or `cancelled` |
| resolution | jsonb | ≤16 KiB |
| expires_at | timestamptz | ≤24 h; connect requests ≤15 min |
| revision, created_at, resolved_at | | |

Constraints:

- Partial unique index `(owner_id, task_id) WHERE blocking AND status = 'pending'`: one blocking question per task.
- At most 32 pending interactions per owner, counted inside the insert transaction under the owner row lock.
- Resolution claims the row with `WHERE status = 'pending' AND revision = :base` and stores continuation text in the same transaction. Canonical admission uses `req_answer_<interactionId>` and sets `continuationAdmittedAt` only after admission succeeds. A bounded background pass retries due, unacknowledged answers (questions, account choices, approvals, and connection outcomes), including when integrations are absent. Failed admissions defer 60 seconds; canonical queue deduplication verifies owner and request hash before acknowledging a restarted attempt.

Payload schemas (Zod, in contracts):

- `question`: `UserInputQuestionListSchema` bounds.
- `account_choice`: `{service, options: [{connectionId, label}] ≤10}`.
- `connect_request`: `{service, access: ("read"|"write"|"send")[], benefit ≤280 chars, connectRequestId}`.
- `approval`: `{tool, normalizedArgs, account, audience, preview ≤4 KiB, policyRevision}`.

### `bot_connect_requests` (M1)

| Column | Type | Rules |
|---|---|---|
| request_id | text | PK |
| owner_id, interaction_id | text | unique `interaction_id` |
| service | text | registry slug |
| requested_at, expires_at | timestamptz | ≤15 min |
| baseline_connection_ids | jsonb | connection IDs of this service at request time |
| status | text | `pending` → `completed` or `ambiguous` or `cancelled` or `expired` |
| completed_connection_id | text | |

Reconciliation reads the inventory and compares new connection IDs with the baseline:

- exactly one new ID: `completed`
- more than one: `ambiguous`, which creates an `account_choice` interaction
- none by expiry: `expired`

Each outcome enqueues at most one continuation.

### `bot_grants` (M1)

| Column | Type | Rules |
|---|---|---|
| grant_id | text | PK |
| owner_id, bot_id | text | |
| service, connection_id, account_label | text | connection resolved server-side |
| effects | text[] | subset of `read`, `write`, `send` |
| audience | text | `direct` or `group:<chatId>` (M3) |
| granted_by_actor_id | text | owner, or delegated grant administrator |
| expires_at, revoked_at | timestamptz | |
| revision, created_at | | |

Partial unique index `(owner_id, bot_id, service, connection_id, audience) WHERE revoked_at IS NULL`.

Grant checks happen at the broker, before dispatch and before any result is published. Revocation takes effect for the next checkpoint.

### `bot_approvals` (M1)

| Column | Type | Rules |
|---|---|---|
| approval_id | text | PK; same as the interaction ID |
| owner_id, bot_id, run_id | text | |
| tool, args_hash, account, audience | text | normalized binding |
| policy_revision | bigint | |
| status | text | `pending` → `approved` or `denied` or `expired` or `invalidated` |
| claimed_at, expires_at | timestamptz | |

A claim is transactional. Changed arguments, audience, or policy revision set `invalidated`.

### `bot_memory_items` (M1)

| Column | Type | Rules |
|---|---|---|
| item_id | text | PK |
| owner_id, bot_id | text | |
| kind | text | `preference`, `fact`, `episode` |
| scope | text | `bot`, `chat:<chatId>`, `group:<chatId>` (M3) |
| content | text | ≤4 KiB |
| content_tsv | tsvector | generated |
| source | jsonb | `{messageId?, url?, at}` |
| confirmed | boolean | false until the owner confirms externally sourced items |
| revision, created_at, updated_at | | |
| expires_at, forgotten_at | timestamptz | |

Limits and admission:

- At most 2,000 live items per bot, checked in the insert transaction. Episodes are summarized before eviction; preferences are never evicted silently.
- Unconfirmed items are never admitted into context.
- Forgetting sets `forgotten_at` and marks the bot’s `bot_agent_sessions` for regeneration (`needs_recompaction`). Each forget advances the session revision, including a second forget while regeneration is pending. Until per-message memory provenance supports selective rebuilding, the broker withholds the whole invalidated model transcript. The next turn starts with the current prompt and only live admitted memory, then clears invalidation through a revision-checked fresh save. Visible Chat history remains available to its owner; the bot does not reuse it as context after forgetting.

### `bot_routines` and `bot_routine_fires` (M2)

| Column | Type | Rules |
|---|---|---|
| routine_id | text | PK |
| owner_id, bot_id, chat_id | text | delivery conversation |
| schedule | jsonb | `{kind: "cron", expr, tz}` or `{kind: "once", at, tz}`; IANA tz validated |
| authorized_effects | text[] | snapshot of grants required at activation |
| status | text | `active` or `paused` or `archived` |
| next_fire_at | timestamptz | |
| revision | bigint | |

`bot_routine_fires (routine_id, scheduled_for)` is the PK, inserted with `ON CONFLICT DO NOTHING`. The fire claim and the task insert happen in one transaction. A missed fire after downtime runs once, not once per missed tick.

### `bot_participants` and `bot_handoffs` (M3)

- `bot_participants (owner_id, chat_id, bot_id, added_by_actor_id, is_coordinator, added_at, removed_at)`: at most 8 live participants per chat, and one coordinator per chat (partial unique index).
- `bot_handoffs (handoff_id, owner_id, parent_task_id, child_task_id, from_bot_id, to_bot_id, request_id unique, capability_subset jsonb, status)`: the subset must be contained in the parent's capability set (checked in the insert transaction). Depth is at most 3 and at most 12 per task tree.

### `bot_computer_sessions` (M4)

`bot_computer_sessions (computer_id, owner_id, profile_name, controller_kind (bot|person), controller_id, lease_generation bigint, lease_expires_at, status)`:

- A lease is acquired with `UPDATE ... WHERE lease_expires_at < now() OR controller_id = :self`, and each acquisition increments `lease_generation`.
- Actions carry the generation and are rejected if it is stale.
- There is at most one session per owner until capacity is measured.

## Platform tables (R10)

### `ai_runtime_credentials` (altered)

Add `request_class text NOT NULL DEFAULT 'interactive' CHECK (request_class IN ('interactive','background'))`. Issuance cooldown is keyed per `(machine_id, runtime_slot, request_class)`.

### `ai_funded_priority_claims` (new)

| Column | Type | Rules |
|---|---|---|
| owner_id | text | PK part |
| machine_id | text | PK part; from the stored credential |
| runtime_slot | text | PK part; from the stored credential |
| claim_key | text | PK part; default `''`; gateway-supplied turn identity (`^[A-Za-z0-9_.:-]{1,128}$`) forwarded by the relay |
| billing_mode | text | `usage` or `hold`; decides which requests the claim holds |
| created_at, expires_at | timestamptz | expiry ≤2 min; never extended by a conflicting upsert |

Written and consumed only inside `authorize`, under the owner advisory lock. The key is the runtime slot plus the gateway's turn claim key, so claims survive relay retries (new request IDs) and lease rotation, and distinct turns on one runtime keep their own order. Claim-bearing rejections commit through a typed outcome rather than a throw. There are at most 16 live claims per owner. Expired claims are deleted by the existing reservation cleanup worker.

## Relationships

```text
Bot definition (file) 1─1 bot_operations (creation)
Bot 1─1 direct chat (bot_chat_bindings kind=direct) ─ canonical chats
Bot 1─N bot_agent_sessions (one per chat)
Bot 1─N bot_tasks 1─N bot_tool_checkpoints
bot_tasks 1─N bot_interactions ─0..1 bot_connect_requests / bot_approvals
Bot 1─N bot_grants; Bot 1─N bot_memory_items; Bot 1─N bot_routines 1─N bot_routine_fires
Shared chat 1─N bot_participants; bot_tasks 1─N bot_handoffs (parent→child)
Owner 1─N ai_funded_priority_claims (platform)
```

Cancellation settlement: exact owner/request/hash canonical queue lookup distinguishes owner-cancelled answers from conflicts. Recovery records `continuationCancelledAt` and stops retries without re-enqueueing; mismatched content or ownership never settles the answer. Queue-admission extraction remains the planned decomposition of the large Chat repository; this change only adds the typed cancellation outcome to the existing lookup.
