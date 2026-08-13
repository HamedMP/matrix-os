# Provider-Neutral Chat Architecture and Owner-Owned Persistence

**Linear issue:** MAT-319
**Created:** 2026-08-13
**Status:** Proposed for architecture review
**Scope:** Canonical contracts, persistence, migration, and implementation sequencing
**Related delivery:** MAT-299 and MAT-318 remain independent

## Purpose

Matrix OS needs one durable user-facing Chat abstraction. A Chat is the task the
user returns to, shares, searches, exports, or deletes. Hermes, OpenClaw, Codex,
Pi, OpenCode, and future execution systems are harness adapters that run work
inside a Chat; they are not Chat identities or Chat types. Models are selected
through capability-aware model plugins and are not part of Chat identity.

The canonical Chat record and all relational Chat state live in the owner's
PostgreSQL database on the user's Matrix computer/VPS through Kysely. Project
code and `ProjectConfig` stay in owner-controlled files. Chat links to a project
only by the immutable `ProjectConfig.id`.

This specification records the public seams before implementation. It does not
authorize a broad migration in this PR.

## Non-goals

- Implementing the PostgreSQL repository, migration, adapters, or shell UI in
  this architecture PR.
- Expanding MAT-299's current Hermes lifecycle PR or MAT-318's project-context
  implementation.
- Platform-owned storage of owner Chat content.
- Translating provider-native session formats between harnesses.
- Voice, multi-repository project UX, branch switching, or worktree-management
  UI.
- Files CRUD or any MAT-268 behavior, dependency, or issue relation.
- Merge or release operations.

## Current-state audit

| Area | Current source of truth | Useful seam | Gap to close |
|---|---|---|---|
| Gateway kernel conversations | `packages/gateway/src/conversations.ts` writes synchronous `system/conversations/*.json` files | Existing list/get/create/delete/search and kernel session IDs | No owner scope, Kysely repository, transaction, turn/run model, strict persisted schema, or safe cross-shell event contract |
| Coding-agent threads | `packages/gateway/src/coding-agents/thread-store.ts` writes one bounded `system/coding-agents/threads.json` aggregate | Owner checks, turns, events, idempotent request IDs, shutdown recovery, bounded adapter events | Provider ID is part of thread identity; opaque resume state is embedded in the aggregate; whole-file serialization limits concurrency and migration |
| Harness/provider boundary | `provider-adapter.ts` and `provider-registry.ts` validate provider output and bound health/cache state | Adapter lifecycle, normalized events, timeouts, generic client errors | Catalog lacks a provider-neutral harness capability contract and independent model plugin registry |
| Desktop Chat | `useHermesChat`, `useThreads`, `useCodingAgentWorkspace`, and `unified-threads.ts` merge one Hermes transcript, renderer-memory kernel runs, and server coding-agent projections | Bounded serializable projections and runtime invalidation patterns | Renderer memory still determines local thread identity/history; one rail hides multiple incompatible durable sources |
| Browser Shell Chat | `useConversation.ts` lists through Gateway but reads transcript JSON through `/files` and refreshes from filesystem watcher events | Existing persistent conversation discovery and switch-session flow | File-path coupling bypasses a provider-neutral headless Chat contract |
| Owner PostgreSQL | Gateway creates one shared Kysely connection from the VPS-local `DATABASE_URL`; messaging and canvas inject it | Owner-local database lifecycle, migrations, transactions, shared shutdown | Chat has no typed repository or schema; it must reuse this Kysely owner and must not create or destroy another pool |
| Projects | `ProjectConfig` is an owner file and new configs receive immutable `proj_*` IDs | Stable file-backed identity and validated `localPath` | ProjectManager's public lookup is slug-addressed. Chat must resolve by immutable ID and owner scope without copying path/config into PostgreSQL |
| Cross-shell activity | Coding-agent projections publish bounded workspace events | Event projection pattern and shutdown hooks | Filesystem events are not a transactional Chat outbox and cannot guarantee replay/convergence |

The audit also incorporates two valid races reported on PR #1216: run admission
can overlap deletion, and run admission can overlap project-context mutation.
Both are resolved by one database admission boundary described below.

## Terminology and identity

### Chat

