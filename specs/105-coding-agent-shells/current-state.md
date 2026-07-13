# Current State: Coding Agent Shells

**Branch stack**: implementation checkpoint merged to `main` through PR #869 (`056b3da668ed6d1753712120316d2d5accfafdcf`)
**Updated**: 2026-07-12
**Scope**: Inventory for the coding-agent desktop/mobile shell work. This file records the current Matrix-native route, contract, client, and regression-test state so later slices keep gateway/runtime as source of truth and keep desktop/mobile as thin shells.

For the evidence-based checkpoint audit, see [completion-audit.md](./completion-audit.md).

## Summary

### Clarified Final-Version Gap

The landed checkpoint is not the confirmed final information architecture. Current evidence shows these explicit gaps:

- `RuntimeSummarySchema` now hydrates stable bounded canonical owner project summaries with task/active-thread/attention counts and safe timeout degradation. The authenticated project workspace route returns independently paginated canonical tasks, project-level chats, task-bound chats, and bounded task aggregates.
- Coding threads carry optional `projectId`/`taskId`; the read model quarantines stale cross-project task relations, and the shell-create path now requires an owned canonical project plus a same-project canonical task when provided. Legacy unassigned records remain read-compatible and can be adopted exactly once through an explicit idempotent owner-scoped mutation. Persisted public thread changes publish bounded project/task workspace activity events.
- Existing task UI has one `linkedSessionId`; it cannot be used as the source of truth for coding conversations because one task must support several independent threads.
- The current desktop `AgentWorkspace` is a sectioned dashboard. It does not provide the required persistent project/task/thread navigator or a segmented Conversation/Kanban mode over one selected project.
- The pending PR #926 mobile Agents route provides an attention-first cockpit with Needs attention, Working, and bounded Recent groups plus thread detail, but not project-first task/thread navigation or a Kanban mode.
- Current desktop/mobile follow-up controls still seed a new thread with a structured reference. The gateway now supports same-thread turns and workspace-session resume, but shell clients have not switched to that route yet. Delivering input to a running workspace session settles that turn without marking the thread complete; canonical session-stop reconciliation owns terminal thread status.
- Existing desktop Kanban task routes/statuses are canonical and reusable, but coding-thread aggregates and multi-thread task navigation are not integrated into that board.

The clarified target and required evidence are defined in `SPEC.md`, `ARCHITECTURE.md`, `plan.md`, `tasks.md`, and `acceptance-tests.md`. No implementation completion claim should treat the existing dashboard/create path as proof of those requirements.

### Full Workspace Backend Gap

The current gateway is also not yet the complete backend required by the final
session-first coding workspace. The proposed expansion is specified in
`FULL-WORKSPACE-BACKEND.md`. Current limitations include:

- the bounded owner file is not suitable for complete durable transcript,
  pending queue, execution graph, binding, attention, or collaboration history
- snapshots expose bounded recent events but not stable backward/forward
  transcript pages or provider-session discovery/import
- busy turns reject correctly, but there is no explicit durable pending-message
  queue, edit/reorder/remove lifecycle, or normalized steering operation
- provider options do not yet provide the complete normalized model/mode/
  reasoning/profile/prompt/skill/MCP capability surface
- one task supports many conversations, but conversations do not yet expose a
  durable bounded parent/child execution graph
- coding-agent state can reference a terminal, but it does not yet model several
  role-labelled canonical terminal bindings per project/task/thread/run
- file/review/preview/source-control foundations exist, but repository status,
  full bounded Git operations, durable review comments, and attachment objects
  are incomplete
- attention notifications exist, but there is no durable paged inbox with
  acknowledgement/resolution semantics across all attention kinds
- cross-computer conversation handoff and owner/editor/viewer collaboration are
  not implemented

The current desktop preview stack and mobile stack are visual/client
checkpoints. The backend expansion remains based on `main` and will deploy to a
separate disposable preview computer. Both clients will test against that same
backend preview after Gate B2; no shell branch becomes the backend source of
truth.

### Computer And Preview Contract Conflict

The paused desktop and mobile stacks independently introduced different computer
inventory schemas and read routes. The canonical decision is one bounded
`GET /api/auth/computers` contract with server-derived runtime slot, route,
availability, capabilities, and nullable selected slot. Verified Clerk and
native/sync principals use the same owner-scoped projection. Desktop runtime
credential exchange remains native/sync-authenticated and main-process-only;
mobile uses validated same-origin routing and does not persist runtime bearers.

The backend stack now implements that read route with a SQL-bounded owner query,
strict shared response validation, fixed safe labels, coarse release labels,
and no-store generic failures. Plain Clerk sessions do not imply a selected
runtime; only a verified native/sync principal bound back to its current owner
machine can publish `selectedSlot`. The paused desktop and mobile branches still
need to adopt this shared route.

The backend stack also implements runtime credential replacement only on an
explicit dedicated API origin. The selection route accepts one Authorization
sync bearer, ignores cookies and Clerk fallback, rebinds its claims to the
current owner machine, requires a running owner target, and never extends the
source credential expiry. App/code hosts receive no replacement bearer; mobile
continues to use validated same-origin `/vm/{handle}` routing.

The existing Platform Preview and Preview VPS workflows do not yet form one
isolated authority. The target preview environment owns a dedicated preview
database/JWT/edge/provisioning/provider boundary, exact PR/head/bundle,
disposable computer, TTL/reaper, and teardown. It cannot access production
provisioning credentials and must preserve existing native app HTTP/WebSocket
streaming behavior. This Gate B0.5 work precedes merging either shell's computer
selection layer. Canonical inventory paths preserve handle-only primary routing
and add the validated `runtime` query only for non-primary slots that may share
a handle.

