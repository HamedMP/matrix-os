# Full Coding Workspace Backend

**Status**: Proposed expansion; implementation requires product-owner confirmation
**Scope**: Gateway/runtime capabilities required for a complete Matrix coding workspace across desktop, mobile, browser, and CLI
**Target source of truth after B25-009 cutover**: The user's Matrix computer and owner-controlled Postgres; the bounded owner file remains active until the authoritative marker commits

## Product Thesis

A coding conversation is a durable remote process, not a local chat view. It has
provider state, a paged transcript, turns, tools, approvals, terminals, source
control context, previews, child runs, attention state, and optional
collaborators. Every shell renders the same records and can resume after process,
network, app, or computer changes.

Projects and tasks organize conversations but do not own their execution state.
A project may have many conversations, a task may have many conversations, and
one conversation may have many turns, child runs, terminal bindings, review
snapshots, and attachments. Kanban is a view over canonical task state;
Conversation is a view over one selected conversation.

## Scope Boundary

This expansion covers the complete coding-workspace workflow:

1. Discover, create, import, resume, rename, archive, fork, abort, and hand off
   coding conversations.
2. Render complete provider-neutral transcript history with stable pagination,
   replay, compaction gaps, and safe rich message/tool data.
3. Send immediate turns, queue pending messages, edit/reorder/remove pending
   messages, steer compatible active turns, and interrupt turns explicitly.
4. Select provider, model, mode, reasoning effort, approval policy, sandbox
   policy, runtime profile, reusable prompts, skills, and MCP configurations
   through server-advertised capabilities.
5. Inspect parent/child execution runs and subagent activity without treating
   child runs as client-local UI records.
6. Bind multiple canonical named terminal sessions to a project, task,
   conversation, or execution run and attach to those sessions from any shell.
7. Browse/edit files, inspect repository state and diffs, create review comments,
   commit, branch, stash, pull, push, manage worktrees, and create pull requests
   through bounded gateway operations.
8. Upload bounded files/images and attach server-owned references to messages.
9. Route approvals, input requests, unread work, failures, completions, and
   review-ready events through one owner-scoped attention inbox.
10. Move a resumable conversation between the user's Matrix computers when the
    destination can prove compatible project, provider, and policy context.
11. Share a conversation with explicit owner/editor/viewer roles where Matrix
    org/shared ownership is available.
12. Hydrate all of the above through versioned, bounded contracts that thin
    desktop/mobile/browser/CLI clients can consume.
13. Search owner conversation memory through a server-side bounded index and
    attach selected historical references without copying history into clients.
14. Run conversation-aware scheduled/manual automations and voice actions through
    the same validated action, approval, and audit contracts as visual shells.
15. Apply runtime/org feature policy, retention, connected-service availability,
    diagnostics, crash recovery, and bug-report controls consistently across
    computers and shells.

The following are not part of this coding-workspace expansion:

- Replacing Matrix authentication, runtime routing, canonical projects/tasks,
  canonical terminal sessions, or the app framework.
- Client-side provider credentials or provider-specific business logic.
- A new embedded database, ORM, relay, encryption system, or terminal protocol.
- Rebuilding the existing Matrix voice, cron, memory, diagnostics, bug-report,
  connected-service, or enterprise-auth systems. This work only adds coding-
  conversation integrations through their canonical APIs.
- Automatic task-status changes inferred from conversation or run status.

## Shared Computer And Preview Foundation

This foundation precedes every V2 coding-workspace route. Desktop and mobile
currently have independently proposed computer inventory shapes; they MUST
converge before either shell stack merges.

### Canonical Computer Inventory

Canonical read route: `GET /api/auth/computers`.

Canonical bounded response:

- `items`: maximum 20 `MatrixComputerSummary` records
- `hasMore`, `limit`, and nullable server-derived `selectedSlot`
- each record: validated `handle`, authoritative `runtimeSlot`, safe `label`,
  coarse `availability`, safe `kind` (`customer` or `preview`), optional safe
  `versionLabel`, bounded capability IDs, and derived same-origin `gatewayPath`
- `gatewayPath` is exactly `/vm/{validatedHandle}`

Authentication accepts only principals resolved by the shared server-side
identity resolver: verified Clerk user or trusted native/sync identity. Owner
identifiers supplied by clients are ignored. The response never includes machine
IDs, IPs, credentials, provider state, private hostnames, or operator metadata.

`selectedSlot` is non-null only when the verified principal carries an
authoritative runtime slot. A plain Clerk principal has no selected slot; shell
selection remains local navigation state until an authenticated exchange occurs.

`POST /api/auth/runtime-selection` accepts only the existing verified native/sync
principal, never a static client-type header. It may return a replacement bearer
only after validating the selected owner/runtime; Electron main is the sole
consumer and the bearer never crosses preload IPC. Mobile switches
its validated same-origin gateway connection through existing authenticated
platform/session routing and never calls the bearer-replacing route.

Temporary aliases require a shipped-client compatibility audit, explicit expiry,
and the same auth/response schema. New code uses only `/api/auth/computers`.

### Server-Verified Native Identity Projection

Native app-session authentication may intentionally clear stale browser Clerk
cookies. The platform/shell MUST expose a bounded server-authored native identity
projection for authenticated native sessions so shell chrome can render display
name/avatar fallback without treating any client header as identity proof.

### Isolated Preview Authority

Preview Platform and Preview VPS lanes MUST form one isolated end-to-end control
plane:

- preview-scoped Postgres/database namespace, JWT signing/verification, edge
  secrets, provisioning authority, and Hetzner credential
- fixed preview owner, bounded PR-derived handle/runtime slot, exact bundle SHA,
  TTL, reaper, and explicit teardown
- fail closed when preview provisioning credentials are absent; never fall back
  to production credentials or mutate a primary runtime