A Chat is a durable, owner-scoped task. Its immutable identity is `chatId`.
Neither `harnessId`, `modelId`, provider session ID, shell, channel, project
slug, nor filesystem path participates in Chat identity.

A Chat contains:

- lifecycle and title;
- owner scope and optional membership/collaboration state;
- optional immutable project ID;
- optional default harness and model preferences;
- canonical messages and attachment references;
- turns and one or more run attempts;
- attention, read, pinned, and shell projection state; and
- fork provenance when explicitly created from another Chat.

### Turn

A Turn is one accepted user action in a Chat. It owns the canonical user input,
an immutable `baseMessageSeq`, an idempotency key, and one or more Run attempts.
Only one Run may be active for a Chat at a time.

### Run

A Run is one execution attempt by exactly one harness with exactly one resolved
model selection. The Run records what was actually used, the bounded capability
snapshot, lifecycle timestamps, and canonical-history boundary. Provider-native
session/resume state is stored separately behind the owning harness adapter.

### Harness and model plugins

A harness adapter implements execution semantics for Hermes, OpenClaw, Codex,
Pi, OpenCode, or another runtime. A model plugin describes a selectable model
and its capabilities/credentials. A harness declares which model capabilities
it accepts. The orchestration layer resolves the pair; it never infers
compatibility from names.

## Non-negotiable invariants

1. Owner-local PostgreSQL is the only durable Chat source of truth after
   cutover. Platform PostgreSQL never stores owner transcript content.
2. Gateway/headless contracts are canonical. Shell stores are bounded caches
   and never create a persistence format.
3. `chatId` survives harness/model changes. Provider session IDs never replace,
   alias, or determine it.
4. A Run may resume only through the same `harnessId` and adapter-state schema
   version that created its resume state.
5. A harness change starts a new Run from canonical history or creates an
   explicit fork. Cross-harness resume is forbidden.
6. Project references use immutable `ProjectConfig.id`; slugs, paths, branches,
   and repository URLs are derived owner-file data.
7. Turn admission, context mutation, archive/delete, and active-run checks lock
   the same Chat row. No check-then-write race is allowed.
8. Multiple related writes and every outbox event are committed in one Kysely
   transaction. External harness/model calls occur outside the transaction.
9. Provider output, capability metadata, model metadata, and adapter state are
   strictly validated and bounded before persistence or renderer projection.
10. Raw provider, filesystem, database, credential, or path errors never reach
    clients. Detailed diagnostics stay in owner-controlled logs.

## Public contracts

The shared package will define strict Zod 4 schemas for these shapes. Names are
illustrative but normative in responsibility.

```ts
type OwnerScope =
  | { type: "personal"; ownerId: string }
  | { type: "organization"; ownerId: string };

interface ChatSummary {
  id: string;
  title: string;
  lifecycle: "active" | "archived";
  project?: ChatProjectProjection;
  defaultSelection?: ChatExecutionSelection;
  activeRun?: ChatRunProjection;
  attention: "none" | "approval_required" | "input_required" | "failed";
  lastMessagePreview: string;
  messageCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface ChatExecutionSelection {
  harnessId: string;
  modelId?: string;
}

interface ChatProjectProjection {
  projectId: string;
  name: string;
  kind: "scratch" | "github" | "folder";
  repositoryLabel?: string;
  status: "ready" | "unavailable";
}
```

The client never sends `OwnerScope`, a filesystem path, provider resume state,
provider credentials, repository URL, or runtime identity. Gateway derives
owner scope from the verified principal and resolves project/runtime state.

### Canonical messages

Messages are immutable in sequence and provider-neutral. `parts` is a strict,
bounded discriminated union: text, tool request/result, attachment reference,
approval request/result, structured status, and explicit summary. Provider raw
events and transport frames are not message parts.

User messages commit at Turn admission. Assistant/tool output begins as
`pending` and becomes `committed` when the Run reaches a valid terminal result.
Failed or interrupted partial output remains inspectable as `failed` Run output
but is excluded from future canonical history unless the user explicitly
promotes or quotes it. Canonical history therefore never silently treats a
failed provider stream as trusted context.

### Harness capability contract

