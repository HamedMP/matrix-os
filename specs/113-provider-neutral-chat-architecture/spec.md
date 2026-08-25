# Canonical Chat, Provider, and Project Workspace Architecture

**Linear issue:** MAT-319
**Created:** 2026-08-13
**Status:** Amended for final architecture review on 2026-08-24
**Scope:** Canonical contracts, persistence, provider execution, shared Desktop surfaces, workspace resources, migration, and implementation sequencing
**Related delivery:** MAT-299, MAT-318, MAT-321, MAT-344, MAT-364, and MAT-468

## Purpose

Matrix OS needs one durable user-facing Chat abstraction. A Chat is the task the
user returns to, shares, searches, exports, or deletes. Hermes, OpenClaw, Codex,
Claude Code, Pi, OpenCode, and future execution systems are **Provider Drivers**:
agent runtimes that execute Turns rather than Chat types or model vendors. A
**Provider Instance** identifies one concrete installation, account, endpoint,
or configuration of a Driver. A **Model Selection** combines that Instance with
a model and capability-derived provider-specific options.

A draft Chat may change Provider Driver, Instance, model, and options. The first
accepted Turn binds the Chat to the exact Provider Instance used by its accepted
Run. V1 never switches Driver or Instance in place after that boundary. A user
chooses Fork with another Provider or New Chat instead. Models and options may
change for later Turns only when the bound Instance advertises compatibility.

The canonical Chat record and all relational Chat state live in the owner's
PostgreSQL database on the user's Matrix computer/VPS through Kysely. Project
code and `ProjectConfig` stay in owner-controlled files. Chat links to a Project
only by the immutable `ProjectConfig.id`; the Chat-to-Project binding itself is
mutable while the Chat is idle.

This specification records the public seams before implementation. It does not
authorize a broad migration in this PR.

The Desktop has two entry points, Global Chat and Project Chat, but they render
the same Chat domain through one Chat surface, one composer, one conversation
timeline, and one contextual inspector. A Global Chat may be added to, removed
from, or moved between Projects while idle without changing `chatId`.

## Non-goals

- Implementing the PostgreSQL repository, migration, adapters, or shell UI in
  this architecture PR.
- Expanding MAT-299's current Hermes lifecycle PR or MAT-318's project-context
  implementation.
- Platform-owned storage of owner Chat content.
- Translating provider-native session formats between Provider Drivers or
  Instances.
- Voice, multi-repository project UX, branch switching, or worktree-management
  UI.
- Files CRUD or any MAT-268 behavior, dependency, or issue relation.
- Merge or release operations.

## Current-state audit

| Area | Current source of truth | Useful seam | Gap to close |
|---|---|---|---|
| Gateway kernel conversations | `packages/gateway/src/conversations.ts` writes synchronous `system/conversations/*.json` files | Existing list/get/create/delete/search and kernel session IDs | No owner scope, Kysely repository, transaction, turn/run model, strict persisted schema, or safe cross-shell event contract |
| Coding-agent threads | `packages/gateway/src/coding-agents/thread-store.ts` writes one bounded `system/coding-agents/threads.json` aggregate | Owner checks, turns, events, idempotent request IDs, shutdown recovery, bounded adapter events | Provider ID is part of thread identity; opaque resume state is embedded in the aggregate; whole-file serialization limits concurrency and migration |
| Provider boundary | `provider-adapter.ts` and `provider-registry.ts` validate provider output and bounded health/cache state | Adapter lifecycle, normalized events, timeouts, generic client errors | Catalog lacks an explicit Driver/Instance boundary, compound model selection, and capability-driven controls |
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
Neither Provider Driver name, Provider Instance ID, model ID, provider session
ID, shell, channel, project slug, nor filesystem path is used to derive that
identity. The Provider binding becomes an immutable Chat attribute after the
first accepted Turn.

A Chat contains:

- lifecycle and title;
- owner scope and optional membership/collaboration state;
- an optional, revisioned Project binding by immutable Project ID;
- an optional Provider binding while the Chat is still a draft;
- the exact bound Provider Instance after the first accepted Turn;
- the latest compatible model/options preference for that Instance;
- canonical messages and attachment references;
- turns and one or more run attempts;
- attention, read, pinned, and shell projection state; and
- fork provenance when explicitly created from another Chat.

### Turn

