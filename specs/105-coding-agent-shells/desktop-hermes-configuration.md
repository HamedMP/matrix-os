# Desktop Hermes Configuration

**Linear:** MAT-262

**Status:** Approved design

**Scope:** Electron Desktop provider setup

## Problem

The browser Shell exposes a structured Hermes control center with searchable
settings and write-only credential management. Electron Desktop currently
opens the interactive Hermes provider wizard in a foreground terminal. The
terminal remains a necessary compatibility and recovery path, but it should
not be the primary setup experience when the installed Hermes version exposes
the structured dashboard API.

## Goals

- Make the Desktop Hermes setup flow match the current browser Shell flow.
- Render the experience with Desktop design primitives and theme tokens.
- Support dynamic settings, write-only credentials, refresh, discard, save,
  and safe terminal fallback.
- Keep the Gateway authoritative for Hermes configuration and credential
  mutations.
- Preserve the existing foreground-terminal setup action for unsupported or
  unavailable structured setup.

## Non-goals

- Sharing React components, styling, or view state between Shell and Desktop.
- Requiring both surfaces to ship future UI changes in lockstep.
- Redesigning Hermes installation, runtime switching, coding-agent provider
  cards, or the terminal runtime.
- Returning stored credential values to the renderer.
- Replacing the Hermes dashboard API or persisting configuration in Desktop.

## User Flow

The primary flow is:

1. Open `Settings`.
2. Open the agent/runtime settings section.
3. Select `Configure Hermes`.
4. Load structured Settings and Credentials metadata for the selected Matrix
   computer.
5. Search, inspect, and edit settings or manage a credential.
6. Save or discard changes.
7. Refresh live configuration and provider/runtime state.

When structured setup is unavailable, the modal explains that configuration
cannot be loaded and offers `Open setup terminal`. Desktop must not silently
replace the graphical flow with a terminal tab.

## Desktop UI

The feature is a large native Desktop modal. It follows Desktop typography,
spacing, color, focus, button, dialog, and status primitives rather than
copying Shell JSX or Shell visual tokens.

### Header

- Hermes identity and `Configure Hermes` title
- Installed Hermes version when available
- `Refresh` action with an in-progress state
- Close action

### Settings tab

- Search across field path, description, and category
- Category navigation with bounded field counts
- Dynamic controls for boolean, number, string, select, and bounded list fields
- Per-field restore-to-default action
- Invalid input remains visible and blocks save

### Credentials tab

- Search across key, provider label, and description
- Configured credentials sort before unconfigured credentials
- Add and replace write-only values
- Two-step confirmation before removal
- Channel-managed credentials remain hidden or non-editable according to the
  Gateway contract

### Footer

- Unsaved-change count for settings
- `Discard`
- `Save changes`

Credential mutations commit per row. The settings footer does not retain or
submit credential values.

## Refresh and Close Behavior

- Refresh reloads configuration schema, current configuration, credential
  metadata, and current provider/runtime status.
- If settings contain unsaved changes, Refresh asks for confirmation before
  discarding them.
- A failed refresh keeps the last successfully loaded content and any unsaved
  draft visible.
- Refresh is disabled while a refresh is already in progress.
- Closing with unsaved settings requires confirmation. Closing without changes
  is immediate.
- Runtime switch, sign-out, or authenticated identity change clears modal data
  before another runtime can be displayed.

## Architecture

```text
Desktop Hermes modal
  -> typed preload IPC
  -> validated main-process handler
  -> authenticated Gateway Hermes routes
  -> fixed-loopback Hermes dashboard API
```

Shell continues to call the authenticated Gateway routes through its browser
client. Shell and Desktop share API contracts where useful, but do not share UI
components or view state.

### Contracts

`@matrix-os/contracts` should own bounded schemas for:

- configuration fields and category order
- sanitized configuration and defaults
- environment metadata without stored secret values
- bounded configuration change requests
- credential set and removal requests
- successful mutation responses

The Gateway remains responsible for route-boundary validation, sensitive
configuration filtering, serialized configuration writes, body limits, and
safe upstream error mapping.

### Desktop main process

The main process owns all authenticated requests. It:

- adds the device bearer token and selected runtime routing
- uses bounded 10 second reads and 15 second writes
- rejects redirects and validates every response
- returns fixed public errors to IPC callers
- never logs response bodies, credential values, raw provider errors, private
  hosts, or filesystem paths

The Desktop renderer must not call these Gateway routes directly.

### IPC

Each operation has a dedicated request and response schema in the existing IPC
contract. Requests and responses are validated in preload and main. Required
client dependencies are resolved when handlers are registered.

Suggested operations:

- `runtime:get-hermes-configuration`
- `runtime:get-hermes-environment`
- `runtime:update-hermes-configuration`
- `runtime:set-hermes-credential`
- `runtime:remove-hermes-credential`

## Consistency Boundary

Flow consistency means the two surfaces use the same concepts and operation
order: open, load, search, edit, save or discard, refresh, and recover through
the terminal. It does not require identical layouts, visual styling, shared
React code, or automatic lockstep UI releases.

## Failure Handling

- Initial load failure shows bounded generic copy and a retry action.
- Unsupported or persistently unavailable structured setup also exposes
  `Open setup terminal`.
- Save failure retains the submitted settings as a retryable draft.
- Refresh failure retains the last good data instead of clearing the modal.
- Credential mutation failure clears no unrelated state and never echoes the
  submitted value.
- A stale response from an earlier refresh or credential mutation cannot
  overwrite newer state.
- Provider/runtime status refresh failure is non-destructive and reported with
  generic copy.

## Test-Driven Implementation

Implementation follows red-green-refactor in this order:

1. Shared contract tests for bounds, field types, patches, environment metadata,
   and exclusion of stored secrets.
2. Main-client tests for auth, runtime routing, timeouts, status mapping, and
   response validation.
3. IPC contract and handler tests for request/response validation and
   registration-time dependency wiring.
4. Desktop component tests for loading, search, categories, field validation,
   discard, save, credential mutations, refresh confirmation, close
   confirmation, stale-response protection, and terminal fallback.
5. Regression tests for existing provider setup terminals, runtime switching,
   and Shell Hermes configuration.
6. Manual Electron verification against a real Matrix computer, including
   screenshots of the matching browser and Desktop flows.

## Delivery

The implementation should remain one focused PR if it stays within the normal
review target. If the shared contracts and trusted main-process client make the
diff too large, split them as the base of a short Graphite stack and place the
Desktop UI above them.

The implementation PR must include the required invariants section, validation
evidence, Desktop screenshots, and Greptile 5/5 before merge. Because this is a
user-facing workflow, update the canonical public documentation in a separate
`FinnaAI/matrix-os-site` PR after the behavior is finalized.