```ts
interface HarnessDescriptor {
  id: string;
  displayName: string;
  adapterVersion: string;
  availability: "available" | "setup_required" | "auth_required" | "unavailable";
  workspaceRequirement: "none" | "project_optional" | "project_required";
  supports: {
    rootChat: boolean;
    resume: boolean;
    cancellation: boolean;
    attachments: readonly ChatAttachmentKind[];
    tools: readonly string[];
    approvals: boolean;
    userInput: boolean;
    worktrees: "none" | "optional" | "required";
  };
  acceptedModelCapabilities: readonly ModelCapability[];
  defaultModelId?: string;
}

interface ChatHarnessAdapter<State> {
  readonly id: string;
  describe(input: HarnessDescribeInput): Promise<HarnessDescriptor>;
  start(input: StartRunInput): AsyncIterable<NormalizedRunEvent>;
  resume?(input: ResumeRunInput<State>): AsyncIterable<NormalizedRunEvent>;
  cancel?(input: CancelRunInput<State>): Promise<void>;
  stateSchemaVersion: number;
  parseState(value: unknown): State;
  serializeState(value: State): unknown;
}
```

The adapter-state store exposes state only to the registered adapter whose ID
and schema version match the Run. Adapters must not place access tokens,
credentials, raw stderr, absolute paths, or unbounded transcripts in state.

### Model plugin contract

```ts
interface ModelDescriptor {
  id: string;
  displayName: string;
  availability: "available" | "auth_required" | "unavailable";
  capabilities: readonly ModelCapability[];
  contextWindow?: number;
  supportsVision: boolean;
  supportsToolUse: boolean;
}
```

The model registry resolves a model only when both plugin availability and
harness capability predicates pass. The Chat may store a preferred default;
each Run stores the resolved actual IDs. Removing a model plugin does not make
the Chat unreadable.

## Owner-local PostgreSQL model

The Chat repository receives the Gateway-owned `Kysely<OwnerDatabase>` used by
other owner-local services. It does not create a pool and does not call
`destroy()`; the Gateway closes the shared owner after Chat subscribers and
Run orchestration have drained.

| Table | Purpose and key invariants |
|---|---|
| `chats` | Immutable `id`; `owner_type + owner_id`; optional immutable `project_id`; lifecycle; title; default harness/model; fork provenance; `revision`; timestamps |
| `chat_members` | Collaboration principals and role (`owner`, `editor`, `viewer`); unique by Chat/principal; personal Chats still have one owner row |
| `chat_user_state` | Per-principal read cursor, pinned/muted state, attention acknowledgement, last-opened timestamp; serializable durable UI state |
| `chat_messages` | Per-Chat monotonic `seq`; role; strict parts JSONB; state; optional Turn/Run IDs; byte count; timestamps; unique `(chat_id, seq)` |
| `chat_attachments` | Owner-file/object references and safe metadata; never embeds arbitrary local paths or attachment bytes in renderer projections |
| `chat_turns` | User action, `base_message_seq`, input message, idempotency key, status, timestamps; unique `(chat_id, client_request_id)` |
| `chat_runs` | Attempt number, actual harness/model, capability snapshot, history boundary, status/outcome, timestamps; one active Run per Chat via a partial unique index |
| `chat_run_events` | Bounded normalized replay events for streaming, approvals, tool progress, and recovery; provider raw frames are forbidden |
| `chat_run_adapter_state` | Opaque, bounded, schema-versioned state keyed by Run and harness; repository API is adapter-only |
| `chat_outbox` | Monotonic owner/Chat event cursor inserted transactionally with mutations for cross-shell replay |
| `chat_deletions` | Content-free idempotency tombstone for hard deletes; contains only owner, Chat ID, request ID, and deletion time |
| `chat_legacy_imports` | Unique source kind/source ID to Chat mapping, source hash, import version, and verification status |
| `chat_migrations` | Migration phase, cutover marker/version, source fingerprint, counts, errors, and timestamps |

`project_id` intentionally has no relational foreign key because ProjectConfig
is file-backed. The ProjectManager is authoritative. The Chat repository stores
only the stable ID and treats missing/archived/deleting projects as unavailable.

### Index and search requirements