- platform preview can list/select only preview-authority computers and issues
  credentials accepted by those preview runtimes
- one end-to-end preview orchestration owns platform plus VPS generations under
  one PR/head-SHA compare-and-swap; until migration, lane concurrency groups are
  independent and label changes for one lane cannot cancel the other lane
- closing/removing the preview label tears down the disposable revision/VPS and
  preserves audit evidence

The combined candidate MUST preserve existing native Linux app streaming and
capability routing while adding canonical computer inventory/session routing.
It deploys non-promoted first. No production traffic changes until desktop and
physical mobile authenticate, list, select, and hydrate the same disposable
computer.

The target workflow uses one exact preview label, same-repository PR heads only,
GitHub OIDC with least privilege, checkout and deployment pinned to the verified
PR head SHA, one concurrency generation per PR, and an independent scheduled
reaper. Unlabel/close always invokes idempotent teardown. Edge routing denies an
expired environment before asynchronous resource deletion completes.

## Capability Model

The runtime summary MUST advertise each capability independently so old hosts and
partially rolled-out previews degrade safely:

| Capability | Meaning |
| --- | --- |
| `codingAgentsTranscriptPages` | Stable backward/forward transcript pagination and replay gaps |
| `codingAgentsSessionDiscovery` | Discover and import resumable provider sessions |
| `codingAgentsSessionLifecycle` | Rename, archive, unarchive, fork, and abort conversations |
| `codingAgentsPendingQueue` | Server-owned pending message queue with reorder/edit/remove |
| `codingAgentsSteering` | Active-turn steering when the selected provider supports it |
| `codingAgentsTurnInterrupt` | Explicit interruption of one active turn |
| `codingAgentsProviderControls` | Server-advertised model/mode/reasoning/policy options |
| `codingAgentsProfiles` | Owner-scoped reusable provider/runtime profiles and secret references |
| `codingAgentsExecutionGraph` | Parent/child run and subagent projections |
| `codingAgentsTerminalBindingsV2` | Many canonical terminal bindings per scoped resource |
| `codingAgentsRepositoryState` | Bounded branch/worktree/staged/unstaged status |
| `codingAgentsSourceControlV2` | Commit, branch, stash, pull, push, worktree, and PR operations |
| `codingAgentsReviewComments` | Durable structured review comments and resolution state |
| `codingAgentsAttachments` | Bounded server-owned attachment upload and references |
| `codingAgentsAttentionInbox` | Owner-scoped paged attention records and acknowledgement |
| `codingAgentsRuntimeHandoff` | Conversation handoff between compatible Matrix computers |
| `codingAgentsCollaboration` | Explicit participant roles and shared conversation access |
| `codingAgentsPromptAssets` | Reusable prompt, skill, and MCP configuration references |
| `codingAgentsUsageSummary` | Coarse provider usage/quota summaries without credentials |
| `matrixComputerInventoryV1` | Shared owner-scoped computer inventory and selected runtime |
| `matrixNativeIdentityProjection` | Server-verified native display identity fallback |
| `codingAgentsMemorySearch` | Owner-scoped bounded conversation-memory search |
| `codingAgentsAutomations` | Validated scheduled/manual conversation actions |
| `codingAgentsVoiceActions` | Existing voice shell can invoke coding actions through shared policy |
| `codingAgentsFeaturePolicy` | Runtime/org advertised capability and retention policy |
| `codingAgentsRecovery` | Restart/crash reconciliation and safe recovery summaries |
| `codingAgentsDiagnosticsSnapshot` | Redacted bounded support/bug-report snapshot |

Capabilities MUST describe availability, limits, and optional provider support.
A shell MUST hide or disable unsupported actions rather than infer support.

## Canonical Data Model

### CodingConversation

Extends the existing `AgentThread` identity. It owns display metadata and
relationships, not provider credentials.

- `threadId`, `scopeType` (`personal`, `org`, `shared`), `scopeId`, `runtimeId`
- required `projectId`, optional `taskId`, optional `worktreeId`
- `title`, `status`, `attention`, `createdAt`, `updatedAt`, `archivedAt`
- active provider/profile/model/mode/policy summary
- opaque server-only provider conversation identity
- latest transcript sequence, latest event cursor, unread/attention counts
- active turn and active runtime binding summaries

### ConversationTurn

One accepted user action in a conversation.

- immutable `turnId`, `threadId`, `clientRequestId`
- request kind: `normal`, `steer`, `interrupt`, `queued`
- lifecycle: `pending`, `accepted`, `running`, `waiting`, `completed`, `failed`,
  `cancelled`
- bounded message/attachment references and selected provider options
- server-only resume/dispatch state

### TranscriptEntry

A durable provider-neutral display record with monotonic `seq` scoped to one
conversation.

- kinds: user message, assistant message, reasoning summary, tool call, tool
  result, approval, input request, lifecycle marker, file/review change, child
  run, terminal activity, safe error, completion
- stable entry ID, turn/run correlation, occurrence time
- bounded structured content and truncation metadata
- optional replacement/aggregation key for streamed updates
- visibility scope for owner/shared participants

Transcript pagination MUST support `beforeSeq`, `afterSeq`, `limit`, `hasMore`,
and an explicit replay/compaction gap. The gateway MUST preserve complete owner
history in Postgres even when live stream windows and client memory are capped.

### PendingMessage

Server-owned queue record with stable order and optimistic revision.

- `pendingMessageId`, `threadId`, `clientRequestId`, `position`, `revision`
- bounded message and attachment references
- lifecycle: `pending`, `claimed`, `cancelled`, `delivered`, `failed`
- created/updated timestamps

Only pending records may be edited, reordered, or removed. Queue claims MUST use
an atomic conditional update so two dispatchers cannot deliver one record twice.