A Turn is one accepted user action in a Chat. It owns the canonical user input,
an immutable `baseMessageSeq`, an idempotency key, and one or more Run attempts.
Only one Run may be active for a Chat at a time.

### Run

A Run is one execution attempt by exactly one Provider Instance with exactly one
resolved Model Selection. The Run records the Driver kind, Instance ID, model,
provider-specific options, interaction mode, permission mode, execution root,
bounded capability snapshot, lifecycle timestamps, and canonical-history
boundary. Provider-native session/resume state is stored separately behind the
owning Driver adapter.

### Provider Driver, Provider Instance, and Model Selection

A Provider Driver implements execution semantics for Hermes, OpenClaw, Codex,
Claude Code, Pi, OpenCode, or another agent runtime. A Provider Instance is one
installed and configured account or endpoint for that Driver. Multiple
Instances of the same Driver are allowed by contract even when V1 exposes only
one. The term Provider in this specification means the agent runtime, not an
LLM vendor such as OpenAI or Anthropic.

Each Instance advertises a bounded model catalog, readiness, workspace
requirements, commands, skills, resource support, interaction modes, permission
modes, and generic option descriptors. A Model Selection is one compound value:

```ts
interface ChatModelSelection {
  instanceId: ProviderInstanceId;
  model: string;
  options?: readonly ProviderOptionSelection[];
}
```

The orchestration layer validates the full selection against the current
Instance descriptor. It never infers compatibility from names.

## Non-negotiable invariants

1. Owner-local PostgreSQL is the only durable Chat source of truth after
   cutover. Platform PostgreSQL never stores owner transcript content.
2. Gateway/headless contracts are canonical. Shell stores are bounded caches
   and never create a persistence format.
3. The first accepted Turn atomically binds the Chat to one exact
   `ProviderInstanceId`. Later Turns cannot change Driver or Instance. Provider
   session IDs never replace, alias, or determine `chatId`.
4. A Run may resume only through the same Provider Instance and adapter-state
   schema version that created its resume state.
5. Cross-Driver or cross-Instance work requires Fork with another Provider or
   New Chat. Provider-native state is never copied across that boundary.
6. Project references use immutable `ProjectConfig.id`; slugs, paths, branches,
   and repository URLs are derived owner-file data. An idle Chat may revise its
   Project binding without changing `chatId`.
7. Turn admission, context mutation, archive/delete, and active-run checks lock
   the same Chat row. No check-then-write race is allowed.
8. Multiple related writes and every outbox event are committed in one Kysely
   transaction. External Provider/model calls occur outside the transaction.
9. Provider output, capability metadata, model metadata, and adapter state are
   strictly validated and bounded before persistence or renderer projection.
10. Raw provider, filesystem, database, credential, or path errors never reach
    clients. Detailed diagnostics stay in owner-controlled logs.
11. A verified request principal identifies the caller, not the storage owner.
    Organization scope requires an authoritative membership and runtime
    resolution; it never falls back to the caller's personal scope.

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
  providerBinding?: ChatProviderBinding;
  currentSelection?: ChatModelSelection;
  activeRun?: ChatRunProjection;
  attention: "none" | "approval_required" | "input_required" | "failed";
  lastMessagePreview: string;
  messageCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type ProviderDriverKind =
  | "hermes"
  | "openclaw"
  | "codex"
  | "claude_code"
  | "opencode"
  | "pi";

type ProviderInstanceId = string;

interface ChatProviderBinding {
  driverKind: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  lockedAtTurnId: string;
}

interface ProviderOptionSelection {
  id: string;
  value: string | boolean;
}

interface ChatModelSelection {
  instanceId: ProviderInstanceId;
  model: string;
  options?: readonly ProviderOptionSelection[];
}

interface ChatProjectProjection {
  projectId: string;
  name: string;
  kind: "scratch" | "github" | "folder";
  repositoryLabel?: string;
  status: "ready" | "unavailable";
}

type ChatExecutionRootRef =
  | { kind: "project"; projectId: string }
  | { kind: "worktree"; projectId: string; worktreeId: string };
