# Data Model: CLI TUI Action Console

## TUI Action

Represents a user-selectable command or workflow in the home screen or command palette.

Fields:
- `id`: stable action identifier.
- `title`: display label.
- `group`: command category.
- `shortcut`: optional single-key shortcut for quick actions.
- `handler`: one of `view`, `flow`, `direct-command`, or `external-attach`.
- `danger`: one of `none`, `confirm`, or `exact-phrase`.
- `confirmationPhrase`: required when `danger` is `exact-phrase`.
- `prerequisites`: optional requirements such as authenticated profile or reachable gateway.
- `refreshAfter`: whether status should refresh after completion.

Validation:
- `id` must be unique.
- Destructive actions must not use `danger: none`.
- Shortcuts must be unique within the active view.
- Arbitrary user-entered palette text is not executable unless it resolves to a registered action.

## Action Execution

Represents one invocation of a TUI action.

Fields:
- `executionId`: unique local identifier.
- `actionId`: registered action ID.
- `state`: `idle`, `confirming`, `running`, `succeeded`, `failed`, or `cancelled`.
- `startedAt`, `finishedAt`: timestamps.
- `safeMessage`: optional capped user-visible message.
- `safeDetails`: optional bounded details for TUI display.
- `errorCode`: stable error code when failed.
- `recoveryHint`: optional user-facing next step.
- `shouldRefreshStatus`: boolean.

State transitions:
- `idle -> confirming` for dangerous actions.
- `idle -> running` for safe actions.
- `confirming -> running` after confirmation.
- `confirming -> cancelled` on cancel.
- `running -> succeeded|failed|cancelled`.

Validation:
- Only one conflicting mutation may run at a time.
- Failed executions must not expose raw internal errors.

## Quick Action

Represents a high-priority action pinned to the home screen.

Fields:
- `actionId`: references `TUI Action`.
- `order`: display order.
- `shortcut`: required for keyboard access.
- `visibleWhen`: optional condition such as unauthenticated or gateway reachable.

Validation:
- References an existing `TUI Action`.
- Shortcut is unique among quick actions.

## Session Summary

Represents a persistent shell session row in the Sessions view.

Fields:
- `name`: session name.
- `state`: `running`, `stopped`, `unknown`, or `unavailable`.
- `cwd`: optional working directory or safe label.
- `layout`: optional layout name.
- `createdAt`, `updatedAt`: optional timestamps from session metadata.
- `actions`: available row actions such as attach, remove, refresh.

Validation:
- Session names use the existing shell-session validator.
- Displayed paths are shortened/sanitized and must not leak unexpected local filesystem paths.

## Setup Wizard State

Represents the setup wizard's current step and choices.

Fields:
- `step`: `agents`, `migration`, `preview`, `running`, `complete`, or `failed`.
- `agentSelections`: list of `Coding Agent Selection`.
- `migrationSources`: list of `Config Migration Source`.
- `preview`: optional setup plan summary.
- `result`: optional `Setup Result`.

Validation:
- At least one coding agent must be selected before continuing from `agents`.
- Migration sources are optional and independently selectable.
- The wizard cannot enter `running` until the user confirms the preview.

## Coding Agent Selection

Represents a coding agent the user may enable.

Fields:
- `id`: `codex` or `claude` for the first implementation.
- `label`: display name.
- `selected`: boolean.
- `status`: `available`, `missing`, `configured`, or `unknown`.

Validation:
- Unknown agent IDs are rejected.

## Config Migration Source

Represents a local configuration source detected by the wizard.

Fields:
- `id`: stable source identifier.
- `label`: display name.
- `sourcePath`: candidate path under the user's home.
- `detected`: boolean.
- `selected`: boolean.
- `eligibleFiles`: bounded list of safe relative files.
- `skippedReasons`: bounded list of skipped files/reasons.
- `totalBytes`: total selected bytes.

Validation:
- Source path must be one of the allowlisted candidates.
- Symlinks, secrets, caches, sockets, binaries, logs, histories, and oversized files are skipped by default.
- Relative paths must remain within the source directory after resolution.

## Setup Result

Represents the outcome of running setup.

Fields:
- `completed`: completed setup step summaries.
- `skipped`: skipped setup step summaries.
- `failed`: failed setup step summaries with safe messages.
- `sessionName`: optional shell session created/opened after setup.
- `nextAction`: `open-terminal`, `retry`, `back`, or `done`.

Validation:
- Failed messages are safe/capped.
- Partial success is represented explicitly; it is not collapsed into generic failure.