### ExecutionRun

Represents the active turn, delegated child run, review run, plan run, or other
provider-neutral execution unit.

- `runId`, `threadId`, optional `turnId`, optional `parentRunId`
- provider adapter, role/kind, display label, status, attention
- started/updated/completed timestamps
- bounded tool/usage summary
- opaque server-only provider run identity

Child runs form an acyclic bounded-depth graph. The runtime enforces child-count,
depth, concurrent-run, and event-rate limits.

### RuntimeBinding

Records where provider work is executing and supports audited handoff.

- `bindingId`, `threadId`, `runtimeId`, optional `runId`
- state: `preparing`, `active`, `detaching`, `detached`, `failed`
- project/worktree/provider compatibility fingerprint
- started/ended timestamps and safe failure code

Only one provider runtime binding may be active per conversation. Handoff uses a
transactional state transition and idempotency key; a failed destination start
must leave the source binding active or mark a recoverable detached state.

### TerminalBinding

Many-to-many association over existing canonical terminal sessions.

- `terminalBindingId`, canonical `terminalSessionId`
- required `projectId`; optional `taskId`, `threadId`, `runId`
- role: `primary`, `agent`, `user`, `preview`, `setup`
- state: `bound`, `detached`, `ended`
- timestamps and bounded display metadata

Terminal output remains owned by the canonical terminal subsystem. This table
stores references only and never creates a second terminal model.

### RepositoryContext

Safe projection of a validated owner project/worktree checkout.

- project/worktree IDs, branch, upstream, head SHA
- staged/unstaged/untracked/conflict counts and bounded changed-file metadata
- active preview summaries and linked review snapshots

Git credentials, remotes containing credentials, raw process errors, and
unbounded command output never cross the gateway boundary.

### AttentionItem

Durable owner-scoped attention record.

- `attentionId`, owner/runtime/project/thread/run references
- kind: approval, input, failed, completed, review-ready, unread, handoff
- priority, state (`open`, `acknowledged`, `resolved`, `expired`)
- safe title/body, occurrence/expiry/resolution timestamps
- dedupe key and optional notification routing target

### ConversationParticipant

Optional shared/org access record.

- owner-scoped conversation and principal ID
- role: `owner`, `editor`, `viewer`
- grant/revoke timestamps and granting principal
- no inherited provider credentials

Approval policy determines whether editors may decide an approval. Viewers can
never mutate provider, terminal, file, or source-control state.

Every durable entity in this document inherits the conversation's explicit
`scopeType` and `scopeId` or carries its own validated owner scope. Personal,
org, and shared records never join through an unscoped identifier. Scope changes
are explicit audited migrations, not ordinary participant edits.

### CodingAutomation

References the existing Matrix scheduler/action system rather than creating a
second scheduler. It binds a validated action to optional runtime/project/task/
thread context, owner/org policy, approval requirements, schedule/trigger,
enabled state, and last safe outcome.

### CodingFeaturePolicy

Server-authored effective policy derived from runtime capability, owner/org
settings, entitlement, retention, and enterprise auth. It may disable actions or
shorten limits but never grants access beyond the authenticated principal.

### RecoveryCheckpoint

Bounded runtime-owned reconciliation metadata for active turns, queue claims,
execution runs, handoffs, terminal bindings, and pending attention. It contains
no transcript/file/terminal bytes and is consumed during gateway startup.

## Persistence And Migration

The current bounded owner file at `system/coding-agents/threads.json` remains the
active source until the B25-009 cutover transaction commits its authoritative
marker. It is not sufficient durable storage for complete transcript history,
queues, graphs, bindings, or collaboration.

After that marker commits, the V2 source of truth MUST use the existing
owner-controlled Postgres and the gateway's existing Kysely lifecycle; the file
becomes bounded import/export/rollback compatibility only. Additive tables:

- `coding_agent_threads`
- `coding_agent_turns`
- `coding_agent_transcript_entries`
- `coding_agent_pending_messages`
- `coding_agent_execution_runs`
- `coding_agent_runtime_bindings`
- `coding_agent_terminal_bindings`
- `coding_agent_attachments`
- `coding_agent_attention_items`
- `coding_agent_review_comments`
- `coding_agent_participants`
- `coding_agent_audit_events`
- `coding_agent_idempotency_keys`
- `coding_agent_profiles`
- `coding_agent_provider_quota_snapshots`
- `coding_agent_automations` only when the canonical Matrix scheduler requires a
  relational coding-context projection; schedules remain owned by that scheduler
- `coding_agent_recovery_checkpoints`

Provider credentials and opaque provider resume material remain server-only in
existing owner credential/config conventions. Database rows may store encrypted
or opaque references, never raw renderer/mobile-visible secrets.

`coding_agent_audit_events` is the owner-Postgres source of truth for coding
workspace audit evidence. Each row carries scope type/ID, actor principal,
bounded action/target/result codes, correlation/idempotency ID, revision, and
timestamps, never content or credentials. A local privileged mutation appends
its audit row in the same transaction as the state change. A non-compensable
external outcome is reconciled first and then finalized with an idempotent audit
row. Audit retention, authorized export, and scope deletion use the canonical
owner/org policy; audit tombstones do not silently refresh on retry.

Platform Postgres remains authoritative for computer inventory, verified org
membership/roles, preview environments, and platform policy. Owner Postgres is
authoritative for coding-workspace user/org/shared records on the selected
computer. Inspectable skills and provider-native materializations remain owner
files; V2 stores validated IDs and immutable effective snapshots, not a duplicate
skill registry. Existing identity federation remains owned by the configured
identity provider; gateway code consumes verified claims and does not implement
new federation protocols.

Migration rules:

1. Add schema and repository tests before route changes.
2. Import the owner file idempotently with a migration ledger and `ON CONFLICT`.
3. Preserve IDs, project/task relations, event order, and archived status.
4. Dual-read only during a bounded compatibility window; Postgres wins after a
   successful import marker.
5. Do not dual-write indefinitely. Cut over writes in one reviewed layer.
6. Keep a read-only file backup/export until rollback evidence passes.
7. Gateway shutdown owns repository/pool cleanup; injected repositories never
   destroy shared pools.

Cutover uses one scope-specific gateway migration mutex plus a Postgres advisory
lock. While held, legacy mutations return a generic retryable maintenance error;
reads may continue from the last stable source. The gateway flushes the legacy
atomic writer, calculates an import checksum, and imports data plus migration
ledger in one Postgres transaction. `postgres_active` becomes visible only in
that commit. A crash before commit leaves the file authoritative and retries the
same checksum; a crash after commit makes Postgres authoritative on restart.

After `postgres_active`, all writes are Postgres-only and the compatibility
window has a fixed release/expiry. Rollback code MUST remain forward-compatible
with the V2 schema. It may export a fresh atomic owner snapshot for recovery but
MUST NOT reactivate the lossy legacy file as write source after V2-only records
exist. Checksum mismatch or partial import fails closed for mutations and emits a
safe operator-visible recovery state.

### Export And Deletion

The repository integrates with canonical Matrix owner/org export and deletion.
Exports include schema version, scope, conversations, turns, transcript,
pending/history records, runs, bindings, attachment metadata/owned objects,
attention, comments, participants, automations, and audit records the requester
is authorized to export. Provider credentials, opaque provider identities, and
unrelated participant-private data are excluded.

`DELETE /api/coding-agents/threads/:threadId` is an explicit confirmed mutation
with body limit, scope authorization, idempotency, and tombstone revision. Normal
reads and exports exclude tombstoned data unless an authorized recovery/audit
export requests it. A bounded cleanup job removes derived indexes and attachment
objects, records retry state, and never refreshes an existing tombstone.
Account/org/shared-scope deletion invokes the same repository cleanup adapter.

## HTTP Contracts

All request params, queries, bodies, and responses use `zod/v4`. Every mutation
uses auth, `bodyLimit`, ownership checks, idempotency where retryable, and one
safe error mapper.

### Route Auth Matrix

`Owner` means the personal owner or authorized org/shared owner/admin for the
record scope. `Editor` and `Viewer` exist only when collaboration is enabled.
Every route is non-public. Viewer reads remain subject to retention and field
visibility policy. Existing platform/gateway auth middleware resolves principals;
no client-supplied owner ID or client-type header grants access.