The stack currently has shared contracts, a gateway runtime summary read model, a gateway-owned bounded attention summary, a read-only preview summary adapter, owner-worktree file browse/search/read/write routes, read-only desktop and mobile workspaces behind flags, thread create/replay/abort/event streaming, provider adapters, a workspace-backed provider, approval/input route handling, a read-only coding-agent review summary route/client contract, desktop/mobile read-only review summary panels, and a read-only coding-agent review snapshot route with bounded file metadata from safe owner worktree diffs plus findings fallback metadata. Review snapshots can include bounded per-hunk diff lines with truncation markers. Runtime summaries now include bounded `previewSessions` from existing workspace preview records and expose only local preview origins without path/query data. Preview summaries carry an optional bounded project reference for project-scoped shell filtering. Desktop and mobile render those safe preview summary rows in their Agents workspaces when the runtime advertises `codingAgentsPreview`; desktop preview rows open a local inspector with an external-open action only for HTTPS origins through the existing safe desktop IPC path, mobile preview rows open a phone-first preview route that accepts only the bounded preview id, rehydrates the current authenticated runtime summary, renders only currently running HTTPS origins through the existing app runtime frame, and can hand that same authoritative HTTPS origin to the OS browser, and the browser Workspace preview panel validates the same `RuntimeSummarySchema` before showing active-project coding-agent preview origin/status rows, with direct browser launch limited to HTTPS origins. Gateway file browse/search requires project/worktree references, optional bounded directory paths, capped limits, owner access, safe worktree-root validation, and symlink skipping; desktop and mobile have thin validated clients for those read-only file list/search routes without storing file contents or credentials. Desktop and mobile review details now expose transient browse/search controls that call those trusted clients, render only bounded file metadata, and hand selected files to the existing bounded editor path without persisting file contents. Gateway file reads require project/worktree/file references, stay inside validated owner worktree roots, reject symlinks, cap text content at 64 KiB, and expose a `codingAgentsFiles` capability. Gateway file writes require the same owner worktree references, a matching whole-file etag or explicit create intent, UTF-8 content within the shared cap, and return only bounded file metadata. Gateway source control can prepare a local commit and create or return an existing GitHub pull request from a validated owner worktree without exposing credentials or raw command errors to clients; desktop and mobile review details can open the returned HTTPS pull request URL through their existing platform opener paths without exposing credentials. Desktop review details can request one selected review file through trusted main-process IPC, validate `FileReadResponseSchema`, render a bounded text editor, and save edited non-truncated files through a trusted main-process IPC call that validates `FileWriteRequestSchema`/`FileWriteResponseSchema` without exposing bearer credentials to the renderer. Mobile review details can request one selected review file through the authenticated gateway client, validate `FileReadResponseSchema`, render a bounded transient editor, and save edited non-truncated files through the authenticated gateway client without persisting file bytes. When the runtime advertises `codingAgentsSourceControl`, desktop and mobile review details can prepare a local source-control commit for bounded reviewed file paths through trusted clients that validate `SourceControlPrepareCommitRequestSchema`/`SourceControlPrepareCommitResponseSchema`, generate shell-local idempotency request ids, and surface only generic recovery errors. Desktop and mobile dashboards render the gateway-owned `attentionThreads` summary separately from active threads so waiting and failed runs can be found without changing active-thread list semantics. Desktop and mobile review details render changed-file counts, selectable hunk coordinate metadata, and gateway-bounded diff lines. Desktop and mobile can seed their existing agent composers from a selected review hunk using bounded prompt context and a `structured_ref` attachment. Desktop Settings now shows runtime provider install/auth/setup status from the trusted summary bridge and opens foreground setup actions through canonical terminal sessions without rendering setup commands or credentials. Mobile active thread rows now open a bounded thread detail route that hydrates `AgentThreadSnapshotSchema` through the authenticated gateway client, renders safe thread metadata, event counts, in-app attention labels, and snapshot event timeline, subscribes to the existing gateway-owned coding-agent thread stream with Zod-validated frames, can hand a bound canonical terminal session to the existing mobile Terminal tab, can submit approval decisions plus user-input answers through the authenticated gateway client, and can seed the existing mobile composer with a bounded source-thread `structured_ref` follow-up without persisting transcript or terminal data. Gateway thread-event batches for approval-required, input-required, failed, and successfully completed coding-agent runs can emit owner-scoped safe push-channel notification payloads that contain only generic copy plus a bounded `threadId`, deduped by owner/thread/attention-kind inside a capped TTL registry; push registration binds tokens to the authenticated request principal, replay preserves owner and routing metadata, and mobile notification tap routing recognizes those payloads and opens the matching thread detail route when `threadId` passes the shared contract, otherwise falling back to the agent workspace. Desktop active thread rows can open a matching attachable bound canonical terminal session in the existing Terminal tab model and selected desktop threads now hydrate `AgentThreadSnapshotSchema` through trusted main-process IPC for safe metadata and event timeline rendering. Desktop approval-request events can submit allowed decisions, and desktop user-input request events can submit bounded answers, through trusted main-process IPC and replace local details with the gateway-returned bounded thread snapshot. Desktop native notification clicks focus the Agents tab and visibly select the bounded coding-agent workspace thread reference in the active thread list while attention-thread rows can open the same bounded detail path. Desktop badge counts include the gateway-owned bounded coding-agent `attentionThreads` count in addition to existing local thread attention, and use the badge overflow cap when that bounded list is truncated.

Current source-of-truth boundaries:

- Gateway/runtime owns coding-agent summaries, provider adapters, thread state, events, approvals, and terminal binding.
- Desktop gets coding-agent data through main-process IPC and never receives bearer/provider credentials.
- Mobile gets coding-agent data through the existing authenticated gateway client and stores only bounded UI references.
- Browser shell reads coding-agent preview summaries through the authenticated gateway route and validates `RuntimeSummarySchema` before rendering bounded origin/status metadata scoped to the active Workspace project.
- Canonical terminal sessions remain the existing Matrix shell/session primitives under `/api/terminal/sessions` and `/ws/terminal`.

Post-merge checkpoint updates:

- PR #868 confirmed mobile thread detail terminal handoff persists the bounded canonical terminal session reference needed by the Terminal route without persisting terminal output or transcript data.
- PR #869 confirmed the desktop command-palette Agents entry still opens after terminal interaction, and menu-template tests cover the native Agents accelerator used to focus the same workspace.

## Shared Contracts

Package: `packages/contracts/src/index.ts`

Internal developer guide: `docs/dev/coding-agent-shells.md`

Implemented coding-agent schemas:

- IDs and bounds: `RuntimeIdSchema`, `ProviderIdSchema`, `ProjectIdSchema`, `TaskIdSchema`, `ThreadIdSchema`, `EventIdSchema`, `ApprovalIdSchema`, `RequestIdSchema`, `CorrelationIdSchema`, `TerminalSessionIdSchema`, `WorktreeIdSchema`, `CursorSchema`, `IsoTimestampSchema`, `SafeDisplayStringSchema`, `SafeClientErrorSchema`.
- Runtime summary: `RuntimeTargetSchema`, `RuntimeCapabilitySchema`, `RuntimeLimitsSchema`, `RuntimeSummarySchema` with bounded `activeThreads`, separate bounded `attentionThreads`, and bounded `previewSessions`.
- Notifications: `CodingAgentAttentionNotificationKindSchema`, `CodingAgentNotificationPreferencesSchema`, and `CodingAgentNotificationPreferencesUpdateSchema` for owner-scoped attention push preferences.
- Providers: `AgentProviderSummarySchema`, provider availability/install/auth enums, `AgentModeSchema`, `ApprovalPolicySchema`, `SandboxModeSchema`, `SafeSetupActionSchema`.
- Threads: `CreateAgentThreadRequestSchema`, `AgentThreadSummarySchema`, `AgentThreadStatusSchema`, `AgentAttachmentSchema`, `AgentThreadSnapshotSchema`.
- Events: `AgentThreadEventSchema` discriminated union with lifecycle, text delta, tool activity, approval/input, file change, review ready, terminal bound, safe error, and completion event variants.
- Approvals/input: `AgentApprovalRequestSchema`, `ApprovalDecisionRequestSchema`, `UserInputRequestSchema`, `UserInputAnswerRequestSchema`.
- Terminal frames/summaries: `TerminalSessionSummarySchema`, `TerminalClientFrameSchema`, `TerminalServerFrameSchema`.
- File/review/preview: `FilePathSchema`, `FileMetadataSchema`, `ReviewSummarySchema`, `ReviewFileDiffSchema`, `ReviewDiffLineSchema`, `ReviewDiffHunkSchema`, `ReviewFindingSummarySchema`, `ReviewSnapshotFileSchema`, `ReviewSnapshotSchema`, `PreviewSessionSummarySchema`.
- File browse/search/read/write/source control: `FileBrowseRequestSchema` and `FileBrowseResponseSchema` for capped owner-worktree directory listings; `FileSearchRequestSchema` and `FileSearchResponseSchema` for capped owner-worktree path search; `FileReadRequestSchema` and `FileReadResponseSchema` for bounded owner-worktree text snapshots; `FileWriteRequestSchema` and `FileWriteResponseSchema` for bounded owner-worktree UTF-8 writes with a required base etag or explicit create intent; `SourceControlPrepareCommitRequestSchema` and `SourceControlPrepareCommitResponseSchema` for bounded local commit preparation in validated owner worktrees; `SourceControlCreatePullRequestRequestSchema` and `SourceControlCreatePullRequestResponseSchema` for gateway-owned pull request creation metadata.

Contract tests:

- `tests/contracts/coding-agents.test.ts`

## Gateway HTTP Routes

Coding-agent route module: `packages/gateway/src/coding-agents/routes.ts` mounted under `/api/coding-agents`.

Implemented routes:

| Route | Method | State | Notes |
| --- | --- | --- | --- |
| `/api/coding-agents/summary` | `GET` | Implemented | Authenticated runtime summary. Returns `RuntimeSummarySchema`. |
| `/api/coding-agents/projects` | `POST` | Implemented | Authenticated scratch-project create or GitHub import. Uses a 4 KiB body limit, validates `CodingAgentProjectCreateRequestSchema`, persists the verified principal as owner, retries idempotently by `clientRequestId`, and returns only `CodingAgentProjectCreateResponseSchema` without local paths or internal project metadata. |
| `/api/coding-agents/projects/:projectId/workspace` | `GET` | Implemented | Authenticated owner-scoped project read model. Validates independent task/project-chat/task-chat cursors and limits, joins canonical tasks to bounded thread aggregates, and quarantines stale cross-project task relations. Returns `ProjectAgentWorkspaceSchema`. |
| `/api/coding-agents/threads` | `POST` | Implemented | Validates `CreateAgentThreadRequestSchema`, body limit 128 KiB, requires an owned canonical project and same-project task when provided, and is idempotent by `clientRequestId` before relation validation or provider launch. |
| `/api/coding-agents/threads/:threadId/adopt` | `POST` | Implemented | Validates `AdoptAgentThreadRequestSchema`, body limit 4 KiB, owner/project/task relations, and adopts only a fully unassigned legacy thread. Exact relation retries return `already_adopted`; assigned threads cannot be moved through this compatibility route. |
| `/api/coding-agents/threads` | `GET` | Implemented | Authenticated bounded thread list. |
| `/api/coding-agents/threads/:threadId` | `GET` | Implemented | Authenticated snapshot replay for one thread. No-cursor snapshots return the latest bounded event window. |
| `/api/coding-agents/threads/:threadId/events` | `GET` | Implemented | Authenticated snapshot replay with optional cursor. |
| `/api/coding-agents/threads/:threadId/abort` | `POST` | Implemented | Body limit 8 KiB, idempotent abort by client request id. |
| `/api/coding-agents/threads/:threadId/approvals/:approvalId/decision` | `POST` | Implemented | Body limit 8 KiB, validates approval id and decision payload. |
| `/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer` | `POST` | Implemented | Body limit 40 KiB, validates bounded answer payload. |
| `/api/coding-agents/threads/:threadId/turns` | `POST` | Implemented | Auth/body/param/request/owner/relation/state checks, atomic persisted idempotency, one-active-turn ownership, bounded normalized dispatch, server-only resume state, terminal request-body cleanup, timeout/abort handling, and startup/shutdown release are implemented. Gateway startup reconciles persisted ownership before registering the route and advertising `codingAgentsSameThreadTurns`; the workspace provider resumes the deterministic canonical session through signal-aware zellij input. |
| `/api/coding-agents/reviews` | `GET` | Implemented | Authenticated read-only review summary list. Returns bounded `ReviewSummarySchema` items only. |
| `/api/coding-agents/reviews/:reviewId` | `GET` | Implemented | Authenticated read-only review snapshot. Returns bounded `ReviewSnapshotSchema` with partial findings-derived file metadata and bounded hunk diff lines when available; no full file contents. |
| `/api/coding-agents/files/browse` | `GET` | Implemented | Authenticated owner-checkout directory browse. Validates `projectId`, optional `worktreeId`, optional `path`, and capped `limit`; omitting `worktreeId` selects the primary project checkout. Rejects traversal/symlinks, skips symlink entries, and returns `FileBrowseResponseSchema`. |
| `/api/coding-agents/files/search` | `GET` | Implemented | Authenticated owner-checkout path search. Validates `projectId`, optional `worktreeId`, optional `path`, bounded `query`, and capped `limit`; omitting `worktreeId` selects the primary project checkout. Searches within a bounded visit budget, skips symlink entries and heavy generated directories, and returns `FileSearchResponseSchema`. |
| `/api/coding-agents/files/read` | `GET` | Implemented | Authenticated read-only owner-checkout text snapshot. Validates `projectId`, optional `worktreeId`, and `path`; omitting `worktreeId` selects the primary project checkout. Rejects traversal/symlinks, caps content at 64 KiB, and returns `FileReadResponseSchema`. |
| `/api/coding-agents/files/write` | `POST` | Implemented | Authenticated owner-worktree UTF-8 write. Validates `FileWriteRequestSchema`, applies a 512 KiB JSON body limit for escaped 64 KiB content, rejects traversal/symlinks, caps content at 64 KiB, preserves existing file mode on replace, rejects updates from truncated snapshots, requires matching `baseEtag` for updates or `baseEtag: null` for creates, and returns `FileWriteResponseSchema` or safe conflict errors. |
| `/api/coding-agents/source-control/prepare-commit` | `POST` | Implemented | Authenticated owner-worktree local commit preparation. Validates `SourceControlPrepareCommitRequestSchema`, uses a body limit and bounded git operations, preserves previous staged state on rollback, and returns only `SourceControlPrepareCommitResponseSchema` metadata. |
| `/api/coding-agents/source-control/pull-requests` | `POST` | Implemented | Authenticated owner-worktree pull request creation. Validates `SourceControlCreatePullRequestRequestSchema`, detects the current branch and GitHub origin server-side, returns an existing PR for the same head branch when present, otherwise pushes the branch and creates a PR through gateway-owned credentials. Returns only `SourceControlCreatePullRequestResponseSchema` metadata. |
| `/api/coding-agents/notification-preferences` | `GET` | Implemented | Authenticated per-owner preference read. Returns `CodingAgentNotificationPreferencesSchema` defaults when no preference file exists for the authenticated owner. |
| `/api/coding-agents/notification-preferences` | `PUT` | Implemented | Authenticated per-owner preference update. Uses a 4 KiB body limit, validates `CodingAgentNotificationPreferencesUpdateSchema`, atomically writes the authenticated owner's preference file, and returns only validated preference booleans. |

Security and ownership:

- All coding-agent routes resolve a `RequestPrincipal` using the gateway auth path.
- Path params and query cursors are Zod-validated at the route boundary.
- Mutating routes use Hono `bodyLimit`.
- Route errors are mapped to safe client errors and log details server-side only.
- Gateway coding-agent route, summary, stream, provider lifecycle, and attention-notification failure diagnostics use the bounded redacted helper in `packages/gateway/src/coding-agents/diagnostics.ts` instead of raw `err.message` logging.
- Mobile gateway-client warnings use `apps/mobile/lib/coding-agent-diagnostics.ts` to log only bounded warning scopes and redacted metadata for status, parse, stream detach/close, and catch paths without raw response bodies, filesystem paths, tokens, private hosts, or database details.
- Thread store state is owner-scoped in the existing owner file convention at `system/coding-agents/threads.json`; no new embedded DB was added.
- Claude and Codex workspace launches resolve either the requested owned worktree or, when `worktreeId` is omitted, the owned project's primary checkout before the same sandbox preflight and terminal binding.

Related workspace routes in `packages/gateway/src/workspace-routes.ts`:

- Sessions: `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:sessionId`, `POST /api/sessions/:sessionId/send`, `POST /api/sessions/:sessionId/observe`, `POST /api/sessions/:sessionId/takeover`, `DELETE /api/sessions/:sessionId`. These authoritative workspace routes are mounted before the legacy `/api` terminal compatibility routes; canonical named terminal sessions remain under `/api/terminal/sessions`.
- Agent readiness: `GET /api/agents`, `GET /api/agents/sandbox-status`.
- Workspace events: `GET /api/workspace/events`.
- Reviews: `POST /api/reviews`, `GET /api/reviews`, `GET /api/reviews/:reviewId`, `POST /api/reviews/:reviewId/next`, `POST /api/reviews/:reviewId/approve`, `POST /api/reviews/:reviewId/stop`.
- Workspace data: `POST /api/workspace/export`, `DELETE /api/workspace/data`.

These routes predate the coding-agent shell contracts and remain the source for workspace/session/review behavior until dedicated coding-agent file/review/preview surfaces are integrated.

## Gateway WebSockets

Current WS endpoints relevant to coding-agent shells:

| Route | State | Notes |
| --- | --- | --- |
| `/ws` | Existing | Main gateway/kernel/sync socket. Browser auth uses existing gateway auth handling. |
| `/ws/terminal` | Existing canonical terminal socket | Supports attach/input/resize/replay/exit flow for terminal surfaces. Mobile uses this through `TerminalClient`. |
| `/ws/terminal/session` | Existing named shell-session socket | Used by shared named terminal session model. |
| `/ws/coding-agents/thread/:threadId` | Implemented | Authenticates before success, validates thread id/cursor, sends replay and live `thread.event` frames, caps pending frames and subscribers in the stream service. |

Thread streaming implementation:

- Gateway registration: `packages/gateway/src/server.ts`
- Stream service: `packages/gateway/src/coding-agents/thread-stream.ts`
- Tests: `tests/gateway/coding-agents-thread-stream.test.ts`

## Runtime Summary

Service: `packages/gateway/src/coding-agents/runtime-summary.ts`

Current summary sources:

- Runtime target metadata and server time.
- Capability flags.
- Provider summaries from the coding-agent provider registry.
- Active thread summaries from the thread store when present.
- Attention thread summaries from the thread store when present, including failed or waiting threads without changing the active-thread list semantics.
- Terminal session summaries from the existing terminal registry adapter.
- Bounded list metadata and runtime limits.

Safe degradation:

- Optional dependency failures return partial safe summaries.
- Summary tests assert caps, stable sort, attention list separation, and no sensitive fields.

Focused tests:

- `tests/gateway/coding-agents-summary.test.ts`
- `tests/gateway/coding-agents-provider-registry.test.ts`

## Providers And Thread Store

Core files:

- `packages/gateway/src/coding-agents/thread-store.ts`
- `packages/gateway/src/coding-agents/provider-registry.ts`
- `packages/gateway/src/coding-agents/workspace-provider-config.ts`
- `packages/gateway/src/coding-agents/workspace-provider.ts`
- `packages/gateway/src/coding-agents/review-summary.ts`

Implemented providers:

- Fake provider for deterministic gateway tests behind `MATRIX_CODING_AGENTS_FAKE_PROVIDER=1`.
- Workspace-backed Claude/Codex registry projections behind the bounded `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS` list. Codex is executable; Claude remains unavailable for thread creation until its launcher enforces the shared sandbox and approval contract. The legacy `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDER=1` flag remains Codex-only when the explicit list is unset.

Provider registry behavior:

- Validates a bounded configured adapter list and rejects unsafe or duplicate provider IDs at startup.
- Validates and bounds existing owner-scoped onboarding credential responses, normalizes them into coarse install and auth states, and keeps credential-known non-system providers in the runtime projection before an execution adapter is registered while marking those credential-only projections unavailable for runs.
- Fails configured providers closed to unavailable/unknown state when the credential source cannot be read, without running setup-action or health reads.
- Validates provider summaries and setup actions with shared Zod 4 schemas; malformed adapter output becomes a generic unavailable provider projection.
- Passes an `AbortSignal.timeout()` signal to summary, setup-action, and health calls.
- Caches only coarse health results in a capped owner/provider TTL cache with LRU eviction and explicit invalidation; provider credentials and raw health output are never cached or returned.

Workspace provider behavior:

- Starts deterministic workspace agent sessions through `WorkspaceSessionOrchestrator`.
- Builds one normalized registry adapter per validated configured Claude/Codex agent while sharing the same gateway-owned workspace runtime.
- Adds only Codex to the executable provider set. Claude's registry adapter reports unavailable and rejects direct execution until [#893](https://github.com/HamedMP/matrix-os/issues/893) provides equivalent sandbox and approval enforcement.
- Emits fixed, schema-bounded foreground install and connect actions for Claude/Codex. Every action defaults the canonical runtime node prefix, prepends its `bin` directory to `PATH`, and keeps the terminal visible; no credential, owner path, or client-supplied command enters the action.
- Passes through prompt, project, task, worktree, mode, approval policy, sandbox mode, and zellij runtime preference.
- Passes bounded `structured_ref` attachments into the runtime launch prompt as safe reference metadata so review follow-up runs can inspect the selected file/hunk without client-side diff contents.
- Binds coding-agent threads to canonical `terminalSessionId` from the workspace session.
- Aborts through the deterministic workspace session id.
- Keeps provider startup failures safe in the returned thread snapshot.

Thread store behavior:

- Owner-scoped thread summaries and events.
- Idempotent thread creation, aborts, approval decisions, and input answers by bounded request-id arrays.
- Event replay with bounded per-thread event storage; default thread snapshots return the latest bounded event window, while explicit cursors continue forward from the cursor.
- Safe terminal statuses and attention states derived from events.
- Thread-event sinks can bridge approval, input, failed, and completed attention events to the existing push channel with owner scope, generic copy, bounded `threadId` metadata only, capped TTL dedupe, and owner notification preferences. Legacy preference files without the completion key parse with completion alerts enabled. Push delivery fans out to the newest active registered tokens for the authenticated owner only, with capped owner buckets, per-owner token eviction, stale-token eviction, duplicate-token collapse, and capped per-notification fanout.

Review summary behavior:

- Adapts existing owner-local review-loop records into bounded `ReviewSummarySchema` rows.
- Adapts existing owner-local review-loop records, safe owner worktree git diffs, and structured findings into bounded `ReviewSnapshotSchema` rows for the review detail route.
- Drops malformed legacy records instead of exposing raw review state.
- Caps the coding-agent route response at 50 items.
- Drops unsafe findings paths or display text instead of exposing raw filesystem paths, provider output, or parse errors.
- Reads git diff metadata only from the validated owner worktree root, uses a bounded no-shell `git diff` call with timeout/output cap, and falls back to partial findings metadata when diff state is unavailable.

Focused tests:

- `tests/gateway/coding-agents-threads.test.ts`
- `tests/gateway/coding-agents-attention-notifications.test.ts`
- `tests/gateway/coding-agents-notification-preferences.test.ts`
- `tests/gateway/push-adapter.test.ts`
- `tests/gateway/coding-agents-workspace-provider.test.ts`
- `tests/gateway/agent-launcher.test.ts`
- `tests/gateway/workspace-session-orchestrator.test.ts`
- `tests/gateway/agent-session-manager.test.ts`

## Terminal Session Surfaces

Canonical named shell sessions:

- Routes: `packages/gateway/src/shell/routes.ts`
- Mounted under both `/api/terminal` and `/api` in `packages/gateway/src/server.ts`.
- Key routes: `GET /api/terminal/sessions`, `POST /api/terminal/sessions`, `PUT /api/terminal/sessions/order`, `DELETE /api/terminal/sessions/:name`, `PUT /api/terminal/sessions/:name/rename`, `PATCH /api/terminal/sessions/:name/ui-state`.
- Session creation is rate-limited and uses route body limits.

Legacy PTY session compatibility:

- Routes: `packages/gateway/src/terminal-session-routes.ts`
- `GET /api/terminal/pty-sessions`
- `DELETE /api/terminal/pty-sessions/:id`

Mobile terminal client:

- `apps/mobile/lib/terminal-client.ts`
- Uses `/ws/terminal` with optional query token.
- Parses `attached`, `output`, `replay-start`, `replay-end`, `exit`, and safe `error` frames.

## Desktop Shell State

IPC contract:

- `desktop/src/shared/ipc-contract.ts`
- `runtime:get-summary` returns `RuntimeSummarySchema`.
- `runtime:get-notification-preferences` returns `CodingAgentNotificationPreferencesSchema` through the trusted main process.
- `runtime:update-notification-preferences` accepts `CodingAgentNotificationPreferencesUpdateSchema` and returns `CodingAgentNotificationPreferencesSchema` through the trusted main process.
- `runtime:get-thread-snapshot` accepts a bounded `threadId` and returns `AgentThreadSnapshotSchema`.
- `runtime:submit-approval-decision` accepts bounded thread/approval ids plus `ApprovalDecisionRequestSchema` fields and returns `AgentThreadSnapshotSchema`.
- `runtime:submit-input-answer` accepts bounded thread/input request ids plus `UserInputAnswerRequestSchema` fields and returns `AgentThreadSnapshotSchema`.
- `runtime:get-reviews` returns a bounded list of `ReviewSummarySchema` rows from the trusted main process.
- `runtime:subscribe-thread-events` accepts a bounded thread id plus optional cursor and asks the trusted main process to attach to the gateway-owned coding-agent thread stream.
- `runtime:unsubscribe-thread-events` accepts a bounded thread id and asks the trusted main process to detach the matching stream.
- `runtime:thread-event` emits a bounded `threadId` plus validated `AgentThreadEventSchema` from the trusted main process to the renderer.
- `runtime:browse-files` accepts `FileBrowseRequestSchema` and returns `FileBrowseResponseSchema` through the trusted main process.
- `runtime:search-files` accepts `FileSearchRequestSchema` and returns `FileSearchResponseSchema` through the trusted main process.
- `runtime:get-file-content` returns a bounded `FileReadResponseSchema` snapshot through the trusted main process.
- `runtime:save-file-content` accepts `FileWriteRequestSchema` and returns bounded `FileWriteResponseSchema` metadata through the trusted main process.
- `runtime:prepare-source-commit` accepts `SourceControlPrepareCommitRequestSchema` and returns bounded `SourceControlPrepareCommitResponseSchema` metadata through the trusted main process.
- `notify` accepts bounded notification data with `threadId`, `title`, `body`, and kind.
- `notification:clicked` emits bounded `threadId`.

Main process:

- `desktop/src/main/coding-agents/runtime-summary-client.ts`
- Fetches `/api/coding-agents/summary` from the selected runtime origin with bearer auth in the main process.
- Fetches and updates `/api/coding-agents/notification-preferences` from the selected runtime origin with bearer auth in the main process, validates the gateway `{ preferences }` envelope, and returns only the preference object to the renderer.
- Fetches `/api/coding-agents/threads/:threadId` from the selected runtime origin with bearer auth in the main process and validates `AgentThreadSnapshotSchema`.
- Fetches a short-lived `/api/auth/ws-token` with bearer auth in the main process, opens `/ws/coding-agents/thread/:threadId` with the token query, validates thread stream frames, and emits only parsed `runtime:thread-event` IPC payloads to the renderer.
- Caps active desktop coding-agent thread streams and evicts the oldest stream before exceeding the cap; runtime switches, window close, and app quit close active streams.
- Posts approval decisions to `/api/coding-agents/threads/:threadId/approvals/:approvalId/decision` from the main process with bearer auth, a timeout, and `AgentThreadSnapshotSchema` response validation.
- Posts user-input answers to `/api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer` from the main process with bearer auth, a timeout, and `AgentThreadSnapshotSchema` response validation.
- Fetches `/api/coding-agents/reviews` from the selected runtime origin with bearer auth in the main process.
- Fetches `/api/coding-agents/files/browse` and `/api/coding-agents/files/search` from the selected runtime origin with bearer auth in the main process and validates the shared request/response schemas before returning metadata to the renderer.
- Posts `/api/coding-agents/files/write` from the selected runtime origin with bearer auth in the main process and validates `FileWriteResponseSchema` before returning metadata to the renderer.
- Posts `/api/coding-agents/source-control/prepare-commit` from the selected runtime origin with bearer auth in the main process and validates `SourceControlPrepareCommitRequestSchema`/`SourceControlPrepareCommitResponseSchema` before returning commit metadata to the renderer.
- Uses `AbortSignal.timeout(10_000)` and validates `RuntimeSummarySchema`, `AgentThreadSnapshotSchema`, or bounded `ReviewSummarySchema` lists.
- Renderer receives only parsed summary data through IPC.

Renderer:

- Store: `desktop/src/renderer/src/stores/coding-agent-workspace.ts`.
- UI: `desktop/src/renderer/src/features/coding-agents/AgentWorkspace.tsx`.
- Integration point: `desktop/src/renderer/src/features/mission-control/TabContent.tsx`.
- Flag: `desktop/src/renderer/src/lib/feature-flags.ts` with `VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0"`.

Current behavior:

- Read-only dashboard renders providers, gateway-owned attention threads, active threads, and terminals. The desktop command palette and app menu open the same Agents tab through the existing tab store when the desktop coding-agent workspace flag is enabled, and the palette, keyboard shortcut, and native menu "new thread" action route new agent runs to that gateway-backed Agents workspace composer, preserving intent through a shell-local prompt focus request only when thread creation is available or summary state is still loading instead of opening the legacy local composer while the flag is enabled. Successful desktop composer creates keep the accepted run selected in the Agents workspace detail instead of opening a legacy per-thread tab, and render bounded shell-local handles for just-created thread details if those threads later drop out of the active summary window. If thread creation is unavailable, the Agents workspace keeps a visible New Run section with generic unavailable copy instead of hiding the composer area. The desktop command palette also exposes a bounded set of already-loaded thread summaries from `RuntimeSummarySchema.attentionThreads` followed by `activeThreads`, dedupes by bounded thread id, and routes selection through the existing Agents tab plus trusted thread snapshot IPC. The desktop command palette also exposes a bounded set of already-loaded review summaries and routes selection through the existing Agents tab plus workspace review selection state. Attachable runtime terminal summaries can be opened from the command palette through the existing canonical terminal tab model, with shell-session duplicates left to the canonical shell-session command list. Provider setup actions that arrive as bounded `foreground_terminal` actions can be opened from the command palette through the existing canonical terminal session create/open path.
- The Settings Agent section renders runtime provider install/auth/setup status from `runtime:get-summary` through the trusted bridge, keeps setup commands hidden from the UI, and opens bounded `foreground_terminal` setup actions through `/api/terminal/sessions` plus the existing Terminal tab model.
- Desktop keyboard flow can focus an existing Terminal tab or open the Terminal workspace through the app menu `Terminal` action and the matching global shortcut. A dedicated Agents workspace shortcut opens or focuses the Agents tab without requesting a new-run composer focus.
- Notification controls render approval, input, failed-run, and completion attention push preferences, load them through trusted IPC, and submit full replacement updates through trusted IPC with generic error states.
- Attention thread rows read only from `RuntimeSummarySchema.attentionThreads`, show safe attention labels such as approval/input/failed/completed, and open the existing bounded thread detail path through trusted IPC.
- Active thread rows with a matching attachable `terminalSessionId` can open the existing desktop Terminal tab for that canonical session; stale or unavailable terminal bindings do not render an action.
- Selected active threads hydrate a bounded thread snapshot through `runtime:get-thread-snapshot`, subscribe to the trusted main-process `runtime:thread-event` bridge, merge live same-thread events by event id, update local attention/status from validated events, show provider/status/terminal metadata, event counts, loading and safe generic error states, and render gateway-bounded snapshot events with generic copy for assistant text, tool output, file changes, approval/input prompts, and unsafe runtime errors. Desktop thread timelines group assistant text lifecycle events by bounded `messageId` and tool activity events by bounded `toolCallId`; normal assistant prose can render as a capped transient preview after local safe-display filtering, while sensitive-looking content falls back to update counts plus completion state. Tool rows render safe display metadata/output presence/completion state, output counts, and collapsible safe detail rows, never raw tool output. Message ids and tool call ids are never rendered. Review-ready events can open the matching review details through the existing trusted review IPC path after validating the bounded `reviewId` with `ReviewIdSchema`.
- Approval-request events render allowed decision actions in the desktop thread detail. Decisions use desktop-generated idempotency request ids, go through trusted IPC, never expose bearer/provider credentials to the renderer, and replace the thread detail with the gateway-returned bounded snapshot. Failed decisions show a generic recovery-oriented message.
- User-input request events render a bounded answer composer in the desktop thread detail. Answers use desktop-generated idempotency request ids, go through trusted IPC, never expose bearer/provider credentials to the renderer, and replace the thread detail with the gateway-returned bounded snapshot. Failed submissions show a generic recovery-oriented message.
- Native notification clicks carrying a bounded `threadId` focus the existing Agents tab and visibly mark that thread current in the coding-agent workspace thread list while preserving the legacy thread-store selection path.
- The Electron badge count includes the gateway-owned bounded coding-agent attention-thread count plus existing local thread attention, uses the badge overflow cap when `attentionThreads.hasMore` is true, and keeps the summary data owned by the gateway/runtime.
- When the runtime advertises `codingAgentsReview`, the dashboard fetches bounded review summaries through the trusted main-process IPC route and renders project, PR, round, status, and high-severity count.
- Review snapshot details render bounded file paths, additions/deletions, partial markers, selectable hunk coordinate metadata, gateway-bounded hunk lines, and safe finding summaries. Diff line containers are blocked from session recording.
- When the runtime advertises `codingAgentsFiles`, review details can browse and search bounded owner-worktree file metadata through trusted IPC and open a selected file through the existing bounded editor path.
- Opened review files render as a bounded desktop editor. Saving sends `projectId`, `worktreeId`, file path, UTF-8 content, current etag, and a desktop-generated idempotency request id through `runtime:save-file-content`; the main process owns bearer auth, validates the gateway response, and updates the visible snapshot metadata after success. Truncated file snapshots cannot be saved from the editor.
- When the runtime advertises `codingAgentsSourceControl`, review details render a prepare-commit action that sends `projectId`, `worktreeId`, bounded reviewed file paths, a Matrix-generated commit message, and a desktop-generated idempotency request id through `runtime:prepare-source-commit`; the renderer never receives bearer credentials and shows only "Commit prepared" or a generic recovery error.
- When a source-control pull request is created or found, review details can open the returned HTTPS pull request URL through `shell:open-external`; non-HTTPS or missing URLs do not render an open action.
- When thread creation is enabled, selecting a review hunk can open the mobile composer with bounded review metadata and a `structured_ref` attachment for the target file/hunk; the existing authenticated `createCodingAgentThread` gateway client performs the mutation.
- When thread creation is enabled, selecting a review hunk can seed the existing desktop composer with bounded review metadata and a `structured_ref` attachment for the target file/hunk; the normal trusted `runtime:create-thread` IPC path performs the mutation.
- Safe generic error state if the runtime summary is unavailable.
- Safe generic review error state if review summaries are unavailable; review failures do not drop the runtime summary dashboard.
- No provider credentials or bearer tokens are exposed to the renderer.
- Preview summaries can be selected in the desktop Agents workspace. The resulting inspector shows bounded status/origin metadata and only enables the existing `shell:open-external` path for HTTPS preview origins; local HTTP preview origins remain visible but are not launched externally by the desktop renderer.