```

For personal scope, `ownerId` is the verified principal's user ID. For
organization scope, `ownerId` is the stable organization ID, and Gateway must
first use an authoritative platform-owned resolver to verify the caller's
active membership and role, resolve that organization to exactly one owner
database/runtime, and bind the Project and resource namespace to the same
organization. The resolved owner context, rather than the caller identity, is
then used for every Chat, Project, file, app, task, and Terminal lookup.

The client cannot request or override this mapping. Missing membership fails
with a generic authorization error; a missing, malformed, or ambiguous owner
runtime mapping fails as service misconfiguration. Neither case may retry in
the caller's personal scope. Until this resolver and its fail-closed contract
tests exist, organization-owned Chats remain unavailable and the cutover is
personal-scope only.

The client never sends `OwnerScope`, a filesystem path, provider resume state,
provider credentials, repository URL, or runtime identity. Gateway derives
owner scope from the verified principal and resolves project/runtime state. A
client may select an opaque existing `worktreeId` where the Provider Instance
supports it, but only Gateway constructs and validates
`ChatExecutionRootRef`. `primaryWorkspaceRoot` is therefore a derived per-Run
execution value, not a Chat field, Project identity, or renderer-controlled
path.

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

### Provider capability contract

```ts
type ProviderCapabilityClass = "system_agent" | "coding_agent";

interface ProviderDriverDescriptor {
  kind: ProviderDriverKind;
  displayName: string;
  adapterVersion: string;
  capabilityClass: ProviderCapabilityClass;
}

interface ProviderInstanceDescriptor {
  id: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  displayName: string;
  availability: "available" | "setup_required" | "auth_required" | "unavailable";
  workspaceRequirement: "none" | "project_optional" | "project_required";
  models: readonly ModelDescriptor[];
  options: readonly ProviderOptionDescriptor[];
  skills: readonly ChatSkillDescriptor[];
  commands: readonly ChatCommandDescriptor[];
  supports: {
    rootChat: boolean;
    resume: boolean;
    cancellation: boolean;
    attachments: readonly ChatAttachmentKind[];
    tools: readonly string[];
    approvals: boolean;
    userInput: boolean;
    worktrees: "none" | "optional" | "required";
    interactionModes: readonly string[];
    permissionModes: readonly string[];
  };
  defaultSelection?: ChatModelSelection;
}

interface ChatProviderAdapter<State> {
  readonly driverKind: ProviderDriverKind;
  describeInstance(input: ProviderDescribeInput): Promise<ProviderInstanceDescriptor>;
  start(input: StartRunInput): AsyncIterable<NormalizedRunEvent>;
  resume?(input: ResumeRunInput<State>): AsyncIterable<NormalizedRunEvent>;
  cancel?(input: CancelRunInput<State>): Promise<void>;
  stateSchemaVersion: number;
  parseState(value: unknown): State;
  serializeState(value: State): unknown;
}
```

The registry groups Instances in one selector by `capabilityClass`, but the
selector does not imply that Hermes/OpenClaw and coding Drivers have identical
capabilities. The descriptor determines which controls the composer renders.
Reasoning effort, service tier, interaction mode, permission mode, worktree,
skills, commands, and other Driver-specific choices are capability-derived;
the shell never hardcodes them as universal fields.

The adapter-state store exposes state only to the registered adapter whose
Driver kind, Instance ID, and schema version match the Run. Adapters must not
place access tokens, credentials, raw stderr, or unbounded transcripts in
state. A provider-native
absolute execution root such as Pi's `cwd` is the sole path exception: the
exact adapter schema must declare the field, and Gateway must realpath-resolve
it through an owner-scoped `ChatExecutionRootResolver` at import, write, and
resume. Validation is exact provenance, not lexical containment:

- a `project` root must equal the current realpath of
  `ProjectConfig.localPath`; this includes owner-approved external folder
  projects that ProjectManager already accepted; or
- a `worktree` root must equal the current realpath of the exact live
  `WorktreeRecord` resolved by the same ProjectConfig's slug and `worktreeId`,
  and that record must remain under Matrix's canonical
  `projects/<slug>/worktrees/<worktreeId>` root with matching `.matrix`
  metadata.

The adapter envelope stores the safe execution-root reference alongside the
provider `cwd`. A legacy Pi state with only `cwd` is preserved only when it
exactly matches the project root or exactly one registered worktree for that
project; import backfills that reference. Arbitrary siblings, unregistered
worktrees, subpaths, owner mismatches, and ambiguous matches are quarantined.
The path remains encrypted, adapter-private, and excluded from logs, renderer
projections, and default exports. A moved/deleted root or changed provenance
makes the Run non-resumable rather than silently rebinding it.

The resolver returns a non-secret fingerprint derived from a canonical encoding
of the safe reference, owner scope, `ProjectConfig.id`, its validated current
`localPath` realpath, and, for worktrees, the `WorktreeRecord` ID, project slug,
validated realpath, and creation timestamp. The fingerprint is stored with the
Run; raw paths are not. Re-resolution must reproduce the same reference and
fingerprint before start/resume. Any file-config or worktree-record change that
alters those inputs requires a new Run instead of reusing adapter state.

### Model and option contract

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

interface ProviderOptionDescriptor {
  id: string;
  label: string;
  kind: "enum" | "boolean";
  values?: readonly { value: string; label: string }[];
  defaultValue?: string | boolean;
  placement: "composer" | "advanced";
}

interface ChatSkillDescriptor {
  id: string;
  displayName: string;
  description: string;
  invocation: `/${string}`;
}

interface ChatCommandDescriptor {
  id: string;
  displayName: string;
  description: string;
  invocation: `/${string}`;
}

interface ChatResourceReference {
  kind: "file" | "folder" | "project" | "task" | "app" | "terminal_session";
  id: string;
  label: string;
  revision?: string;
}
```

