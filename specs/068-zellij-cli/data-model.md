# Data Model: Zellij-Native Shell and Unified CLI

## Profile

Represents a named CLI target configuration.

Fields:

- `name`: safe profile identifier.
- `platformUrl`: URL used for identity and platform operations.
- `gatewayUrl`: URL used for gateway data-plane operations.
- `authPath`: derived path to profile-scoped auth state.
- `configPath`: derived path to profile-scoped sync config.
- `active`: boolean derived from `profiles.json`.

Validation:

- `name` must be a safe slug.
- URLs must parse as HTTP(S) URLs.
- Profile files must live under `~/.matrixos/`.

State transitions:

- `missing -> created`: default profiles are created on first run.
- `legacy -> migrated`: legacy auth/config move to the cloud profile.
- `active -> inactive`: another profile is selected.

## Terminal Session

Represents a persistent zellij-backed workspace owned by one Matrix OS user.

Fields:

- `name`: safe session identifier.
- `status`: `active` or `exited`.
- `createdAt`: ISO timestamp.
- `updatedAt`: ISO timestamp.
- `layoutName`: optional layout used to create or update the session.
- `tabs`: ordered tab metadata.
- `attachedClients`: current attached client count.
- `lastSeq`: latest replay sequence observed by Matrix gateway.

Validation:

- `name` must be a safe slug and unique among live sessions.
- Session count must not exceed the configured cap.
- Any cwd must resolve within the user's home.

State transitions:

- `requested -> active`: zellij session created and registry written.
- `active -> exited`: zellij reports session exit.
- `active/exited -> deleted`: user removes the session.
- `registry-only -> reconciled`: stale metadata removed when zellij no longer has the session.

## Tab

Represents an ordered workspace subdivision within a terminal session.

Fields:

- `idx`: zero-based or zellij-compatible tab index as defined by the contract.
- `name`: optional user label.
- `focused`: boolean when known.
- `createdAt`: ISO timestamp when Matrix created it.

Validation:

- `name`, when present, must be a safe display label and must not exceed the configured length.
- `idx` must be a non-negative integer.

## Pane

Represents the focused pane operation target in v1.

Fields:

- `direction`: `right` or `down` for split operations.
- `cmd`: optional command argument vector/string as accepted by the contract.
- `cwd`: optional home-scoped working directory.

Validation:

- Direction is an enum.
- Command input is bounded and passed without shell interpolation.
- cwd resolves within the user's home.

## Layout

Represents a reusable zellij layout stored as owner-controlled text.

Fields:

- `name`: safe layout identifier.
- `path`: derived path under `~/system/layouts/`.
- `kdl`: layout content.
- `modifiedAt`: timestamp from file metadata.

Validation:

- `name` must be a safe slug.
- Content must be under the layout body size limit.
- Content must pass bounded validation before atomic save.

State transitions:

- `missing -> saved`: user saves or uploads a valid layout.
- `saved -> updated`: valid replacement is atomically written.
- `saved -> deleted`: user removes the layout.

## Daemon Request

Represents a local JSON-line control-plane request.

Fields:

- `id`: client-generated request identifier.
- `v`: protocol version, currently `1`.
- `command`: namespaced command string.
- `args`: command-specific object.

Validation:

- `v` must be supported.
- `command` must be in the allowlist.
- `args` must satisfy the command schema.
- Message size must not exceed the IPC buffer cap.

## Daemon Response

Represents a local JSON-line control-plane response.

Fields:

- `id`: request identifier.
- `v`: protocol version.
- `result`: command-specific success object.
- `error`: stable error object when failed.

Validation:

- Exactly one of `result` or `error` is present.
- Errors use stable codes and generic messages.

## Stream Event

Represents a versioned machine-readable event for streaming CLI or daemon operations.

Fields:

- `id`: stream/request identifier when applicable.
- `v`: protocol version.
- `type` or `event`: stable event name.
- `data`: event-specific object.

Validation:

- Event names are in the documented allowlist.
- Event payloads are bounded and schema-validated.
