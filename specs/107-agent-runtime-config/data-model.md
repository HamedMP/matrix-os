# Data Model: Unified Agent Runtime Configuration

## Ownership Boundary

One owner-scoped Matrix computer owns the configuration. Matrix persists only safe selections and transition metadata under `$MATRIX_HOME/system/`. Provider credentials remain in the trusted kernel or selected runtime's owner-local credential store. Client shells receive catalog and status views, never secrets.

## Persisted Matrix Configuration

### AgentConfigFile

Existing `system/config.json` remains the authoritative Matrix configuration file. Updates are written atomically without replacing unrelated top-level keys.

| Field | Type | Rules |
|-------|------|-------|
| `kernel.model` | string, optional | One of the kernel allowlist. Existing field. |
| `kernel.effort` | enum, optional | `low`, `medium`, `high`, `max`. Existing field. |
| `agent.messagingRuntime` | enum, optional | `hermes` or `openclaw`; absent resolves to `hermes`. |
| `agent.revision` | non-negative integer, optional | Incremented on extended settings mutations. Absent resolves to `0`. |
| `agent.updatedAt` | ISO timestamp, optional | Set with a successful extended mutation. |

Rules:

- Legacy model/effort writes modify only `kernel.model` and `kernel.effort`.
- Runtime-owned provider/model configuration is not copied into this file. The current normalized selection is read from the active runtime.
- Runtime selection persists only after the target passes its activation health check.
- Atomic writes use a sibling temp file, fsync as appropriate, rename, and restrictive owner permissions.

## Client-Facing Entities

### AgentRuntimeId

Enum: `hermes | openclaw`.

This is specifically the optional messaging runtime. It is never used as a Chat-kernel identifier.

### RuntimeDescriptor

| Field | Type | Rules |
|-------|------|-------|
| `id` | AgentRuntimeId | Stable. |
| `displayName` | string | Safe, max 80 characters. |
| `installState` | enum | `installed`, `missing`, `installing`, `failed`, `unknown`. |
| `health` | enum | `healthy`, `degraded`, `stopped`, `unreachable`, `unknown`. |
| `selectionState` | enum | `active`, `available`, `action_required`, `unavailable`. |
| `configured` | boolean | Coarse configuration readiness. |
| `version` | string, optional | Safe semantic/product version, max 64 characters; no paths/build logs. |
| `capabilities` | enum array | Bounded to 16 values such as `provider_catalog`, `model_selection`, `messaging_dashboard`. |
| `setupAction` | enum, optional | `install` or `open_setup_terminal`; no command string from runtime. |

### AgentModelDescriptor

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Safe runtime/provider model reference, max 160 characters. |
| `displayName` | string | Safe, max 120 characters. |
| `description` | string, optional | Safe, max 240 characters. |
| `capabilities` | enum array | Bounded to 12: `tools`, `vision`, `reasoning`, `audio`, `long_context`. |
| `efforts` | enum array | Supported subset of `low`, `medium`, `high`, `max`; maximum 4. |
| `available` | boolean | False if cataloged but unusable with current auth/config. |

Unique within a provider: `id`.

### ProviderAuthStatus

| Field | Type | Rules |
|-------|------|-------|
| `state` | enum | `ready`, `action_required`, `unavailable`, `unknown`. |
| `authenticated` | boolean | Coarse result only. |
| `action` | enum, optional | `none`, `enter_api_key`, `open_login_terminal`, `configure_base_url`, `contact_owner`. |
| `lastCheckedAt` | ISO timestamp, optional | No upstream timing/status details. |

No token, key suffix, account email, auth profile name, upstream response, or file path is allowed.

### AgentProviderDescriptor

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | Safe slug, max 80 characters. |
| `displayName` | string | Safe, max 120 characters. |
| `runtime` | AgentRuntimeId or null | Null means Chat-kernel provider. |
| `scopes` | enum array | Non-empty subset of `chat`, `messaging`. |
| `authKind` | enum | Effective or recommended current flow: `platform`, `api_key`, `oauth_login`, `base_url`. |
| `supportedAuthKinds` | enum array | Non-empty bounded set of flows the owner may choose; includes `authKind`. |
| `models` | AgentModelDescriptor[] | Maximum 128. |
| `authStatus` | ProviderAuthStatus | Secret-free. |

Unique in one response: composite `(runtime ?? "kernel", id)`.

### ChatSelection