The `id` in `ChatResourceReference` is an owner-authorized opaque or
project-relative resource token. It is never an absolute filesystem path,
credential, provider-native ID, or renderer-only tab identity.

The Instance catalog resolves a model and options only when its current
availability and capability predicates pass. The Chat may store a compatible
preference for its bound Instance; each Run stores the exact resolved selection
and capability snapshot. Removing a model or Instance does not make the Chat
unreadable.

## Owner-local PostgreSQL model

The Chat repository receives the Gateway-owned `Kysely<OwnerDatabase>` used by
other owner-local services. It does not create a pool and does not call
`destroy()`; the Gateway closes the shared owner after Chat subscribers and
Run orchestration have drained.

| Table | Purpose and key invariants |
|---|---|
| `chats` | Immutable `id`; `owner_type + owner_id`; optional revisioned `project_id`; lifecycle; title; bound Driver/Instance after first Turn; current compatible selection; fork provenance; `revision`; timestamps |
| `chat_members` | Collaboration principals and role (`owner`, `editor`, `viewer`); unique by Chat/principal; personal Chats still have one owner row |
| `chat_user_state` | Per-principal read cursor, pinned/muted state, attention acknowledgement, last-opened timestamp; serializable durable UI state |
| `chat_messages` | Per-Chat monotonic `seq`; role; strict parts JSONB; state; optional Turn/Run IDs; byte count; timestamps; unique `(chat_id, seq)` |
| `chat_attachments` | Owner-file/object references and safe metadata; never embeds arbitrary local paths or attachment bytes in renderer projections |
| `chat_turns` | User action, `base_message_seq`, input message, idempotency key, status, timestamps; unique `(chat_id, client_request_id)` |
| `chat_runs` | Attempt number, actual Driver/Instance/model/options, safe execution-root reference, capability snapshot, history boundary, status/outcome, timestamps; one active Run per Chat via a partial unique index |
| `chat_run_events` | Bounded normalized replay events for streaming, approvals, tool progress, and recovery; provider raw frames are forbidden |
| `chat_run_adapter_state` | Opaque, bounded, schema-versioned state keyed by Run, Driver, and Instance; repository API is adapter-only |
| `chat_outbox` | Monotonic owner/Chat event cursor inserted transactionally with mutations for cross-shell replay |
| `chat_deletions` | Content-free idempotency tombstone for hard deletes; contains only owner, Chat ID, request ID, and deletion time |
| `chat_legacy_imports` | Unique source kind/source ID to Chat mapping, source hash, import version, and verification status |
| `chat_migrations` | Migration phase, cutover marker/version, source fingerprint, counts, errors, timestamps, and the immutable legacy-alias expiry |

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

Before opening the transaction, Gateway resolves any execution-root reference
through ProjectManager/WorktreeManager and records a root fingerprint without
holding a database lock across filesystem I/O. One transaction then:

1. resolve the authorized owner context from the verified principal and lock
   the Chat row `FOR UPDATE` in that owner's database;
2. validate membership, lifecycle, base revision, the same project/root
   reference, and no active Run;
3. resolve the selected Provider Instance, model, options, and canonical history
   boundary from the current capability descriptor;
4. if this is the first accepted Turn, atomically bind the Chat to that exact
   Driver and Instance; otherwise require the existing Instance binding;