Focused tests:

- `tests/desktop/coding-agent-workspace.test.tsx`
- `tests/desktop/coding-agent-runtime-client.test.ts`
- `tests/desktop/coding-agent-thread-stream.test.ts`
- `tests/desktop/ipc-contract.test.ts`
- `tests/desktop/ipc-handlers.test.ts`
- `tests/desktop/kernel-wiring.test.ts`
- `tests/desktop/agent-section.test.tsx`
- `tests/desktop/command-palette.test.tsx`
- `tests/e2e/desktop/operator.e2e.test.ts`

## Mobile Shell State

Gateway client:

- `apps/mobile/lib/gateway-client.ts`
- `apps/mobile/lib/coding-agent-diagnostics.ts`
- `getCodingAgentRuntimeSummary()` calls `GET /api/coding-agents/summary`, validates `RuntimeSummarySchema`, and returns the safe `"Runtime summary unavailable"` error on failure.
- `getCodingAgentNotificationPreferences()` calls `GET /api/coding-agents/notification-preferences`, validates the gateway `{ preferences }` envelope with `CodingAgentNotificationPreferencesSchema`, and returns the safe `"Notification settings unavailable"` error on failure.
- `updateCodingAgentNotificationPreferences()` sends a full `CodingAgentNotificationPreferencesUpdateSchema` body to `PUT /api/coding-agents/notification-preferences`, validates the gateway `{ preferences }` envelope, and returns the safe `"Notification settings could not be saved. Try again."` error on failure.
- `getCodingAgentThreadSnapshot()` calls `GET /api/coding-agents/threads/:threadId`, validates `AgentThreadSnapshotSchema`, and returns the safe `"Thread state unavailable"` error on failure.
- `submitCodingAgentApprovalDecision()` posts bounded approval decisions to `POST /api/coding-agents/threads/:threadId/approvals/:approvalId/decision`, validates `AgentThreadSnapshotSchema`, and returns the safe `"Approval could not be sent. Try again."` error on failure.
- `submitCodingAgentInputAnswer()` posts bounded answers to `POST /api/coding-agents/threads/:threadId/inputs/:inputRequestId/answer`, validates `AgentThreadSnapshotSchema`, and returns the safe `"Input could not be sent. Try again."` error on failure.
- `getCodingAgentReviews()` calls `GET /api/coding-agents/reviews`, validates a bounded review summary list, and returns the safe `"Review state unavailable"` error on failure.
- `browseCodingAgentFiles()` calls `GET /api/coding-agents/files/browse`, validates `FileBrowseRequestSchema` and `FileBrowseResponseSchema`, and returns the safe `"File list unavailable"` error on failure.
- `searchCodingAgentFiles()` calls `GET /api/coding-agents/files/search`, validates `FileSearchRequestSchema` and `FileSearchResponseSchema`, and returns the safe `"File search unavailable"` error on failure.
- `getCodingAgentFileContent()` calls `GET /api/coding-agents/files/read`, validates `FileReadRequestSchema` and `FileReadResponseSchema`, and returns the safe `"File content unavailable"` error on failure.
- `saveCodingAgentFileContent()` posts `FileWriteRequestSchema` to `POST /api/coding-agents/files/write`, validates `FileWriteResponseSchema`, and returns the safe `"File could not be saved. Refresh and try again."` error on failure.
- `prepareCodingAgentSourceCommit()` posts `SourceControlPrepareCommitRequestSchema` to `POST /api/coding-agents/source-control/prepare-commit`, validates `SourceControlPrepareCommitResponseSchema`, and returns the safe `"Source commit could not be prepared. Refresh and try again."` error on failure.
- Existing terminal session methods call `/api/terminal/sessions`.

Screen:

- `apps/mobile/app/agents/index.tsx`
- `apps/mobile/app/agents/new.tsx`
- `apps/mobile/app/agents/[threadId].tsx`
- Read-only phone-first dashboard with Needs attention, Working, and a contract-bounded Recent section, plus providers and canonical terminal sessions.
- The dashboard renders the shared mobile connection banner with agent-workspace labels for connecting, offline, and reconnecting states; the banner can retry the existing gateway client connection and does not hide the last hydrated gateway summary.
- The cockpit is derived only from the bounded `RuntimeSummarySchema.activeThreads` and `attentionThreads` lists. Approval, input, and failed states sort into Needs attention; queued, starting, and running states sort into Working; every completed attention plus completed, aborted, recoverable stale, and archived status supplied by those bounded lists remains reachable in Recent. Duplicate thread ids are projected once and sorted by gateway timestamps.
- Working rows use static status UI because the summary screen has pull-to-refresh but no per-row live stream. The screen never implies continuous reconciliation with a perpetual spinner.
- The Agents scroll view uses native automatic content-inset adjustment and content padding does not add the iOS safe-area values a second time.
- The quick new-run action uses the existing `/agents/new` route when thread creation is enabled. Project selection and project creation remain follow-up work and must use the canonical project/thread contracts.
- Running attachable terminal rows in the mobile Terminals section use the existing mobile Terminal tab handoff and persist only the bounded safe terminal session reference in mobile shell state; non-running or unavailable rows stay disabled.
- Provider Setup warnings are derived only from `RuntimeSummarySchema.providers`, show coarse install/auth/availability states plus safe setup action labels, and do not render foreground terminal setup commands, credentials, or raw provider errors.
- Notification controls render approval, input, failed-run, and completion attention push switches, load them through the authenticated gateway client, submit full replacement updates, and keep preference state transient in component memory.
- Attention thread rows read only from `RuntimeSummarySchema.attentionThreads`, show safe attention labels such as approval/input/failed/completed, and navigate to the existing bounded thread detail route.
- When the runtime advertises `codingAgentsReview`, the dashboard fetches bounded review summaries through the authenticated gateway client and renders project, PR, round, status, and high-severity count.
- Review snapshot details render bounded file paths, additions/deletions, partial markers, selectable hunk coordinate metadata, gateway-bounded hunk lines, and safe finding summaries.
- When the runtime advertises `codingAgentsFiles`, review details can browse and search bounded owner-worktree file metadata through the authenticated gateway client and open a selected file through the existing bounded transient editor path.
- When the runtime advertises `codingAgentsFiles`, review details can load one selected bounded file text snapshot through the authenticated gateway client, edit the transient in-memory buffer, and save non-truncated files with the current etag plus a mobile-generated idempotency request id.
- When the runtime advertises `codingAgentsSourceControl`, review details can prepare a local source-control commit for bounded reviewed file paths through the authenticated gateway client with a mobile-generated idempotency request id. Mobile stores no commit payloads, diffs, file bytes, credentials, or raw errors.
- When a source-control pull request is created or found, review details can open the returned HTTPS pull request URL through the OS browser opener. Mobile still stores no pull request payloads beyond transient component state.
- Safe generic review error state if review summaries are unavailable; review failures do not drop the runtime summary dashboard.
- Composer route for creating accepted coding-agent threads. The mobile composer is keyboard-aware so the prompt and start action remain reachable while preserving the bounded authenticated create request path.
- Active thread rows navigate to `/agents/:threadId`; the thread route hydrates a bounded thread snapshot, shows provider/status/terminal metadata, event counts, loading, tap refresh, pull-to-refresh, safe generic error states, a pinned current-action panel for the newest unresolved approval or input request, and an event timeline for gateway-bounded snapshot events with a local jump-to-latest control. After the initial snapshot, the route subscribes to `/ws/coding-agents/thread/:threadId` through the authenticated gateway client, validates all stream frames with Zod 4 schemas, merges same-thread live events without duplicating replayed snapshot events, refreshes the bounded snapshot when the app returns to the foreground, and detaches on unmount. Assistant text lifecycle events are grouped by bounded `messageId`; normal assistant prose can render as a capped transient preview after local safe-display filtering, while sensitive-looking content falls back to update counts plus completion state. Message ids are never rendered. File-change events render generic summaries instead of raw paths. Tool activity events are grouped by bounded `toolCallId` and render only safe display metadata, coarse output presence/truncation, output counts, collapsible safe detail rows, and completion outcome, never raw tool output.
- Active thread rows render safe in-app attention badges for approval-required and input-required threads from the gateway-owned active-thread summary. Thread details render safe banners for approval-required, input-required, and failed threads from the bounded thread snapshot. No raw provider errors, paths, or event bodies are surfaced in these badges or banners.
- Approval-request events render allowed decisions in the mobile thread route. Decisions use mobile-generated idempotency request ids, go through the authenticated gateway client, and replace local thread details with the gateway-returned bounded snapshot. Failed decisions show a generic recovery-oriented message.
- User-input request events render a transient bounded answer composer in the mobile thread route. Answers use mobile-generated idempotency request ids, go through the authenticated gateway client, and replace local thread details with the gateway-returned bounded snapshot. Failed submissions show a generic recovery-oriented message.
- Successful mobile approval decisions and user-input answers trigger local success haptics only after the gateway-returned bounded snapshot is accepted; haptic failures are logged and do not block the thread state update.
- Mobile approval/input action state is isolated in `apps/mobile/lib/agent-thread-actions.ts`; the route owns hydration, streaming, and composition while the hook owns transient pending ids, safe per-action errors, bounded input drafts, idempotency request ids, and accepted-snapshot haptic guards.
- Thread details and terminal rows can open the existing `/terminal` tab after persisting only the safe canonical shell-session reference in `mobile-shell-state`; terminal output and transcripts remain outside AsyncStorage.
- Thread details can open the existing mobile composer for a follow-up run with only bounded source thread id/title/provider route params. The composer validates those params with shared contract schemas and sends a `structured_ref` attachment for the source thread through the normal authenticated create-thread gateway client.
- Review-ready events in the mobile thread timeline can open the Agents review section with only a bounded `reviewId` route param. The Agents screen validates that route param with `ReviewIdSchema`, rehydrates the review snapshot through the authenticated gateway client, and ignores invalid values without persisting review or diff content.
- Push notification tap routing accepts coding-agent attention payloads with a bounded `threadId`, validates that id with `ThreadIdSchema`, opens `/agents/:threadId` for valid thread ids, and falls back to `/agents` for invalid or missing thread references.
- Preview rows navigate to `/agents/preview` with only the bounded preview id. The route rehydrates the current authenticated runtime summary, validates the matching `PreviewSessionSummarySchema`, renders only currently running HTTPS origins through the existing `AppRuntimeFrame`, offers a safe OS-browser open action for that same authoritative HTTPS origin, and rejects missing, unavailable, non-running, or non-HTTPS previews without rendering raw URLs or persisting preview state.
- Flag: `apps/mobile/lib/feature-flags.ts` with `EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE === "1"`.

Persisted UI references:

- `apps/mobile/lib/agent-workspace-state.ts` stores only `selectedThreadId`, `selectedTerminalSessionId`, and `updatedAt`.
- `apps/mobile/lib/mobile-shell-state.ts` stores only the current shell mode plus safe bounded app or terminal session references, including canonical named shell sessions such as `main` or `matrix-abc1234`.
- Agent workspace state reconciles stale references against runtime summary items.
- Does not store transcripts, terminal output, file contents, diffs, credentials, approvals payloads, file write payloads, or launch tokens.

Focused tests:

- `apps/mobile/__tests__/gateway-client.test.ts`
- `apps/mobile/__tests__/coding-agent-diagnostics.test.ts`
- `apps/mobile/__tests__/agents-screen.test.tsx`
- `apps/mobile/__tests__/agents-preview-screen.test.tsx`
- `apps/mobile/__tests__/agent-thread-screen.test.tsx`
- `apps/mobile/__tests__/agent-workspace-state.test.ts`
- `apps/mobile/__tests__/push.test.ts`

## Browser Shell State

The browser shell remains Canvas-first. This stack has not moved coding-agent source of truth into browser shell state.

Relevant browser shell paths touched by this stack:

- `shell/src/lib/proxy-routes.ts` treats `/ws` and `/ws/*` as gateway paths.
- `shell/src/components/terminal/TerminalApp.tsx` continues to use canonical terminal sessions.
- `shell/src/components/workspace/WorkspaceApp.tsx` renders validated active-project coding-agent thread summaries and preview origin/status rows from the authenticated runtime summary, and can open an existing worktree pull request in the Canvas PR workspace from bounded worktree PR metadata.
- Built-in app/canvas behavior remains outside this coding-agent stack.

Browser shell coding-agent placement is Canvas-first through the existing Workspace built-in. The browser shell shows only active-project summary rows and does not add a separate coding-agent store, thread detail route, provider setup execution path, or coding-agent source-control mutation path. Existing worktree PR metadata can dispatch the existing Canvas PR workspace entry so browser users can inspect a PR without moving source-control state into browser Workspace.

Public docs note: `www/content/docs/coding-agents.mdx` now describes the user-facing desktop/mobile/browser workspace, approvals/input, terminal continuity, review/file/diff, preview, and provider setup model at a public-safe level. Keep it updated as later write/source-control slices land.

## Feature Flags

Defined capabilities in `RuntimeSummary`:

- `codingAgentsRuntimeSummary`
- `codingAgentsDesktopWorkspace`
- `codingAgentsMobileWorkspace`
- `codingAgentsThreadCreate`
- `codingAgentsApprovals`
- `codingAgentsReview`
- `codingAgentsFiles`
- `codingAgentsPreview`
- `codingAgentsNativeMobileTerminal`
- `codingAgentsSourceControl`

Client flags:

- Desktop: `VITE_CODING_AGENTS_DESKTOP_WORKSPACE !== "0"`.
- Mobile: `EXPO_PUBLIC_CODING_AGENTS_MOBILE_WORKSPACE === "1"`.

Server flags:

- Fake provider: `MATRIX_CODING_AGENTS_FAKE_PROVIDER=1`.
- Workspace provider projections: `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS=claude,codex` (bounded explicit list; Codex executable, Claude registry-only).
- Customer host bundles set the legacy Codex-only workspace provider flag so thread routes are registered on fresh runtimes. Provider readiness still requires the installed and authenticated Codex CLI. An explicit `MATRIX_CODING_AGENTS_WORKSPACE_PROVIDERS` value overrides this default.

Current behavior:

- Runtime summary advertises desktop/mobile read-only workspace capabilities only when the coding-agent thread store and workspace provider wiring are present.
- Runtime summary advertises `codingAgentsThreadCreate` when a coding-agent thread store is wired.
- Runtime summary advertises `codingAgentsApprovals` only when a thread store is wired and gateway summary wiring explicitly sets `capabilities.approvals`; current production wiring keeps it disabled until a provider/handler can bridge approval decisions to the running agent, not merely record local resolution events.
- Runtime summary advertises `codingAgentsNativeMobileTerminal` when a terminal registry is wired and the caller can read terminal sessions.
- Runtime summary advertises `codingAgentsReview` when the read-only coding-agent review summary route is wired.
- Runtime summary advertises `codingAgentsPreview` when the read-only preview summary adapter is wired. Preview summaries are owner-scoped, capped, and expose only local preview origins without path or query data.
- Runtime summary advertises `codingAgentsSourceControl` when the gateway source-control service is wired.

## Baseline Commands

Focused gateway/contracts:

```bash
pnpm exec vitest run tests/gateway/coding-agents-provider-registry.test.ts tests/gateway/coding-agents-workspace-provider-config.test.ts tests/gateway/coding-agents-workspace-provider.test.ts tests/gateway/coding-agents-threads.test.ts tests/gateway/coding-agents-thread-stream.test.ts tests/gateway/coding-agents-summary.test.ts tests/gateway/coding-agents-file-read.test.ts tests/contracts/coding-agents.test.ts tests/gateway/agent-launcher.test.ts tests/gateway/agent-session-manager.test.ts tests/gateway/workspace-session-orchestrator.test.ts tests/observability/process-error-entrypoints.test.ts
```

Gateway diagnostics:

```bash
pnpm exec vitest run tests/gateway/coding-agents-diagnostics.test.ts
```

Gateway typecheck:

```bash
pnpm --filter @matrix-os/gateway exec tsc --noEmit
```

Mobile focused Jest:

```bash
pnpm --filter matrix-os-mobile exec jest __tests__/gateway-client.test.ts __tests__/apps-screen.test.tsx __tests__/agents-screen.test.tsx __tests__/agent-thread-screen.test.tsx __tests__/agent-workspace-state.test.ts --runInBand
```

Mobile diagnostics:

```bash
pnpm --filter matrix-os-mobile exec jest __tests__/coding-agent-diagnostics.test.ts __tests__/gateway-client.test.ts --runInBand
```

Desktop typecheck:

```bash
pnpm --filter desktop run typecheck
```

Desktop operator e2e smoke:

```bash
bun run build:desktop
xvfb-run -a bun run test:e2e tests/e2e/desktop/operator.e2e.test.ts
```

Repo gates:

```bash
bun run check:patterns
bun run typecheck
```

Docs-only slices:

```bash
git diff --check
```

## Open Questions And Deferred Work

- Claude workspace execution: registry and owner credential projection are implemented, but thread creation remains fail-closed until [#893](https://github.com/HamedMP/matrix-os/issues/893) enforces the shared sandbox and approval contract in the launcher and runtime preflight.
- Session completion reconciliation: implemented for workspace `session.stopped` events that carry owner id, workspace session id, and bound `terminalSessionId`; the gateway thread store marks matching active coding-agent threads completed or failed server-side without matching unrelated owners or reused terminal ids. Startup recovery now returns degraded/closed agent sessions from the runtime session manager and routes them through the same workspace `session.stopped` publisher path, so coding-agent thread completion reconciliation also runs after autonomous startup/runtime degradation recovery.
- File/review/preview/source-control shell surfaces: read-only review summaries now have coding-agent contracts/routes/desktop IPC/mobile clients plus desktop and mobile read-only review panels. A read-only review snapshot route now exposes bounded diff hunk metadata and capped hunk line bodies from safe owner worktrees plus partial findings-derived fallback metadata for shell diff panels. Runtime summaries now include safe preview summary rows from existing workspace preview records, and the desktop/mobile Agents workspaces render those rows read-only. Desktop also has a read-only preview inspector with HTTPS-only external launch through the existing safe IPC path, mobile has an HTTPS-only preview route using the existing app runtime frame, and the browser Workspace preview panel renders validated active-project coding-agent preview origin/status rows with direct launch limited to HTTPS origins. Gateway now has bounded browse/search/read and conflict-safe write routes for owner worktree files, desktop/mobile review details can render one selected bounded file snapshot through trusted clients, desktop/mobile review details can prepare a local source-control commit through trusted clients, the gateway can create or return a GitHub pull request from a validated owner worktree without exposing credentials, and desktop/mobile review details can trigger that PR creation through trusted clients with generic safe error states and safe HTTPS open actions for the returned pull request URL. Browser Workspace can open an existing Canvas PR workspace from bounded worktree PR metadata, but commit and pull-request creation remain outside browser Workspace.
- Approval/input shell actions: desktop and mobile approval decisions plus user-input answers now use trusted gateway clients, bounded UI controls, idempotent request ids, and focused tests. Desktop selected-thread details now subscribe through a trusted main-process thread-event bridge and merge live approval/input resolution events without exposing bearer credentials to the renderer; mobile thread details subscribe through the authenticated gateway client, pin the newest unresolved approval/input request above the timeline for phone-first action, and rehydrate the bounded snapshot on foreground resume so cross-shell approval/input decisions reconcile. Remaining work: broader end-to-end device validation.
- Browser shell entry point: Canvas-first read-only placement is implemented in Workspace for active-project coding-agent threads and previews, plus a bounded handoff from existing worktree PR metadata to the Canvas PR workspace. Browser Workspace still does not create source-control commits or pull requests.
- Notifications/attention routing: desktop notification IPC exists and notification clicks focus the coding-agent workspace thread in the Agents tab with a visible current-thread marker. Gateway runtime summaries expose bounded `attentionThreads` separately from `activeThreads`, allowing failed or waiting attention to be surfaced without reclassifying terminal threads as active. Desktop and mobile dashboards now render the `attentionThreads` list directly, and desktop badge counts include that gateway-owned attention count, using the badge overflow cap when the bounded list is truncated. Gateway thread-event sinks can emit safe push-channel payloads for approval-required, input-required, failed, and successful-completion attention events through a capped TTL dedupe registry, per-owner notification preferences can disable approval/input/failed/completed attention push delivery before channel send, mobile push notification taps can route bounded coding-agent `threadId` payloads into the existing thread detail route, desktop/mobile Agents workspaces expose transient controls for the four owner-scoped attention push preferences, and gateway push delivery now applies an explicit bounded cross-device policy for the newest active registered owner devices without cross-owner token eviction.
- Public docs: public Matrix OS docs and the internal operator runbook are present. Remaining work is keeping them synchronized with later write/source-control, provider setup, and browser entry slices.