- Owner/lifecycle/updated-time index for bounded Chat listing.
- Unique owner-scoped idempotency indexes for create, Turn admission, fork, and
  delete requests.
- Partial unique index allowing at most one accepted/running/waiting Run per
  Chat.
- Message pagination by `(chat_id, seq)`; no unbounded transcript reads.
- Owner-scoped PostgreSQL full-text search over committed canonical message
  text. Search metadata remains owner-local and is removed with the Chat.
- Every normal read filters deleted content. Deletion tombstones are available
  only to the idempotency path.

## Transaction and concurrency model

### Turn admission

One transaction:

1. derive owner from the verified principal and lock the Chat row `FOR UPDATE`;
2. validate membership, lifecycle, base revision, project availability, and no
   active Run;
3. resolve harness/model capability selection and canonical history boundary;
4. insert the user message, Turn, accepted Run, initial adapter-state envelope,
   and outbox event; and
5. increment Chat revision and commit.

Only after commit may orchestration call the external harness/model. A failed
call transitions the persisted Run to `failed` in a new transaction. It never
rolls back the accepted user input or holds a database lock across I/O.

### Context, lifecycle, and deletion

Project-context update, archive, delete, and Run admission all lock the same
Chat row and re-check active Run state inside the transaction. Context changes
use `WHERE revision = :baseRevision` or the row lock plus revision increment.
This prevents a Turn from executing in one project while the Chat displays
another and prevents a deleted Chat from being recreated by late finalization.

Provider callbacks update only the matching active Run with guarded status and
sequence predicates. Late events after cancel/delete are rejected and logged;
they cannot resurrect content. Each normalized event/message mutation and its
outbox record commit together.

## Root and project-bound semantics

### Root Chat

- `project_id IS NULL`.
- The Chat is a Matrix OS task, not an unowned task.
- A harness may run only when its descriptor supports `rootChat` and its
  workspace requirement is not `project_required`.
- The Gateway supplies a capability-filtered root execution context. It never
  accepts a client path and never grants a coding harness implicit access to all
  owner system data.
- A project-required harness is displayed as unavailable with a safe action to
  attach a project; there is no silent fallback or auto-created project.

### Project-bound Chat

- `project_id` is the immutable `ProjectConfig.id`.
- ProjectManager adds `getProjectById(ownerScope, projectId)` and builds a
  bounded, reconciled in-memory index from owner file configs. The file config
  remains authoritative; PostgreSQL never becomes a second ProjectConfig.
- Slug changes do not affect the Chat link. Duplicate/missing IDs fail closed
  and require owner-visible repair.
- At Run admission, Gateway resolves the current active ProjectConfig and fixes
  its validated working root for that Run. The renderer sends no path.
- Archived, deleting, missing, inaccessible, or owner-mismatched context keeps
  history readable but blocks new Runs until context is repaired or cleared.
- Worktree requirements are capability metadata only in the first delivery.
  No worktree UI or implicit worktree creation is introduced.

## Harness switching, retry, resume, and fork

1. Changing the Chat's default harness/model affects future Runs only.
2. A new Turn may use the selected harness with a bounded canonical history
   window. The Run records the exact included message sequence boundary.
3. Retrying the same Turn creates another Run attempt. Failed prior attempts
   remain auditable; their partial output is not canonical input.
4. Same-harness resume is allowed only when the adapter supports it, the stored
   state parses under the exact adapter schema version, owner/project context
   still matches, and the prior Run is in a resumable state.
5. A harness change always creates a fresh Run from canonical history. The
   orchestration layer never passes another harness's state to it.
6. `Fork Chat` creates a new `chatId` with explicit parent Chat/message
   provenance and copies canonical history through the selected committed
   message. It does not copy active Runs or adapter resume state.
7. History windowing is explicit and bounded. If full history exceeds adapter
   limits, orchestration passes a recorded sequence range and persisted explicit
   summaries; it never deletes or silently rewrites owner history.

## Gateway API and auth matrix

All schemas are strict and bounded. Every mutating HTTP endpoint uses Hono
`bodyLimit`, including DELETE. Owner scope is derived, not supplied.