5. insert the user message, Turn, accepted Run, initial adapter-state envelope,
   and outbox event; and
6. increment Chat revision and commit.

Only after commit may orchestration call the external Provider/model. Immediately
before that call it re-resolves the exact execution-root reference and compares
the fingerprint; a changed, deleted, moved, or owner-mismatched root fails the
Run safely. A failed call transitions the persisted Run to `failed` in a new
transaction. It never rolls back the accepted user input or holds a database
lock across I/O.

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
- A Provider Instance may run only when its descriptor supports `rootChat` and its
  workspace requirement is not `project_required`.
- The Gateway supplies a capability-filtered root execution context. It never
  accepts a client path and never grants a coding Provider implicit access to all
  owner system data.
- A project-required Provider is displayed as unavailable with a safe action to
  attach a project; there is no silent fallback or auto-created project.

### Project-bound Chat

- `project_id` references the Project's immutable `ProjectConfig.id`; the Chat
  binding may still change through the guarded idle mutation below.
- ProjectManager adds `getProjectById(ownerScope, projectId)` and builds a
  bounded, reconciled in-memory index from owner file configs. The file config
  remains authoritative; PostgreSQL never becomes a second ProjectConfig.
- Slug changes do not affect the Chat link. Duplicate/missing IDs fail closed
  and require owner-visible repair.
- At Run admission, Gateway resolves the current active ProjectConfig and fixes
  a safe `ChatExecutionRootRef` for that Run. Direct project execution resolves
  exactly to `ProjectConfig.localPath`, including an approved external folder.
  Worktree execution resolves only through the existing WorktreeManager record
  for the same project; managed sibling worktrees are valid without being
  descendants of `localPath`. The renderer sends no path.
- Archived, deleting, missing, inaccessible, or owner-mismatched context keeps
  history readable but blocks new Runs until context is repaired or cleared.
- Worktree requirements are capability metadata only in the first delivery.
  No worktree UI or implicit worktree creation is introduced.

### Moving a Chat between Projects

- Create may omit `projectId`; Global Chat is therefore a first-class draft and
  durable state rather than a temporary Project.
- Add to Project, remove from Project, and move between Projects use one
  revision-guarded context mutation. The Chat and all canonical history retain
  the same `chatId`.
- The mutation is allowed only with no accepted/running/waiting Run. It locks
  the Chat row, validates the target Project by owner and immutable ID, updates
  `project_id`, increments revision, and appends an outbox event atomically.
- Existing Runs retain their recorded execution-root provenance. Moving the
  Chat never rewrites past Run roots or Provider state.
- A moved Chat's next Turn resolves a fresh root for the new Project. If the
  bound Provider Instance requires a capability the target cannot satisfy, the
  move fails safely before mutation. Any native session whose recorded root no
  longer matches is non-resumable; the same Instance starts from bounded
  canonical history instead.

## Project workspace and resource ownership

The user-visible hierarchy is:

```text
Computer / VPS
├── Provider Drivers and Provider Instances
├── Files and installed Apps
├── Terminal Sessions
├── Global Chats
└── Projects
    ├── Project bindings to Files and Apps
    ├── Project views of Terminal Sessions
    ├── Chats
    │   ├── Turns
    │   │   └── Run attempts
    │   └── references to Files, Apps, Tasks, and Terminal Sessions
    └── Tasks / Kanban
```

Ownership and projection are intentionally different:

| Resource | Canonical owner | Project behavior | Chat/Run behavior |
|---|---|---|---|
| Files/folders | Computer/VPS filesystem | Project binds approved roots and repository metadata | Messages store structured references; Runs receive resolved, permission-filtered roots |
| Apps | Computer/VPS installation catalog | Project stores app bindings/layout, not duplicate installations | Chat may reference or launch an available App through a structured resource reference |
| Terminal Sessions | Computer/VPS terminal service, workspace-scoped | Project lists sessions whose workspace reference resolves to it | Chat/Run stores optional references; it never owns or deletes the session implicitly |
| Tasks/Kanban | Project | Moves with the Project and may link Chats/Runs | Chat stores stable task references, not copied task state |
| Chats | Owner; optionally bound to one Project | Project lists bound Chats | Turn belongs to Chat; Run attempt belongs to Turn |

