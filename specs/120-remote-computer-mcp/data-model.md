# Data Model: Remote Computer MCP

This feature adds no persisted entities. The model below defines validated request/response projections held only for one MCP tool call.

## CLI Principal

Fields:

- `profileName`: active or explicitly configured CLI profile name.
- `platformUrl`: trusted platform origin from the profile.
- `gatewayUrl`: current gateway origin from the profile.
- `accessToken`: existing owner bearer, held process-private.
- `expiresAt`: absolute expiry used before network access.
- `userId`, `handle`, `runtimeSlot`: authenticated identity metadata; never returned wholesale.

Rules:

- Missing or expired auth transitions directly to `auth_required`.
- Tokens never appear in tool input, tool output, logs, or persisted MCP state.

## Computer Reference

Fields:

- `handle`: safe display/routing handle.
- `runtimeSlot`: stable tool-facing identifier, 1-32 safe characters.
- `label`, `availability`, `kind`, `versionLabel`, `capabilities`.
- `gatewayPath`: inventory-derived relative path that must exactly match handle and slot.

Relationships:

- Many computer references belong to one CLI principal.
- One scoped tool call targets exactly one computer reference.

State transitions:

```text
unknown -> inventory member -> available -> scoped runtime access
                         \-> unavailable -> safe rejection
```

## Scoped Runtime Access

Fields:

- `computer`: resolved computer reference.
- `gatewayBase`: trusted origin plus validated inventory path.
- `accessToken`: current token if already scoped, otherwise a non-persisted replacement.
- `expiresAt`: replacement expiry when minted.

Rules:

- Created for one operation; no token cache is introduced, avoiding a new in-memory collection and eviction lifecycle.

## Terminal Session

Fields are projected from the gateway response and include a validated name plus safe status/metadata fields. Unknown server fields are discarded.

Relationships:

- Belongs to one computer.
- Owns zero or more terminal tabs.

State transitions:

```text
absent --create--> active
active --list/read/input--> active
```

Deletion is outside scope.

## Terminal Tab

Fields:

- `index`: non-negative safe integer supplied by zellij/Matrix.
- `name`: bounded display name when available.
- `active`: boolean when available.

State transitions:

```text
absent --create--> present
present --select--> active
active --send input--> active
```

## Captured Command

Input:

- `computer`: runtime slot.
- `command`: 1-64 argv items, each 1-4096 characters.
- `cwd`: optional normalized Matrix-home-relative path.
- `timeoutMs`: optional, 1 second through 30 minutes.

Result:

- `computer`: selected runtime slot/handle.
- `stdout`, `stderr`: bounded strings.
- `exitCode`, `signal`, `timedOut`, `truncated`, `durationMs`.

Lifecycle is one request; no record is persisted.

## Remote File Payload

Fields:

- `computer`, `path`, `filename`, `mediaType`, `size`.
- `encoding`: `utf8` or `base64`.
- `content`: bounded data matching encoding.
- `overwrite`, `secret`: explicit upload flags.

Rules:

- Paths normalize within Matrix home; absolute and traversal paths are invalid.
- Text read is at most 256 KiB; binary transfer is at most 1 MiB.
- Existing files remain unchanged unless `overwrite=true`.
- Download never gains a local destination field.

## Chat Page

Inputs:

- `computer`.
- `limit`: 1-100.
- optional safe `cursor`, `lifecycle`, `projectId`, `query`.
- detail additionally requires canonical `chatId`.

Result:

- projected canonical chat records and, for detail, at most 100 messages.
- `nextCursor` when another page exists.

Rules:

- Data is read-only.
- Unknown/cross-owner ids are indistinguishable as `not_found`.