| Contract | Principal | Authorization | Notes |
|---|---|---|---|
| `GET /api/chats` | Browser/native/CLI verified principal | Owner/member read | Bounded cursor list and filters |
| `POST /api/chats` | Verified principal | Owner create | Idempotent request ID; optional project/default selection |
| `GET /api/chats/:chatId` | Verified principal | Owner/member read | Summary plus bounded message page |
| `PATCH /api/chats/:chatId` | Verified principal | Owner/editor | Title, default selection, context, lifecycle with base revision |
| `DELETE /api/chats/:chatId` | Verified principal | Owner/org admin | Reject active Run unless an explicit cancel-and-delete flow completed |
| `POST /api/chats/:chatId/turns` | Verified principal | Owner/editor | Transactional Turn/Run admission; idempotent request ID |
| `POST /api/chats/:chatId/runs/:runId/cancel` | Verified principal | Owner/editor | Same-harness cancellation only |
| `POST /api/chats/:chatId/forks` | Verified principal | Owner/editor | Explicit committed message boundary |
| `POST /api/chats/:chatId/exports` | Verified principal | Owner/org admin | Bounded temp export with cleanup policy |
| `GET /api/chat-harnesses` | Verified principal | Owner/member read | Safe capability/model projection only |
| Chat event WebSocket | Browser query token or native/CLI bearer path | Owner/member read | Exact query-token allowlist, bounded frame schema, replay cursor |
| Channel adapter dispatch | Authenticated internal channel principal | Mapped owner/member action | Channel/thread binding resolved server-side; no owner override |

Auth failure is fail-closed. Missing database, ProjectManager, harness registry,
or owner principal is service misconfiguration (`503`-style), never not-found.

## Cross-shell events and convergence

Every state-changing transaction appends a safe `chat_outbox` event containing
Chat ID, revision, event type, timestamp, and the minimum safe projection. It
does not contain transcript content, adapter state, provider errors, or paths.

The Gateway subscription hub:

- authorizes before subscribe and revalidates on replay;
- caps connections per owner and globally;
- tracks `lastTouched`, sweeps stale connections, and evicts failed senders;
- isolates each send failure;
- supports replay after a monotonic cursor and signals a replay gap;
- publishes only after transaction commit; and
- drains/clears subscribers before repository/shared-Kysely shutdown.

Desktop, browser Shell, CLI, and channel shells refresh the canonical Chat
projection from Gateway after an event. A local optimistic state may render,
but failure preserves the prior confirmed Chat and exposes safe recovery copy.

## Resource limits

Initial hard maxima; lower deployment-specific limits may be configured.

| Resource | Maximum / policy |
|---|---|
| Chat list page | 100 |
| Message page | 200 |
| Title | 200 characters and 1 KiB |
| User message | 24,000 characters and 96 KiB |
| Message parts | 64; total encoded message 128 KiB |
| Attachments per Turn | 8; existing 5 MiB item limit; bytes remain in owner storage |
| Active Runs | 1 per Chat, 8 per owner by default |
| Provider event batch | 100 normalized events |
| Persisted normalized events | 500 per Run before adapter aggregation/backpressure must occur |
| Adapter state | 64 KiB JSON envelope after serialization |
| Harness registry | 20 harnesses; duplicate IDs fail startup |
| Model catalog | 64 models per harness projection; 128 tool capability IDs |
| Dispatch history window | 200 messages or 2 MiB encoded; explicit range and truncation metadata required |
| WebSocket frame | Existing bounded Chat frame limit; schema validation after JSON parsing |
| Event subscribers | 32 per owner and a configured global cap; TTL sweep plus explicit shutdown drain |
| Exports | Streamed; at most 20 retained temporary exports per owner; 24-hour TTL with symlink-safe recurring cleanup |
| External capability/health calls | `AbortSignal.timeout`, 2 seconds default and 30 seconds hard maximum |

Exceeding a provider/event/state bound fails or backpressures the Run with a
generic safe error. It never silently truncates canonical messages.

## Error contract

Clients receive allowlisted codes such as:

- `chat_not_found`, `chat_conflict`, `chat_busy`, `chat_unavailable`;
- `project_required`, `project_unavailable`;
- `harness_unavailable`, `model_unavailable`, `capability_mismatch`;
- `run_not_found`, `run_not_resumable`, `run_unavailable`;
- `history_window_required`; and
- `migration_in_progress`.