`terminalSessionId` is the durable service identity. A renderer-local
`terminalTabId` is only presentation state and must never be persisted as the
session identity. The later Zellij session-versus-tab design may refine the
projection without changing this ownership boundary.

## Shared Desktop Chat composition

Global Chat and Project Chat are routes into one `ChatSurface` composition:

```text
ChatSurface
├── ConversationTimeline
├── ChatComposer
└── ChatInspector
```

- `ChatSurface` owns route/context wiring, loading, replay, and the active Chat
  controller. It receives optional Project context; it does not fork the Chat
  domain into global and project implementations.
- `ConversationTimeline` renders canonical message parts and normalized Run
  activity. It does not read legacy Provider stores directly.
- `ChatComposer` renders Provider/model/options/effort/mode/permission controls
  from the selected Instance descriptor. Before the first accepted Turn it may
  change Instance; afterward it explains the lock and offers Fork/New Chat.
- Typing `/` searches the union of capability-filtered skills and commands.
  Typing `@` creates typed references to allowed files, folders, Projects,
  Tasks, Apps, and Terminal Sessions. Display text alone is never parsed back
  into a path or identity.
- `ChatInspector` hosts provider-neutral tabs such as context, changes, files,
  approvals, and Run details. A tab appears only when capability and Run data
  support it.
- The three surfaces consume shared schemas, fixture factories, controllers,
  and design tokens. They do not import each other's local stores or create a
  second Gateway/persistence contract.

This boundary permits message presentation and inspector work to proceed from
contract fixtures while the canonical Gateway and Chat panel are built.

## Provider binding, retry, resume, and fork

1. Before the first accepted Turn, changing Driver, Instance, model, or options
   updates draft state only.
2. The first accepted Turn binds the exact Driver and Instance in the same
   transaction that admits the Turn and Run.
3. Later Turns may change model or provider-specific options only when the bound
   Instance currently advertises those selections as compatible. If its native
   runtime cannot switch model inside one session, the adapter starts a fresh
   native session from bounded canonical history while retaining the same
   Matrix Chat and Instance binding.
4. Retrying the same Turn creates another Run attempt through the same bound
   Instance. Failed prior attempts remain auditable; their partial output is
   not canonical input.
5. Same-Instance resume is allowed only when the adapter supports it, the stored
   state parses under the exact adapter schema version, owner/project context
   still matches, and the prior Run is in a resumable state.
6. A later request for another Driver or Instance returns
   `provider_instance_locked` with safe Fork/New Chat actions; it never creates
   an in-place Run through that Provider.
7. `Fork Chat` creates a new `chatId` with explicit parent Chat/message
   provenance and copies canonical history through the selected committed
   message. The new Chat remains a draft until its first Turn and does not copy
   active Runs or adapter resume state.
8. History windowing is explicit and bounded. If full history exceeds adapter
   limits, orchestration passes a recorded sequence range and persisted explicit
   summaries; it never deletes or silently rewrites owner history.

## Gateway API and auth matrix

All schemas are strict and bounded. Every mutating HTTP endpoint uses Hono
`bodyLimit`, including DELETE. Owner scope is derived, not supplied.

| Contract | Principal | Authorization | Notes |
|---|---|---|---|
| `GET /api/chats` | Browser/native/CLI verified principal | Owner/member read | Bounded cursor list and filters |
| `POST /api/chats` | Verified principal | Owner create | Idempotent request ID; optional Project and draft selection |
| `GET /api/chats/:chatId` | Verified principal | Owner/member read | Summary plus bounded message page |
| `PATCH /api/chats/:chatId` | Verified principal | Owner/editor | Title, compatible selection, Project binding, lifecycle with base revision; Driver/Instance mutation rejected after binding |
| `DELETE /api/chats/:chatId` | Verified principal | Owner/org admin | Reject active Run unless an explicit cancel-and-delete flow completed |
| `POST /api/chats/:chatId/turns` | Verified principal | Owner/editor | Transactional Turn/Run admission; idempotent request ID |
| `POST /api/chats/:chatId/turns/:turnId/runs` | Verified principal | Owner/editor | Idempotent same-Turn retry; immutable input and bound Instance |
| `POST /api/chats/:chatId/runs/:runId/cancel` | Verified principal | Owner/editor | Same-Instance cancellation only |
| `POST /api/chats/:chatId/forks` | Verified principal | Owner/editor | Explicit committed message boundary and optional draft selection |
| `POST /api/chats/:chatId/exports` | Verified principal | Owner/org admin | Bounded temp export with cleanup policy |
| `GET /api/chat-providers` | Verified principal | Owner/member read | Safe Driver/Instance/model/options/skills/commands projection only |
| `GET /api/chats/:chatId/resources` | Verified principal | Owner/member read | Capability- and Project-filtered `@` resource search; opaque IDs only |
| Chat event WebSocket | Browser query token or native/CLI bearer path | Owner/member read | Exact query-token allowlist, bounded frame schema, replay cursor |
| Channel adapter dispatch | Authenticated internal channel principal | Mapped owner/member action | Channel/thread binding resolved server-side; no owner override |

