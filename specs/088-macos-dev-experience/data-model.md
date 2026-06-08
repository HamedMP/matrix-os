# Data Model: macOS Developer Experience

## DeveloperWorkspace

Represents the project/task workspace restored by the macOS app.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable owner-scoped workspace ID. |
| `projectId` | string | Validated project reference. |
| `taskId` | string optional | Optional task/review-loop context. |
| `selectedPane` | enum | `terminal`, `editor`, `files`, `git`, `browser`, `agent`, `settings`, `artifacts`. |
| `layout` | object | Bounded pane/split/tab layout. No secrets. |
| `updatedAt` | ISO timestamp | Updated on successful persisted layout write. |

## TerminalSurface

Represents one native terminal view attached to a Matrix terminal session.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable UI surface ID. |
| `sessionId` | string | Matrix terminal session ID. |
| `renderer` | enum | `swiftterm`, `ghostty`, `xterm-webview`. |
| `cols` / `rows` | integer | Positive, capped by gateway terminal limits. |
| `cwd` | string optional | Display-only unless validated by the gateway. |
| `connectionState` | enum | `connecting`, `attached`, `reconnecting`, `exited`, `error`. |
| `lastSeq` | integer | Latest applied terminal output sequence. |
| `searchQuery` | string optional | Bounded local UI state. |

## EditorSurface

Represents one file editor tab/split.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable UI surface ID. |
| `projectId` | string | Owner-scoped project reference. |
| `path` | string | Validated project-relative path. |
| `engine` | enum | `codemirror`, `monaco`, `textkit`. |
| `baseRevision` | string optional | Required for conflict-aware saves when provided by the file API. |
| `dirty` | boolean | True when local buffer differs from last saved content. |
| `conflictState` | enum | `none`, `external-change`, `save-conflict`, `too-large`, `binary`. |
| `cursor` | object optional | Bounded line/column or selection state. |
| `diagnosticsState` | enum | `unavailable`, `starting`, `ready`, `stale`, `failed`. |

## LanguageServiceSession

Represents project-scoped language intelligence.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable service session ID. |
| `projectId` | string | Owner-scoped project reference. |
| `language` | string | Allowlisted language identifier. |
| `state` | enum | `starting`, `ready`, `restarting`, `failed`, `stopped`. |
| `capabilities` | string array | Bounded set: diagnostics, completion, hover, format, definitions, references. |
| `lastHealthAt` | ISO timestamp optional | Used for stale service detection. |

## WorkspaceCommand

Represents command palette entries.

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | Stable command ID. |
| `scope` | enum | `workspace`, `terminal`, `editor`, `git`, `agent`, `browser`, `settings`. |
| `title` | string | User-visible, capped for palette display. |
| `requiresInput` | boolean | True when command prompts for a file/path/query. |
| `permission` | string optional | Permission required before execution. |
| `result` | enum | `focus-pane`, `open-file`, `run-terminal-input`, `start-agent`, `open-url`, `show-error`. |

## State Transitions

- `TerminalSurface.connectionState`: `connecting -> attached -> reconnecting -> attached`; `attached -> exited`; any recoverable transport failure may move to `reconnecting`; unrecoverable failures move to `error`.
- `EditorSurface.conflictState`: `none -> external-change` when the backing revision changes; `dirty -> save-conflict` when a revision-checked save fails; conflict clears only after explicit reload, merge, or successful save.
- `LanguageServiceSession.state`: `starting -> ready`; `ready -> restarting -> ready`; repeated failures move to `failed` with generic user-facing state.