| Method | Route | Principal and authorization | Public |
| --- | --- | --- | --- |
| GET | `/api/auth/computers` | Verified Clerk or native/sync principal; list principal-owned computers only | No |
| POST | `/api/auth/runtime-selection` | Verified native/sync principal; selected runtime owned by principal; renderer cannot call directly | No |
| GET | `/api/auth/native-identity` | Verified native app session; self projection only | No |
| PUT | `/api/preview/environments/:pr` | GitHub OIDC workload for exact repository/PR/head | No |
| DELETE | `/api/preview/environments/:pr` | Same GitHub OIDC workload; exact environment ownership | No |
| POST | `/internal/preview/reap` | Cloud Scheduler/platform IAM principal | No |
| GET | `/api/coding-agents/summary` | Owner, Editor, or Viewer; scope-filtered projection | No |
| GET | `/api/coding-agents/projects/:projectId/workspace` | Owner, Editor, or Viewer with project access | No |
| GET | `/api/coding-agents/threads` | Owner, Editor, or Viewer; scope/project/task filters authorized | No |
| GET | `/api/coding-agents/threads/:threadId` | Owner, Editor, or Viewer with conversation access | No |
| GET | `/api/coding-agents/threads/:threadId/events` | Owner, Editor, or Viewer with conversation access | No |
| GET | `/api/coding-agents/threads/:threadId/transcript` | Owner, Editor, or Viewer; visibility-filtered page | No |
| GET | `/api/coding-agents/threads/:threadId/runs` | Owner, Editor, or Viewer | No |
| GET | `/api/coding-agents/threads/:threadId/terminals` | Owner, Editor, or Viewer; references only | No |
| GET | `/api/coding-agents/attention` | Authenticated principal; own attention only | No |
| POST | `/api/coding-agents/threads` | Owner or Editor with project create permission | No |
| POST | `/api/coding-agents/threads/:threadId/adopt` | Owner only; legacy unassigned conversation plus target project/task ownership | No |
| PATCH | `/api/coding-agents/threads/:threadId` | Owner or Editor; rename/metadata revision | No |
| DELETE | `/api/coding-agents/threads/:threadId` | Owner or authorized org/shared admin; explicit delete confirmation | No |
| POST | `/api/coding-agents/threads/:threadId/archive` | Owner or Editor | No |
| POST | `/api/coding-agents/threads/:threadId/unarchive` | Owner or Editor | No |
| POST | `/api/coding-agents/threads/:threadId/fork` | Owner or Editor with destination project permission | No |
| POST | `/api/coding-agents/threads/:threadId/abort` | Owner or Editor allowed by execution policy | No |
| POST | `/api/coding-agents/threads/:threadId/handoff` | Owner only; source and destination runtime ownership | No |
| GET | `/api/coding-agents/provider-sessions` | Owner only; server-side discovery | No |
| POST | `/api/coding-agents/provider-sessions/:providerSessionId/import` | Owner only; valid expiring import handle/project scope | No |
| POST | `/api/coding-agents/threads/:threadId/turns` | Owner or Editor allowed by execution policy | No |
| POST | `/api/coding-agents/threads/:threadId/turns/:turnId/steer` | Owner or Editor allowed by execution policy | No |
| POST | `/api/coding-agents/threads/:threadId/turns/:turnId/interrupt` | Owner or Editor allowed by execution policy | No |
| POST | `/api/coding-agents/threads/:threadId/approvals/:approvalId/decision` | Owner or Editor only when effective approval policy grants decision authority | No |
| POST | `/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer` | Owner or Editor allowed by execution policy | No |
| GET | `/api/coding-agents/threads/:threadId/pending-messages` | Owner or Editor; Viewer excluded from unpublished prompts | No |
| POST | `/api/coding-agents/threads/:threadId/pending-messages` | Owner or Editor allowed by execution policy | No |
| PATCH | `/api/coding-agents/threads/:threadId/pending-messages/:pendingMessageId` | Creator or Owner; pending state/revision required | No |
| DELETE | `/api/coding-agents/threads/:threadId/pending-messages/:pendingMessageId` | Creator or Owner; pending state/revision required | No |
| POST | `/api/coding-agents/threads/:threadId/pending-messages/reorder` | Owner or Editor; all records within same thread/revision | No |
| GET | `/api/coding-agents/providers` | Owner, Editor, or Viewer; safe metadata only | No |
| GET | `/api/coding-agents/providers/:providerId/options` | Owner or Editor; safe supported options only | No |
| GET | `/api/coding-agents/profiles` | Owner only | No |
| POST | `/api/coding-agents/profiles` | Owner only; secret values write-only | No |
| PATCH | `/api/coding-agents/profiles/:profileId` | Owner only; optimistic revision | No |
| DELETE | `/api/coding-agents/profiles/:profileId` | Owner only; reject active references or detach explicitly | No |
| GET | `/api/coding-agents/prompt-assets` | Owner or authorized org/shared member; scope-filtered | No |
| GET | `/api/coding-agents/usage` | Owner only; coarse summaries | No |
| POST | `/api/coding-agents/terminal-bindings` | Owner or Editor with canonical terminal access | No |
| DELETE | `/api/coding-agents/terminal-bindings/:terminalBindingId` | Owner or Editor; relation ownership required | No |
| POST | `/api/coding-agents/attachments` | Owner or Editor; scope/quota/MIME policy | No |
| GET | `/api/coding-agents/attachments/:attachmentId` | Owner, Editor, or Viewer with conversation/message visibility | No |
| DELETE | `/api/coding-agents/attachments/:attachmentId` | Uploader or Owner; reject active message references unless deleting parent record | No |
| GET | `/api/coding-agents/files/browse` | Owner, Editor, or Viewer with project/worktree access | No |
| GET | `/api/coding-agents/files/search` | Owner, Editor, or Viewer with project/worktree access | No |
| GET | `/api/coding-agents/files/read` | Owner, Editor, or Viewer with project/worktree access | No |
| POST | `/api/coding-agents/files/write` | Owner or Editor with project/worktree write permission | No |
| GET | `/api/coding-agents/reviews` | Owner, Editor, or Viewer; scope-filtered summaries | No |
| GET | `/api/coding-agents/reviews/:reviewId` | Owner, Editor, or Viewer with review/project access | No |
| GET | `/api/coding-agents/source-control/status` | Owner, Editor, or Viewer with worktree access | No |
| POST | `/api/coding-agents/source-control/commits` | Owner or Editor with source-control permission | No |
| POST | `/api/coding-agents/source-control/branches` | Owner or Editor with source-control permission | No |
| POST | `/api/coding-agents/source-control/branches/switch` | Owner or Editor; clean/conflict policy | No |
| POST | `/api/coding-agents/source-control/stashes` | Owner or Editor | No |
| POST | `/api/coding-agents/source-control/stashes/:stashId/apply` | Owner or Editor; server-issued stash ID | No |
| POST | `/api/coding-agents/source-control/pull` | Owner or Editor; configured remote only | No |
| POST | `/api/coding-agents/source-control/push` | Owner or Editor; configured remote/no force | No |
| POST | `/api/coding-agents/source-control/worktrees` | Owner or Editor; validated project/branch/root | No |
| DELETE | `/api/coding-agents/source-control/worktrees/:worktreeId` | Owner; Matrix-created clean worktree plus confirmation token | No |
| POST | `/api/coding-agents/source-control/pull-requests` | Owner or Editor; configured Git host/repository | No |
| POST | `/api/coding-agents/source-control/prepare-commit` | Owner or Editor; compatibility alias to bounded commit preparation | No |
| GET | `/api/coding-agents/reviews/:reviewId/comments` | Owner, Editor, or Viewer | No |
| POST | `/api/coding-agents/reviews/:reviewId/comments` | Owner or Editor | No |
| PATCH | `/api/coding-agents/reviews/:reviewId/comments/:commentId` | Comment author or Owner; optimistic revision | No |
| POST | `/api/coding-agents/attention/:attentionId/acknowledge` | Attention owner only | No |
| GET | `/api/coding-agents/notification-preferences` | Authenticated principal; own preferences only | No |
| PUT | `/api/coding-agents/notification-preferences` | Authenticated principal; own preferences only | No |
| GET | `/api/coding-agents/threads/:threadId/participants` | Owner, Editor, or Viewer | No |
| POST | `/api/coding-agents/threads/:threadId/participants` | Owner or authorized org/shared admin | No |
| DELETE | `/api/coding-agents/threads/:threadId/participants/:participantId` | Owner or authorized org/shared admin | No |
| GET | `/api/coding-agents/memory/search` | Owner, Editor, or Viewer; scope/retention filtered | No |
| GET | `/api/coding-agents/automations` | Owner or authorized org/shared admin; scope-filtered | No |
| POST | `/api/coding-agents/automations` | Owner or authorized org/shared admin | No |
| PATCH | `/api/coding-agents/automations/:automationId` | Owner or authorized org/shared admin; revision required | No |
| DELETE | `/api/coding-agents/automations/:automationId` | Owner or authorized org/shared admin | No |
| GET | `/api/coding-agents/feature-policy` | Any authenticated conversation principal; effective self policy | No |
| GET | `/api/coding-agents/recovery` | Owner only; safe state counts/codes | No |
| POST | `/api/coding-agents/diagnostics/snapshot` | Owner only; explicit consent | No |
| POST | `/api/coding-agents/exports` | Owner or authorized org/shared admin; scope-filtered export job | No |
| GET | `/api/coding-agents/exports/:exportId` | Export requester or authorized scope admin | No |
| GET | `/api/terminal/sessions` | Authenticated owner; canonical bounded owner-scoped sessions | No |
| DELETE | `/api/terminal/sessions/:id` | Authenticated owner; validated session ID and body-limited explicit end | No |
| WS | `/ws/terminal` | Authenticated owner; explicit query-token allowlist where required, auth awaited before attach/create/resume success | No |
| WS | `/ws/coding-agents/thread/:threadId` | Owner, Editor, or Viewer; auth awaited before replay/live success | No |

