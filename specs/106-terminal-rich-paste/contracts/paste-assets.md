# Contract: Terminal Paste Assets

## Endpoint

`POST /api/terminal/sessions/:name/paste-assets`

Copies one paste transaction's accepted images into the authenticated user's Matrix home and returns prompt-safe remote paths.

## Auth Matrix

| Route | Auth Method | Public | Authorization Rule |
|-------|-------------|--------|--------------------|
| `POST /api/terminal/sessions/:name/paste-assets` | Existing Matrix gateway auth for `/api/terminal` routes | No | Authenticated user may upload only to their own Matrix home and a valid terminal session name |

## Request

Content type: `multipart/form-data`

Fields:

- `transactionId`: optional string, 1-80 chars, safe diagnostic identifier.
- `asset`: repeated file field, 1-5 files.

Validation:

- `:name` must match the existing safe terminal session name schema.
- Request body must be capped by `bodyLimit` before parsing.
- Each `asset` must be a supported image type.
- Each `asset` must fit within the per-image size limit.
- Total asset count must not exceed 5.
- Original local paths and local filenames are ignored for storage naming.

## Successful Response

Status: `201 Created`

```json
{
  "assets": [
    {
      "assetId": "paste_01H...",
      "path": "/home/matrix/home/projects/.matrix-terminal-pastes/main/2026-07-08/paste_01H.png",
      "homeRelativePath": "projects/.matrix-terminal-pastes/main/2026-07-08/paste_01H.png",
      "mimeType": "image/png",
      "size": 184203
    }
  ]
}
```

Response rules:

- `path` is the VPS-local path the CLI may insert into the outgoing prompt.
- `homeRelativePath` is owner-home-relative for file browser or cleanup flows.
- Response MUST NOT include original local paths.

## Error Responses

All errors use generic messages:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Invalid request"
  }
}
```

Codes:

- `invalid_request` for invalid session name, malformed multipart data, too many files, or unsupported image type.
- `payload_too_large` for body or image size limit violations.
- `session_not_found` when the target terminal session does not exist and the implementation can check it.
- `write_failed` for server-side storage failure.
- `auth_expired` or the existing auth failure code for unauthenticated requests.

Server logs may include diagnostics, but client responses must remain generic.

## Storage Contract

- Destination root: `projects/.matrix-terminal-pastes/`.
- Session segment: sanitized terminal session name.
- Date segment: UTC date.
- Filename: server-generated ID plus extension derived from validated image type.
- Write policy: exclusive temp create, write, chmod, atomic rename.
- Cleanup: recurring, symlink-safe pruning by max age and max count.
