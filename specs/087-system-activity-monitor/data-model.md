# Data Model: System Activity Monitor

## ActivitySnapshot

Point-in-time response returned to the owner dashboard.

**Fields**:
- `generatedAt`: ISO timestamp.
- `machine`: MachineIdentity.
- `resources`: ResourceSummary.
- `services`: ServiceStatus[].
- `processes`: ProcessSummary[].
- `cleanupSuggestions`: CleanupCandidate[].
- `collectionWarnings`: SanitizedCollectionWarning[].

**Validation rules**:
- `generatedAt` must be the server collection time.
- Arrays must be capped by server configuration.
- Warnings must be generic and must not include raw paths, command stderr, tokens, provider names, or stack traces.

## SanitizedCollectionWarning

Generic warning emitted when a collector partially fails.

**Fields**:
- `code`: opaque bounded warning code such as `process_collection_unavailable`.
- `message`: optional sanitized operator-facing message selected from an allowlist.
- `section`: optional source section such as `processes`, `services`, `disk`, `memory`, or `pressure`.

**Validation rules**:
- `code` must be a safe identifier and must not include raw command output.
- `message` must be generic; raw paths, command stderr, tokens, provider names, host internals, and stack traces are never returned to clients.

## MachineIdentity

User-visible identity for the current Matrix computer.

**Fields**:
- `handle`: Matrix handle.
- `runtimeSlot`: `primary`, `staging`, `preview`, or another platform-defined slot.
- `hostname`: Sanitized hostname.
- `status`: Coarse status such as `healthy`, `degraded`, or `unknown`.
- `releaseVersion`: Installed host bundle version.
- `releaseChannel`: Channel such as `dev`, `canary`, `beta`, or `stable`.
- `gitCommit`: Optional short commit identifier.
- `uptimeSeconds`: Host uptime.

**Validation rules**:
- Missing optional release fields render as unavailable, not as errors.
- Hostname and handle are display strings only; clients must not use them as auth decisions.

## ResourceSummary

Current CPU, memory, disk, and swap state.

**Fields**:
- `cpu`: load average, current sample, core count, and `pressureSome10` when `/proc/pressure/cpu` is available.
- `memory`: total, used, available, process RSS total, cgroup anon/file/kernel when available.
- `swap`: total and used.
- `disk`: filesystem usage for root, app, and owner home paths.

**Validation rules**:
- Byte values are non-negative integers.
- Percentages are bounded from 0 to 100.
- Missing sections include `status: "unavailable"` with a generic reason code.

## ServiceStatus

Sanitized service health for Matrix host services.

**Fields**:
- `serviceId`: allowlisted service id, such as `matrix-gateway`, `matrix-shell`, `matrix-code`, `matrix-sync-agent`, `nginx`, or `postgres`.
- `state`: coarse state such as `running`, `starting`, `stopped`, `failed`, or `unknown`.
- `memoryBytes`: optional systemd memory accounting.
- `cpuSeconds`: optional accumulated CPU time.
- `tasks`: optional task count.
- `restartCount`: optional restart count.

**Validation rules**:
- Only allowlisted service ids are exposed.
- Raw journal output is never included.

## ProcessSummary

Sanitized resource row for a running process.

**Fields**:
- `processRef`: opaque server-generated reference.
- `pid`: optional display-only PID.
- `ownerClass`: `matrix`, `root`, `system`, or `unknown`.
- `classification`: `matrix_service`, `app_server`, `terminal_session`, `code_editor`, `database`, `system`, or `unknown`.
- `displayName`: sanitized command name.
- `cpuPercent`: sampled CPU usage.
- `rssBytes`: resident memory.
- `startedAt` or `elapsedSeconds`: process age.
- `ports`: sanitized local listening ports when relevant.
- `activeConnections`: optional connection count.

**Validation rules**:
- Command arguments are redacted or omitted unless they are known-safe display labels.
- PIDs are never accepted back as the only cleanup authority.

## CleanupCandidate

Server-generated recommendation for a safe cleanup action.

**Fields**:
- `candidateId`: opaque id.
- `type`: `stop_stale_app_server`, `close_stale_terminal_session`, `restart_idle_code_server`, `clean_cache_scope`, or `prune_old_bundle`.
- `targetLabel`: sanitized user-facing target.
- `reason`: generic explanation.
- `confidence`: `high`, `medium`, or `manual_review`.
- `risk`: `low`, `medium`, or `high`.
- `estimatedReclaimBytes`: optional reclaim estimate.
- `requiresConfirmation`: boolean.
- `confirmationToken`: opaque bounded token issued with the candidate and echoed by all cleanup action requests, including automatic policy execution.
- `expiresAt`: ISO timestamp.

**Validation rules**:
- Candidate ids expire and must be revalidated before action.
- Confirmation tokens expire with the candidate and must never be logged or stored in cleanup history.
- Only `high` or approved `medium` candidates can be executed by one-click action.
- Critical services and active resources cannot become executable candidates.

## CleanupAction

Mutation request submitted by the owner or automatic policy.

**Fields**:
- `type`: action type matching a cleanup candidate type.
- `candidateId`: server-generated id.
- `confirmationToken`: required for every action and must match the server-issued cleanup candidate token.
- `mode`: `manual` or `automatic`.

**Validation rules**:
- Must match an existing unexpired candidate.
- Automatic policy execution still uses a server-issued `candidateId` and `confirmationToken`; it is not a token bypass.
- Must re-check the live target before mutation.
- Must be idempotent when the target is already gone.

## CleanupHistoryEntry

Owner-visible audit entry for a cleanup attempt.

**Fields**:
- `id`: unique entry id.
- `createdAt`: ISO timestamp.
- `actor`: `owner` or `auto_policy`.
- `actionType`: CleanupAction type.
- `targetLabel`: sanitized label.
- `result`: `completed`, `skipped`, `already_clean`, or `failed`.
- `reclaimedBytes`: optional measured or estimated value.
- `reasonCode`: generic result reason.

**Validation rules**:
- Stored append-only with bounded retention.
- Does not include raw paths, raw errors, command stderr, or tokens.

## AutoCleanupPolicy

Owner-controlled automatic cleanup configuration.

**Fields**:
- `enabled`: boolean.
- `allowedTypes`: cleanup action types.
- `gracePeriodSeconds`: minimum stale duration before auto-clean.
- `maxActionsPerHour`: bounded action rate.
- `lastUpdatedAt`: ISO timestamp.

**Validation rules**:
- Disabled by default.
- Only `stop_stale_app_server`, `clean_cache_scope`, and `prune_old_bundle` can be enabled in v1 automation.
- `stop_stale_app_server` requires high confidence, low risk, stale executable evidence, and no active connections before automatic execution.
- `close_stale_terminal_session` and `restart_idle_code_server` remain manual-only in v1 because they can interrupt active work.
- Rate limits prevent repeated cleanup loops and are enforced by the internal automatic action path before each mutation.
