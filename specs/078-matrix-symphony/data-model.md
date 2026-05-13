# Data Model: Matrix Symphony

## SymphonyInstallation

Owner-scoped runtime configuration for one Symphony installation.

Fields:
- `id`: stable installation ID
- `owner_scope_type`: `user` or `org`
- `owner_scope_id`: owner identifier
- `enabled`: whether polling is active
- `project_slug`: Matrix project slug
- `credential_ref`: server-side reference or integration account reference
- `poll_interval_ms`: bounded polling interval
- `max_concurrent_agents`: bounded global concurrency
- `default_agent`: `codex`, `claude`, `opencode`, or `pi`
- `authorized_operators`: bounded list of Matrix user handles/IDs
- `created_at`, `updated_at`

Validation:
- Unique active installation per owner/project.
- `max_concurrent_agents` defaults to 3 and is capped.
- Browser responses expose only `credential_configured: boolean`, not secret material.

## TicketSourceRule

Eligibility rule for Linear tickets.

Fields:
- `installation_id`
- `team_id`, `team_key`
- `project_id`, `project_slug` optional
- `required_labels`: normalized non-empty list, capped
- `active_states`: normalized non-empty list, capped
- `terminal_states`: normalized non-empty list, capped
- `assignee_ids`: normalized list; empty means no assignee filter
- `updated_at`

Validation:
- At least one active state.
- Labels and state names are bounded strings.
- Assignee IDs are bounded strings returned from Linear.

## TrackedTicket

Normalized external ticket snapshot used for preview, dispatch, and reconciliation.

Fields:
- `tracker_kind`: currently `linear`
- `external_id`
- `identifier`
- `title`
- `url`
- `team_id`, `team_key`
- `project_id`, `project_slug`
- `state_name`, `state_type`
- `assignee_id`, `assignee_name`
- `labels`
- `priority`
- `branch_name`
- `updated_at`

Validation:
- `external_id`, `identifier`, `title`, and `state_name` are required for dispatch.
- Labels are normalized lowercase for matching.

## SymphonyRun

Execution lifecycle for one ticket.

Fields:
- `id`
- `installation_id`
- `ticket_external_id`
- `ticket_identifier`
- `ticket_title`
- `ticket_url`
- `status`: `queued`, `running`, `retrying`, `blocked`, `stopped`, `failed`, `handoff`, `completed`
- `attempt`
- `agent`
- `project_slug`
- `worktree_id`
- `worktree_path`
- `session_id`
- `claim_key`
- `last_event`
- `last_error_code`
- `next_retry_at`
- `started_at`, `updated_at`, `finished_at`

State transitions:
- `queued -> running`
- `running -> handoff | completed | retrying | stopped | failed | blocked`
- `retrying -> running | blocked | failed`
- `blocked -> queued | stopped`
- Terminal dashboard states: `stopped`, `failed`, `handoff`, `completed`

Concurrency:
- Unique active claim for `(installation_id, ticket_external_id)` while status is active.
- Worktree lease acquisition is required before `running`.

## WorktreeClaim

Repository mirror of active worktree ownership.

Fields:
- `run_id`
- `project_slug`
- `worktree_id`
- `holder_session_id`
- `ticket_external_id`
- `acquired_at`
- `released_at`

Rules:
- One unreleased claim per worktree.
- Release happens when agent session stops, run becomes terminal, or reconciliation detects stale state.

## WorkflowContract

Repo-owned workflow file used for prompt composition.

Fields:
- `project_slug`
- `path`
- `body`
- `last_loaded_at`
- `validation_status`
- `validation_error_code`

Rules:
- Path must resolve inside the selected Matrix project.
- Invalid/missing workflow blocks new dispatch but does not expose file paths to clients.

## OperatorEvent

Bounded event/log entry for dashboard and audit.

Fields:
- `id`
- `installation_id`
- `run_id` optional
- `type`
- `message`
- `severity`
- `actor_id` optional
- `metadata` sanitized json
- `created_at`

Retention:
- Keep the newest bounded set per installation and per run.
- Security-sensitive events are retained longer than transient status logs.