Auth failure is fail-closed. Missing database, ProjectManager, Provider registry,
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
| Provider registry | 20 Drivers and 64 Instances per owner; duplicate stable IDs fail startup |
| Instance catalog | 64 models, 64 skills/commands, 32 option descriptors, and 128 tool capability IDs per projection |
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
- `provider_unavailable`, `provider_instance_locked`, `model_unavailable`,
  `capability_mismatch`;
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
3. request cancellation from active Provider adapters with a 10-second total
   drain budget;
4. transactionally mark unresolved Runs `interrupted` and append outbox events;
5. drain/clear Chat subscribers and timers;
6. stop migration workers/export cleanup; and
7. release Chat repository references before the Gateway owner closes the one
   shared Kysely pool.

On startup, reconciliation finds accepted/running/waiting Runs. It may offer
resume only through the same Driver, Instance, adapter, and valid state version. Otherwise it
marks the Run interrupted/failed with safe recovery actions. It never resumes
through another Provider Instance or claims an external process is still live based only
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
5. Preserve valid Hermes/coding Provider session state only in the matching
   adapter-state envelope. Pi's absolute `cwd` remains resumable only when its
   adapter schema accepts it and Gateway binds its realpath to either the exact
   current `ProjectConfig.localPath` or one exact registered WorktreeRecord for
   the imported Chat's owner-scoped project, backfilling the corresponding safe
   execution-root reference. Secrets, undeclared path fields, arbitrary sibling
   paths, and unregistered/ambiguous roots are quarantined from execution but
   reported; transcript import still proceeds.
6. Validate counts, sequence ordering, owner scope, hashes, orphan references,
   and sample transcript parity. Partial batch failure rolls back that batch and
   leaves the cutover marker unset.

### Explicit cutover

1. Enter a bounded maintenance barrier: new mutations return retryable
   `migration_in_progress`; active Runs drain or become interrupted.
2. Acquire the migration advisory lock, take a final source fingerprint, and
   rerun the idempotent delta import.
3. In one transaction verify counts/hashes, set the immutable cutover marker,
   persist `legacy_alias_expires_at = cutover_at + interval '90 days'`, and
   append a migration-complete outbox event.
4. Release the barrier with PostgreSQL as the sole read/write authority.

There is no dual write. Before the marker, legacy JSON is authoritative. After
the marker, all reads and writes use PostgreSQL. Legacy API IDs resolve through
`chat_legacy_imports` only while the database clock is strictly earlier than the
immutable `legacy_alias_expires_at`, exactly 90 days after cutover. At and after
that instant the resolver returns the safe expired/not-found result and a
recurring cleanup may delete alias rows. Tests use an injected clock at the
89-day, exact-expiry, and post-expiry boundaries. This rule needs no platform
release history and cannot remain active indefinitely. The translation reads
PostgreSQL, not JSON. The original JSON files remain untouched, read-only owner
backup material until the documented retention/export step. Runtime code never
falls back to them.

Rollback before cutover is safe. After cutover, rollback is allowed only to a
release that understands the marker and PostgreSQL schema; an older JSON writer
must refuse startup. This prevents split-brain and indefinite compatibility.

## Delivery boundaries

### Boundary A — shared contracts

Add strict shared schemas, Provider Driver/Instance descriptors, compound model
selection, normalized message/Run projections, structured `/` invocations and
`@` references, fixture factories, and compatibility adapters. This is the
only prerequisite shared by otherwise parallel UI and backend work.

### Boundary B — canonical Gateway and persistence

Add the typed Kysely repository/migrations, immutable ProjectConfig ID lookup,
transactions/outbox, Provider registry, Turn/Run orchestration, JSON importer,
cutover/recovery, export/delete, and Gateway tests. Adapt Hermes and Codex first;
add Claude Code, Pi, OpenCode, and OpenClaw only through the same contracts.