Preview summaries remain part of authenticated coding-agent summary/workspace
reads; app-preview launch routes retain their existing platform/app-session auth
and are not expanded by this proposal. Every role extension above is added only
after collaboration authorization tests pass.

### Hydration And Transcript

- `GET /api/coding-agents/summary`
- `GET /api/coding-agents/projects/:projectId/workspace`
- `GET /api/coding-agents/threads/:threadId`
- `GET /api/coding-agents/threads/:threadId/transcript`
- `GET /api/coding-agents/threads/:threadId/runs`
- `GET /api/coding-agents/threads/:threadId/terminals`
- `GET /api/coding-agents/attention`

Transcript query supports exactly one direction per request:
`beforeSeq`, `afterSeq`, or latest. Limit is server-clamped. Responses include
sequence bounds, `hasMoreBefore`, `hasMoreAfter`, and optional gap metadata.

### Conversation Lifecycle

- `POST /api/coding-agents/threads`
- `PATCH /api/coding-agents/threads/:threadId`
- `POST /api/coding-agents/threads/:threadId/archive`
- `POST /api/coding-agents/threads/:threadId/unarchive`
- `POST /api/coding-agents/threads/:threadId/fork`
- `POST /api/coding-agents/threads/:threadId/abort`
- `POST /api/coding-agents/threads/:threadId/handoff`
- `GET /api/coding-agents/provider-sessions`
- `POST /api/coding-agents/provider-sessions/:providerSessionId/import`

Provider-session discovery returns only bounded safe metadata and an opaque
server-issued import token. It never exposes provider filesystem paths or resume
identities.

### Turns, Queue, And Steering

- `POST /api/coding-agents/threads/:threadId/turns`
- `POST /api/coding-agents/threads/:threadId/turns/:turnId/steer`
- `POST /api/coding-agents/threads/:threadId/turns/:turnId/interrupt`
- `GET /api/coding-agents/threads/:threadId/pending-messages`
- `POST /api/coding-agents/threads/:threadId/pending-messages`
- `PATCH /api/coding-agents/threads/:threadId/pending-messages/:pendingMessageId`
- `DELETE /api/coding-agents/threads/:threadId/pending-messages/:pendingMessageId`
- `POST /api/coding-agents/threads/:threadId/pending-messages/reorder`

Normal turns retain the existing one-active-turn conflict. Queueing is always an
explicit user action. If steering is unsupported, the server returns a safe
capability error and does not silently convert it into another behavior.

### Provider Controls And Assets

- `GET /api/coding-agents/providers`
- `GET /api/coding-agents/providers/:providerId/options`
- `GET|POST|PATCH|DELETE /api/coding-agents/profiles[...]`
- `GET /api/coding-agents/prompt-assets`
- `GET /api/coding-agents/usage`

Secret values are write-only through trusted setup paths. Read responses contain
safe labels, availability, and secret-reference presence only.

### First-Release Provider Matrix

All provider-specific behavior stays behind normalized gateway adapters. A
detected executable is an installation signal, not proof of lifecycle support.

| Release tier | Required providers | Release expectation |
| --- | --- | --- |
| First-class | Claude Code, Codex, Pi, OpenCode | Install/auth health, create, normalized streaming, abort, restart recovery, safe errors, and every advertised capability pass fake plus real-process tests. |
| First-class protocol family | Custom ACP-compatible backends | Validated command/profile configuration and ACP protocol conformance; no arbitrary argument execution or client-held credentials. |
| Compatibility | Kiro, GitHub Copilot CLI, Qwen Code, Kimi CLI, Kilo Code, Auggie | Shipped behind per-provider flags with the same baseline lifecycle tests; unsupported advanced controls remain explicitly disabled. |
| Excluded | Gemini CLI | No dedicated built-in adapter, setup action, release promise, or shell option in this release. A safe user-controlled custom ACP label does not become a built-in identity and is not rejected solely for matching this name. |

The capability registry is granular by provider and runtime kind. Same-thread
resume, session discovery/import, fork, rollback, steering, approvals, image
input/output, model/mode/reasoning controls, and cross-computer handoff are never
inferred from another provider and never emulated by silently creating a new
conversation. A compatibility adapter may ship with fewer controls, but it must
still preserve canonical Matrix thread identity and return a safe unsupported
state for unavailable operations.

### Terminals, Attachments, Repository, And Review

