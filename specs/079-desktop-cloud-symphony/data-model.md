# Data Model: Desktop Cloud Symphony

## Desktop Installation

Represents one local desktop profile connected to a Matrix instance.

- `id`: stable local installation identifier
- `matrixInstanceUrl`: validated Matrix shell/gateway target
- `lastAccountId`: last Matrix account seen, non-secret
- `windowState`: native window bounds/display state
- `preferences`: desktop-only appearance/navigation preferences
- `createdAt`, `updatedAt`

Validation:

- URLs must use `http` or `https`.
- Local preferences must not contain provider credentials or Matrix auth tokens.

## Desktop Runtime Policy

Server-declared capabilities consumed by desktop and shell.

- `agentExecutionMode`: always `cloud`
- `localAgentsAllowed`: always `false`
- `capabilities`: app launcher, Matrix shell, cloud development, ticket sync, internal tickets, Symphony assignment, realtime status
- `gatewayHealth`: healthy/degraded/unavailable
- `version`: runtime policy revision

Validation:

- Client may display this policy but cannot loosen it.
- Gateway validates requested actions against the server-side policy, not client claims.

## Cloud Project

Matrix-owned project binding used by workspace and tickets.

- `id`, `slug`, `name`
- `repository`: owner/repo/url/default branch
- `runtimeScope`: owner VPS/cloud workspace
- `ticketSourceIds`
- `createdAt`, `updatedAt`

Relationships:

- Has many Cloud Worktrees.
- Has many Tracked Tickets.
- Has many Symphony Runs through tickets.
- Has one or more Repository Workflow versions.
- Has many Shared Board Membership records.

## Repository Workflow

Project-owned instructions used by cloud workspaces and Symphony.

- `id`
- `projectId`
- `repoRef`
- `setupCommands`
- `liveCommands`
- `validationCommands`
- `allowedPreviewPorts`
- `codexRequired`
- `workflowFileRef`
- `revision`
- `createdAt`, `updatedAt`

Validation:

- Commands are stored as structured command definitions, not arbitrary shell strings when possible.
- Preview ports are bounded and explicitly allowlisted.
- Workflow updates use optimistic revision checks.

## Cloud Worktree

Cloud development workspace for a ticket or branch.

- `id`
- `projectId`
- `branch`
- `baseBranch`
- `pathRef`: sanitized cloud path reference, not browser-exposed raw filesystem path
- `leaseOwnerRunId`
- `dirtyState`
- `previewRefs`
- `createdAt`, `updatedAt`, `deletedAt`

Validation:

- Worktree creates are idempotent by project/ticket/branch key.
- Lease changes are transactional.

## Cloud Agent Session

Matrix-controlled cloud coding-agent process/session.

- `id`
- `projectId`
- `worktreeId`
- `ticketId`
- `agent`: codex/claude/opencode/pi where supported by cloud runtime
- `status`: starting/running/idle/blocked/stopped/failed/completed
- `terminalSessionId`
- `startedAt`, `lastEventAt`, `stoppedAt`

Validation:

- Sessions cannot be started with local desktop runtime mode.
- Session controls require project/operator authorization.

## Codex Runtime Credential

Server-side readiness state for cloud Codex execution.

- `id`
- `ownerId`
- `runtimeScope`
- `status`: missing/valid/expired/invalid
- `lastCheckedAt`
- `safeReason`

Validation:

- No token material is returned to desktop/browser clients.
- Readiness is checked before unattended Symphony dispatch.

## Ticket Source

Configured producer of tracked tickets.

- `id`
- `projectId`
- `kind`: linear or matrix
- `displayName`
- `enabled`
- `syncPolicy`: pull-only, push-enabled, or matrix-local
- `eligibilityRule`: team/project/labels/states/assignees for Linear or Matrix filters for internal tickets
- `credentialRef`: server-side reference only, never secret material
- `lastSyncAt`, `lastSyncStatus`

Validation:

- Source credentials never appear in desktop/browser payloads.
- Eligibility arrays are capped.

## Tracked Ticket

Unified ticket visible in board/list/workbench.

- `id`
- `projectId`
- `sourceKind`: linear or matrix
- `sourceId`: external provider ID or Matrix internal ID
- `identifier`
- `title`
- `description`
- `status`
- `priority`
- `assigneeIds`
- `labelIds`
- `dependencyIds`
- `artifactIds`
- `syncStatus`
- `revision`
- `createdAt`, `updatedAt`, `archivedAt`, `deletedAt`

Validation:

- Unique source key per project avoids duplicates.
- Updates use optimistic revision checks.
- Soft-deleted tickets stay out of normal reads.

## Symphony Assignment Rule

Manual or automatic rule that lets Symphony claim tickets.

- `id`
- `projectId`
- `sourceFilter`
- `ticketFilter`
- `agent`
- `concurrencyLimit`
- `enabled`
- `createdBy`
- `createdAt`, `updatedAt`

Validation:

- Concurrency limits are bounded.
- Only authorized operators can create/update/execute rules.
- Shared board claim permissions are checked before assignment.

## Symphony Run

Execution lifecycle for one claimed ticket.

- `id`
- `projectId`
- `ticketId`
- `assignmentRuleId`
- `worktreeId`
- `sessionId`
- `agent`
- `status`: queued/running/blocked/retrying/needs_attention/stopped/failed/handoff/completed
- `attempt`
- `claimKey`
- `lastReason`
- `startedAt`, `lastEventAt`, `completedAt`

Validation:

- Active `claimKey` is unique.
- Retry attempts are bounded.

## Task Workbench Tab

Desktop/shell context for a ticket, project, session, or app.

- `id`
- `kind`: ticket/project/session/app
- `targetId`
- `title`
- `activePanel`
- `panelLayout`
- `lastFocusedAt`

Validation:

- State must be serializable.
- Stale target refs reconcile on read.

## Operator Event

Bounded event for status, audit, and desktop updates.

- `id`
- `projectId`
- `ticketId`
- `runId`
- `type`
- `message`
- `severity`
- `createdAt`
- `actorId`

Validation:

- Events store safe messages for client display.
- Detailed raw errors stay server-side only.

## Shared Board Membership

Authorization relation for team boards.

- `id`
- `projectId`
- `userId`
- `role`: owner/admin/member/viewer
- `canAssignTickets`
- `canRunSymphony`
- `runnerScope`
- `createdAt`, `revokedAt`

Validation:

- Membership changes are audited.
- Revoked members cannot read tickets, runs, repo config, or events.

## Desktop Release Channel

Desktop distribution target.

- `id`
- `channel`: dev/canary/beta/stable
- `version`
- `artifactRefs`
- `manifestRef`
- `checksumRef`
- `publishedAt`

Validation:

- Publish requires signed artifacts for production channels.
- Dry-run artifacts must be clearly marked non-production.