### Boundary C — shared Chat panel

Build the single `ChatSurface` and `ChatComposer`, Provider/Instance/model
selection, capability-driven mode/effort/permission controls, `/` picker, `@`
references, and Global/Project context mutation. It may develop against Boundary
A fixtures, then integrates with Boundary B.

### Boundary D — conversation presentation

Polish `ConversationTimeline` against canonical message and normalized Run
fixtures. It owns rendering quality, streaming states, tool/approval/input
parts, error/retry copy, and accessibility; it does not own Provider orchestration
or legacy store migration.

### Boundary E — contextual inspector

Refactor `ChatInspector` and its changes/files/context/Run-detail tabs against
canonical projections. It owns layout, navigation, preview, and responsive
behavior; exact turn-diff truth remains a Gateway responsibility.

### Boundary F — integration and cutover

Compose Boundaries B-E, move Desktop, browser Shell, CLI, and channel shells to
`/api/chats` plus the outbox event stream, and replace source/provider-typed
rails with one Chat projection. Remove renderer-owned thread identity only
after parity, migration, and real-runtime evidence.

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

- **Contracts:** strict Chat/message/Turn/Run/Driver/Instance/model/options
  schemas; reserved
  fields; byte/count bounds; safe errors; provider-state opacity.
- **Repository:** migrations; owner isolation; row-lock races; optimistic
  revision; partial unique active Run; transactional outbox; hard delete;
  export snapshot; shared Kysely ownership/shutdown.
- **Migration:** repeated import, changed hashes, invalid sources, symlinks,
  crash/restart per phase, pre/post-marker rollback, no dual writes, legacy ID
  compatibility expiry, transcript and resume-state parity.
- **Providers:** Driver/Instance discovery; capability-derived controls; model
  resolution; first-Turn binding; event/state bounds; same-Instance resume;
  cross-Instance mutation rejection and Fork; cancel timeout; generic failures;
  Project/root requirements.
- **Gateway/auth:** route/body/query validation, `bodyLimit` including DELETE,
  personal/org membership matrix, browser WebSocket query-token path, replay
  gaps, stale subscriber eviction, shutdown drain.
- **Concurrency:** Turn admission versus context update/delete/archive; late
  provider callbacks; duplicate requests; two-shell mutation conflicts.
- **Shells:** identical Global/Project Chat composition, runtime-scope
  invalidation, loading/error/reconnect/replay, failed mutation preservation,
  capability-driven controls, `/` and `@` structured selection, Chat moves,
  no Provider-specific Chat types, export/delete flows.
- **Real runtime:** owner-VPS PostgreSQL evidence, Gateway/browser/CLI/Desktop
  convergence, same-Instance resume, cross-Instance Fork, Project move/removal
  recovery, restart reconciliation, and exact export/delete.

Direct Figma parity is explicitly unverified because the Matrix OS View-seat
MCP call limit is exhausted. Existing saved screenshots/spec evidence may guide
later shell work, but no direct Figma-inspection claim may be made until access
is restored.

## Acceptance criteria

- [x] One provider-neutral Chat contract represents durable user-facing tasks.
- [x] Provider Driver, Provider Instance, model, and options are distinct,
  capability-driven concepts.
- [x] Provider session/resume state is adapter-only and cannot replace Chat ID.
- [x] Owner-local PostgreSQL/Kysely is the durable relational source of truth.
- [x] Project files remain authoritative and are linked by immutable project ID.
- [x] Root and project-bound execution semantics are explicit and testable.
- [x] First-Turn Provider binding, retry, resume, and cross-Provider Fork/New
  Chat behavior are defined.
- [x] JSON and coding-agent sources have an idempotent, recoverable, bounded
  cutover plan with no indefinite dual write.
- [x] Auth, validation, resource limits, shutdown, export/delete, and cross-shell
  convergence are specified.
- [x] Global and Project Chat share one composition and Chat can move between
  Project contexts while idle.
- [x] Files, Apps, Terminal Sessions, Tasks, Chats, Turns, and Runs have explicit
  ownership and reference boundaries.
- [x] Focused TDD layers and independently ownable delivery boundaries are
  defined.
- [x] Public documentation is a separate follow-up PR.
- [x] MAT-268 is excluded without modification, dependency, or new relation.