Renderer stores allowlist and cap server strings, falling back to generic copy.
Provider IDs may appear as user-selected labels, but raw provider errors,
stderr, credentials, database details, and paths remain only in bounded
owner-controlled logs.

## Shutdown and restart

Gateway shutdown order:

1. stop new Chat/Turn admissions and emit a safe service-closing signal;
2. stop accepting event subscriptions;
3. request cancellation from active harness adapters with a 10-second total
   drain budget;
4. transactionally mark unresolved Runs `interrupted` and append outbox events;
5. drain/clear Chat subscribers and timers;
6. stop migration workers/export cleanup; and
7. release Chat repository references before the Gateway owner closes the one
   shared Kysely pool.

On startup, reconciliation finds accepted/running/waiting Runs. It may offer
resume only through the same adapter and valid state version. Otherwise it
marks the Run interrupted/failed with safe recovery actions. It never resumes
through another harness or claims an external process is still live based only
on timestamps.

## Export and delete

Export uses a consistent owner-authorized database snapshot and includes Chat
metadata, canonical messages, Turns, Run outcomes, capability selections,
collaboration/read state, and attachment manifests. Adapter resume state and
credentials are excluded by default; an explicit advanced export may include
validated non-secret adapter state with a warning. Export never sends content
to platform PostgreSQL.

Delete requires owner/org-admin authorization and an idempotency key. One
transaction locks the Chat, rejects an active Run, deletes all content and
adapter/collaboration/UI state through explicit cascades, writes a content-free
deletion tombstone, and emits an outbox deletion event. Attachment bytes are
deleted only when the reference is exclusively owned by that Chat; shared
owner files remain. Repeated delete returns success from the tombstone without
refreshing it or recreating content.

## JSON-to-PostgreSQL migration and cutover

### Sources

- `system/conversations/*.json` (Gateway kernel/Hermes history and session IDs);
- `system/coding-agents/threads.json` (threads, turns, normalized events,
  relations, and valid provider resume state); and
- no renderer-owned rail import. Current Desktop `useHermesChat`/`useThreads`
  state is process memory, so there is no durable record to discover. The
  maintenance barrier drains live renderer/Gateway Runs before final cutover.

### Idempotent import

1. Bootstrap schema and a versioned migration row without changing legacy
   authority.
2. Enumerate only validated source files; reject symlinks, oversized files,
   invalid JSON, duplicate IDs, and schema violations into an owner-visible
   migration report.
3. Hash each normalized source record. Upsert a unique
   `(source_kind, source_id)` mapping with `ON CONFLICT`; the same hash is a
   no-op, and a changed hash is re-imported transactionally before cutover.
4. Map legacy conversation IDs to new Chat IDs while preserving a compatibility
   alias. Convert messages to canonical parts. Map each coding-agent thread to
   a Chat, its accepted inputs to Turns, and provider attempts/events to Runs.
5. Preserve valid Hermes/coding provider session state only in the matching
   adapter-state envelope. Invalid or secret-shaped state is quarantined from
   execution but reported; transcript import still proceeds.
6. Validate counts, sequence ordering, owner scope, hashes, orphan references,
   and sample transcript parity. Partial batch failure rolls back that batch and
   leaves the cutover marker unset.

### Explicit cutover

1. Enter a bounded maintenance barrier: new mutations return retryable
   `migration_in_progress`; active Runs drain or become interrupted.
2. Acquire the migration advisory lock, take a final source fingerprint, and
   rerun the idempotent delta import.
3. In one transaction verify counts/hashes, set the immutable cutover marker,
   and append a migration-complete outbox event.
4. Release the barrier with PostgreSQL as the sole read/write authority.

There is no dual write. Before the marker, legacy JSON is authoritative. After
the marker, all reads and writes use PostgreSQL. Legacy API IDs resolve through
`chat_legacy_imports` for a bounded compatibility window of two stable releases
or 30 days, whichever is longer; this translation reads PostgreSQL, not JSON.
The original JSON files remain untouched, read-only owner backup material until
the documented retention/export step. Runtime code never falls back to them.