| Field | Type | Rules |
|-------|------|-------|
| `provider` | string | Currently `anthropic`; future-safe identifier. |
| `model` | string | Effective allowlisted model. |
| `effort` | enum | Effective effort. |
| `source` | enum | `saved`, `default`. Per-message overrides are validated WS inputs and are not persisted or emitted as the saved Chat selection. |
| `authKind` | enum | Effective credential source: `platform`, `api_key`, `oauth_login`. |

### MessagingSelection

| Field | Type | Rules |
|-------|------|-------|
| `runtime` | AgentRuntimeId | Effective active runtime. |
| `provider` | string or null | Runtime-normalized provider, null while unconfigured. |
| `model` | string or null | Runtime-normalized model, null while unconfigured. |
| `configured` | boolean | Whether the runtime can accept messaging work. |

### AgentSettingsView

| Field | Type | Rules |
|-------|------|-------|
| Legacy fields | existing | `identity`, `kernel`, `availableModels`, `availableEfforts`, `defaults`; unchanged. |
| `contractVersion` | literal | `2`. |
| `revision` | integer | Current extended settings revision. |
| `chat` | ChatSelection | Effective kernel selection. |
| `runtime` | object | `selected`, bounded `options`, transition state. |
| `providers` | AgentProviderDescriptor[] | Max 32 providers and max 256 models total. |
| `currentSelection` | object | `{ chat, messaging }`. |

Cross-field rules:

- Top-level `chat` is byte-for-byte equivalent to `currentSelection.chat`; both describe the effective computer-wide default and neither reflects a per-message override.
- `runtime.selected` equals `currentSelection.messaging.runtime`.
- The selected runtime descriptor is present exactly once.
- Chat model exists in a `chat` provider and in the legacy kernel catalog.
- A configured messaging selection has a provider/model pair present under the selected runtime.
- Total provider/model counts satisfy resource caps even if an upstream runtime returns more.

### AgentSettingsUpdate

Strict patch object:

| Field | Type | Rules |
|-------|------|-------|
| `model` | string, optional | Kernel allowlist. Legacy-compatible. |
| `effort` | enum, optional | Kernel effort allowlist. Legacy-compatible. |
| `runtime` | AgentRuntimeId, optional | Extended mutation. |
| `provider` | string, optional | Applies to the explicitly supplied or current messaging runtime. |
| `messagingModel` | string, optional | Must belong to selected runtime/provider. |
| `baseUrl` | HTTPS URL, optional | Accepted only for a `base_url` provider and subjected to SSRF controls. |
| `revision` | integer, optional | Required when changing runtime/provider/messaging model/base URL. |

At least one mutable field must be present. Unknown keys fail validation. Omitted fields are unchanged. `provider` and `messagingModel` must appear together unless the runtime adapter explicitly supports retaining one side.

### MessageOverride

| Field | Type | Rules |
|-------|------|-------|
| `model` | string, optional | Kernel allowlist only. |
| `effort` | enum, optional | Kernel allowlist only. |

The override lives only for one validated WebSocket message and is not persisted.

## Runtime Transition State

### RuntimeTransition

Transient owner-local JSON under `system/agent-runtime/transition.json`, mode 0600, removed on completion.

| Field | Type | Rules |
|-------|------|-------|
| `id` | UUID | Generated by controller. |
| `from` | AgentRuntimeId | Required. |
| `to` | AgentRuntimeId | Required and different. |
| `state` | enum | `validating`, `pausing`, `draining`, `activating`, `verifying`, `committing`, `rolling_back`. |
| `startedAt` | ISO timestamp | Required. |
| `deadlineAt` | ISO timestamp | At most 10 seconds after start. |

State transitions:

```text
validating -> pausing -> draining -> activating -> verifying -> committing -> complete
      |          |           |            |            |           |
      +----------+-----------+------------+------------+----------> rolling_back -> failed
```

Only one transition may exist. An exclusive `transition.lock` created with `wx` prevents concurrent controllers. Stale state is reconciled at gateway startup based on persisted selection and actual process health.

## External Runtime-Owned State

- Hermes owns `$HERMES_HOME/config.yaml` and `$HERMES_HOME/.env`.
- OpenClaw owns its JSON config, auth profiles, agent state, and plugin data under `$OPENCLAW_STATE_DIR` in the owner's home.
- Matrix interacts through each runtime's supported authenticated API/CLI and never parses or mutates credential stores directly.
- Backup/export may copy opaque runtime-owned state according to owner backup policy, but readable exports must not reveal credentials.