- `POST /api/coding-agents/terminal-bindings`
- `DELETE /api/coding-agents/terminal-bindings/:terminalBindingId`
- `POST /api/coding-agents/attachments`
- existing bounded file/review/preview routes
- `GET /api/coding-agents/source-control/status`
- `POST /api/coding-agents/source-control/commits`
- `POST /api/coding-agents/source-control/branches`
- `POST /api/coding-agents/source-control/branches/switch`
- `POST /api/coding-agents/source-control/stashes`
- `POST /api/coding-agents/source-control/stashes/:stashId/apply`
- `POST /api/coding-agents/source-control/pull`
- `POST /api/coding-agents/source-control/push`
- `POST /api/coding-agents/source-control/worktrees`
- `DELETE /api/coding-agents/source-control/worktrees/:worktreeId`
- `POST /api/coding-agents/source-control/pull-requests`
- `GET|POST|PATCH /api/coding-agents/reviews/:reviewId/comments[...]`

Source-control mutations operate only in validated owner worktrees. External
network operations have `AbortSignal`, redirect/host policy where applicable,
bounded output, and generic client failures.

Each operation has its own Zod body schema; no generic command/argument record is
accepted. Owner/editor policy may allow ordinary operations; viewers never
mutate. Force push, arbitrary remotes, arbitrary Git arguments, destructive
branch deletion, and removal of unclean/unmanaged worktrees are excluded from
the first rollout. Worktree removal requires a server-issued confirmation token,
proof the worktree was Matrix-created, and a clean-state check. Branch/worktree
names use strict safe schemas. Pull/push never accept user-controlled remote URLs.

| Operation | Preconditions and failure/atomicity policy |
| --- | --- |
| Status | Read-only bounded porcelain parser; never returns credential-bearing remotes or unbounded paths. |
| Commit | Exact validated file set and expected repository head; snapshot/restore prior index on pre-commit failure; successful commit returns immutable SHA and idempotent retry returns it. Partial staging failure creates no commit. |
| Branch create | Strict branch name and expected head; create only, no implicit checkout; existing exact branch is an idempotent success only when it points to the expected SHA. |
| Branch switch | Reject dirty/conflicted worktree and active incompatible run; never auto-stash, reset, or discard edits. |
| Stash create | Explicit include-untracked flag, expected head, bounded message; return opaque stash ID. Failure preserves working tree. |
| Stash apply | Server-issued stash ID and clean/conflict preflight; on conflict retain the stash and report coarse conflict state, never auto-resolve. |
| Pull | Configured tracked remote only, clean worktree, no active write run, `ff-only`; divergence/conflict is a safe non-mutating failure. No implicit merge or rebase. |
| Push | Configured tracked remote only, no force/delete, expected local head. Remote acceptance is non-compensable; persist returned head/result before success and make retry observationally idempotent. |
| Worktree create | Managed owner root, strict branch/path allocation, exclusive create, expected repository head, and idempotency key. Cleanup only resources created by the failed request. |
| Worktree remove | Matrix-created record, clean worktree, no active binding/run, server confirmation token, and idempotent tombstone before filesystem cleanup. |
| Pull request create | Configured Git host/repository, validated head/base/title/body, branch already pushed; idempotent lookup by repository/head/base returns an existing URL before create. |

Every operation emits an audit event after its durable local/remote outcome is
known. Remote timeout after an ambiguous push/PR result triggers bounded status
reconciliation before retry, not blind repetition.

### Attention And Collaboration

- `POST /api/coding-agents/attention/:attentionId/acknowledge`
- existing approval and input decision routes
- `GET|POST|DELETE /api/coding-agents/threads/:threadId/participants[...]`

Participant mutations require owner or org-authorized administration and write
an audit event. Collaboration remains capability-gated until org/shared ownership
is available on the selected runtime.

### Memory, Automation, Policy, And Support

- `GET /api/coding-agents/memory/search`
- `GET|POST|PATCH|DELETE /api/coding-agents/automations[...]`
- `GET /api/coding-agents/feature-policy`
- `GET /api/coding-agents/recovery`
- `POST /api/coding-agents/diagnostics/snapshot`

Memory search reuses the existing owner memory/index service and returns bounded
structured references/snippets only. It cannot bypass conversation/project
authorization or retention. Voice invokes the same turn, queue, approval,
attention, and automation services through validated typed actions; it never gets
a privileged provider shortcut.

Diagnostics and bug reports reuse Matrix's canonical support path. Coding-
workspace snapshots contain versions, capability states, counts, coarse timing,
safe lifecycle codes, and redacted correlation IDs only. They exclude transcript
text, prompts, tool/terminal output, file content/diffs, secrets, paths, private
hosts, and provider errors. Retention and feature policy are server-enforced at
read, write, export, collaboration, and cleanup boundaries.

## Realtime Contract

The canonical authenticated thread WebSocket evolves additively:

- server hello includes contract version, current sequence, limits, and enabled
  frame capabilities
- replay frames carry monotonic transcript sequence and event cursor
- live frames distinguish transcript entries, execution updates, queue updates,
  attention updates, terminal-binding references, and projection-invalidated
- client frames are limited to subscribe, replay request, acknowledgement, and
  keepalive; mutations remain authenticated HTTP routes

The stream MUST authenticate before success, validate every frame, cap frame
size/subscribers/replay windows, evict stale/dead senders, isolate send failures,
and drain on shutdown. A shell reconnects with its last in-memory cursor and
rehydrates from HTTP when the cursor is too old.

## Provider Adapter Contract

Adapters remain server-side and normalized. Optional methods are advertised as
capabilities:

- `discoverSessions`
- `importSession`
- `startConversation`
- `resumeTurn`
- `steerTurn`
- `interruptTurn`
- `forkConversation`
- `handoffConversation`
- `listModelsAndModes`
- `readUsageSummary`
- `startChildRun`

Every method receives `AbortSignal`, bounded input, owner/project/worktree policy,
and a server-owned secret resolver. Adapter output passes Zod validation before
persistence or broadcast. Unsupported methods fail safely and never fall back to
provider-specific client logic.