Rollback before cutover is safe. After cutover, rollback is allowed only to a
release that understands the marker and PostgreSQL schema; an older JSON writer
must refuse startup. This prevents split-brain and indefinite compatibility.

## Delivery slices and issue sequencing

### Slice A — persistence and migration

Add contracts, typed Kysely repository/migrations, immutable ProjectConfig ID
lookup, transactions/outbox, JSON importer, cutover/recovery, export/delete,
and repository/Gateway tests. This is the prerequisite for the other slices.

### Slice B — harness and model adapters

Add harness/model registries and capability contracts, then adapt Hermes,
OpenClaw, Codex, Pi, and OpenCode incrementally. Move valid provider state
behind adapter-only storage. Prove same-harness resume and cross-harness
non-resume with contract tests.

### Slice C — shell/UI migration

Move Desktop, browser Shell, CLI, and channel shells to `/api/chats` and the
outbox event stream. Replace source/provider-typed rails with one Chat
projection and capability labels. Remove renderer-owned thread identity only
after parity and cutover evidence.

MAT-299 continues to provide the current canonical Hermes lifecycle and remains
in PR #1213. It does not absorb the PostgreSQL migration. MAT-318 remains a
separate project-context delivery, but its durable target is the immutable
`ProjectConfig.id`/canonical Chat seam from Slice A rather than a slug or JSON
record. Neither existing PR is silently expanded.

A separate public documentation PR is required in the private
`FinnaAI/matrix-os-site` repository after runtime behavior exists. No local
`www/` tree is created.

## TDD and verification strategy

Implementation tests are written first after these public seams are approved.

- **Contracts:** strict Chat/message/Turn/Run/harness/model schemas; reserved
  fields; byte/count bounds; safe errors; provider-state opacity.
- **Repository:** migrations; owner isolation; row-lock races; optimistic
  revision; partial unique active Run; transactional outbox; hard delete;
  export snapshot; shared Kysely ownership/shutdown.
- **Migration:** repeated import, changed hashes, invalid sources, symlinks,
  crash/restart per phase, pre/post-marker rollback, no dual writes, legacy ID
  compatibility expiry, transcript and resume-state parity.
- **Harnesses:** capability discovery; model resolution; event/state bounds;
  same-harness resume; cross-harness resume rejection; cancel timeout; generic
  failures; project/root requirements.
- **Gateway/auth:** route/body/query validation, `bodyLimit` including DELETE,
  personal/org membership matrix, browser WebSocket query-token path, replay
  gaps, stale subscriber eviction, shutdown drain.
- **Concurrency:** Turn admission versus context update/delete/archive; late
  provider callbacks; duplicate requests; two-shell mutation conflicts.
- **Shells:** runtime-scope invalidation, loading/error/reconnect/replay, failed
  mutation preservation, capability-driven labels, no provider-specific Chat
  types, export/delete flows.
- **Real runtime:** owner-VPS PostgreSQL evidence, Gateway/browser/CLI/Desktop
  convergence, same-harness resume, harness switch from canonical history,
  project removal recovery, restart reconciliation, and exact export/delete.

Direct Figma parity is explicitly unverified because the Matrix OS View-seat
MCP call limit is exhausted. Existing saved screenshots/spec evidence may guide
later shell work, but no direct Figma-inspection claim may be made until access
is restored.

## Acceptance criteria

- [x] One provider-neutral Chat contract represents durable user-facing tasks.
- [x] Harness/model selection is capability-driven and extensible without
  changing Chat identity.
- [x] Provider session/resume state is adapter-only and cannot replace Chat ID.
- [x] Owner-local PostgreSQL/Kysely is the durable relational source of truth.
- [x] Project files remain authoritative and are linked by immutable project ID.
- [x] Root and project-bound execution semantics are explicit and testable.
- [x] Harness switching, retry, resume, and explicit fork behavior are defined.
- [x] JSON and coding-agent sources have an idempotent, recoverable, bounded
  cutover plan with no indefinite dual write.
- [x] Auth, validation, resource limits, shutdown, export/delete, and cross-shell
  convergence are specified.
- [x] Focused TDD layers and three independent implementation slices are
  defined.
- [x] Public documentation is a separate follow-up PR.
- [x] MAT-268 is excluded without modification, dependency, or new relation.