## Security And Resource Limits

- Transcript page: maximum 200 entries and 512 KiB encoded response.
- Live transcript entry: maximum 64 KiB after normalized structured parsing.
- Queue: maximum 100 pending messages per conversation and 24 KiB message text.
- Attachments: maximum 10 per message; MIME, byte, object-count, and owner quota
  limits are mandatory.
- Execution graph: maximum depth 4, 32 children per run, and runtime-wide active
  run cap.
- Terminal bindings: maximum 32 live bindings per conversation and bounded
  project aggregate.
- Attention, participant, profile, asset, provider-session, worktree, review, and
  repository lists are paged and server-capped.
- Every registry/cache has maximum size, TTL/LRU eviction, stale sweep, and
  shutdown drain.
- Every provider, Git host, object-store, preview, and platform call has timeout
  and cancellation.
- Browser WebSocket query-token paths remain explicit and narrowly allowlisted.
- User-facing failures use allowlisted recovery-oriented safe messages only.
- Desktop renderer receives no bearer/provider/platform credentials.
- Mobile persistence contains only bounded runtime/project/task/thread/view IDs,
  draft text within the existing safe draft policy, and timestamps. It never
  stores transcript pages, tool output, terminal output, file bytes, diffs,
  approvals, attachment bytes, or provider state.

## Backend Delivery Gates

### Gate B0 - Product Confirmation

- Product owner confirms scope and explicit non-goals.
- Desktop/mobile agents freeze contract invention. Their overlapping computer
  layers reconcile at Gate B0.5; complete workspace UI consumes only the later
  B2/B3/B4 handoffs.

### Gate B0.5 - Canonical Computer And Preview Authority

- One shared computer schema/route serves verified Clerk and native principals.
- Trusted desktop selection and mobile same-origin routing remain distinct and
  credential-safe.
- Existing native app streaming/capability routes pass unchanged.
- Preview Platform and Preview VPS use one isolated preview authority and
  independent workflow concurrency.
- Desktop and physical mobile list/select the same non-primary disposable
  computer; closing the PR removes it.

### Gate B1 - Postgres Contracts And Migration

- Add Zod schemas and Kysely tables/repository tests first.
- Prove idempotent owner-file import, rollback export, transaction boundaries,
  optimistic revisions, caps, and safe errors.

### Gate B2 - Transcript And Lifecycle

- Paged transcript, complete same-thread replay, archive/rename/fork, provider
  session discovery/import, and normalized real-provider smoke pass.
- Publish `backend-v2-shell-handoff.md` with exact capability and route versions.

At this gate desktop/mobile may build list, transcript, composer, and lifecycle
surfaces against a preview computer.

### Gate B3 - Queue, Steering, Runs, And Attention

- Pending queue, steering/interrupt, child execution graph, and durable attention
  inbox pass fake and real-provider tests.
- The complete first-release provider matrix passes its conformance tier and
  publishes a real-process-backed capability snapshot.

### Gate B4 - Terminals, Repository, Review, And Attachments

- Many-terminal bindings, repository state/mutations, review comments, and
  attachment references pass security and cross-shell tests.

### Gate B5 - Handoff And Collaboration

- Cross-computer handoff and owner/editor/viewer authorization pass transactional,
  failure, expiry, and audit tests.

### Gate B6 - Preview Acceptance

- Deploy the exact backend top to a disposable preview computer.
- Desktop and mobile use the same preview runtime and real project fixture.
- Exercise transcript history, two conversations on one task, queued message,
  approval, child run, two terminals, file edit, diff/review, preview, runtime
  switch, reconnect, archive/fork, and notification attention.
- Run security, unsafe-error, performance, restart, and rollback audits.

## Graphite Backend Stack

Each layer is ready for review and stays under repository review-size limits:

1. `docs(agent-shells): specify full coding workspace backend`
2. `feat(platform): unify computer inventory contracts`
3. `fix(preview): isolate disposable computer authority`
4. `feat(contracts): add coding workspace v2 schemas`
5. `feat(gateway): persist coding workspace history`
6. `feat(gateway): add transcript and lifecycle routes`
7. `feat(gateway): add queue and steering lifecycle`
8. `feat(gateway): add execution graph and attention inbox`
9. `feat(gateway): add provider profiles and assets`
10. `feat(coding-agents): add first-class provider adapters`
11. `feat(coding-agents): add compatibility provider adapters`
12. `feat(gateway): add terminal and repository bindings`
13. `feat(gateway): add runtime handoff and collaboration`
14. `feat(coding-agents): integrate memory automation and policy`
15. `feat(coding-agents): add thin shell v2 clients`
16. `test(coding-agents): validate preview workspace backend`

The spec PR is independent of the current desktop and mobile UI stacks. Backend
implementation starts from current `main`. A disposable integration/preview
branch may combine the backend top with shell branches for testing, but that
branch is never the persistence source of truth and is not merged as a shortcut.

The existing shell stacks preserve their parent lineage. After a shared backend
layer merges, they restack bottom-up; an isolated top branch is never rebased
directly onto `main` in a way that drops its reviewed parents. Computer selection
may finish after B0.5. Transcript/lifecycle UI waits for B2, queue/run/attention
UI waits for B3, and terminal/repository/attachment UI waits for B4.

## Shell Handoff Rule

Desktop and mobile agents consume only contracts marked available in the backend
handoff. They may use deterministic fixtures before a gate, but they MUST NOT:

- invent missing server fields or derive canonical status client-side
- persist transcript/tool/file/terminal/provider payloads
- add provider-specific branches
- replace a server queue with local optimistic records
- treat a preview deployment as proof of release readiness

Every shell PR records the backend contract version and preview bundle used for
its acceptance evidence.
