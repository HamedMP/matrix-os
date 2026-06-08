# Contracts: macOS Developer Experience

These contracts describe the interfaces the macOS shell needs. Existing gateway endpoints may satisfy some entries; implementation should reuse current contracts where they already meet the validation and error-policy requirements.

## Auth Matrix

| Interface | Purpose | Auth | Public | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/projects/:projectId/files/tree` | Load bounded project file tree | Authenticated owner session or native principal | No | Validate `projectId`, root path, depth, and result cap. |
| `GET /api/projects/:projectId/files/content?path=...` | Open file content | Authenticated owner session or native principal | No | Validate path within project; reject oversized/binary files with generic state. |
| `PUT /api/projects/:projectId/files/content` | Save file content | Authenticated owner session or native principal | No | Mutating endpoint; requires body limit and revision-aware save when available. |
| `GET /api/terminal/sessions` | List resumable terminal sessions | Authenticated owner session or native principal | No | Response must be bounded and owner-scoped. |
| `POST /api/terminal/sessions` | Create project terminal session | Authenticated owner session or native principal | No | Mutating endpoint; body limit; validate cwd/project. |
| `DELETE /api/terminal/sessions/:id` | End terminal session | Authenticated owner session or native principal | No | DELETE is mutating and still needs body limit. |
| `/ws/terminal` | Attach/input/resize/detach terminal stream | Authenticated owner session or query-token/native WS credential | No | Auth/setup must finish before success frames. Validate every frame after JSON parse. |
| `POST /api/language-services/:projectId/sessions` | Start or resume language service | Authenticated owner session or native principal | No | Body limit, language allowlist, resource caps. |
| `POST /api/workspaces/:workspaceId/commands/:commandId` | Execute command palette action | Authenticated owner session or native principal | No | Per-command payload schemas; generic errors only. |

## File Open Response

```json
{
  "projectId": "project_123",
  "path": "src/index.ts",
  "revision": "rev_456",
  "encoding": "utf-8",
  "language": "typescript",
  "content": "export {};\n",
  "editable": true,
  "warnings": []
}
```

## File Save Request

```json
{
  "path": "src/index.ts",
  "baseRevision": "rev_456",
  "content": "export const value = 1;\n"
}
```

## File Save Response

```json
{
  "path": "src/index.ts",
  "revision": "rev_457",
  "savedAt": "2026-06-07T12:00:00.000Z"
}
```

## Terminal Attach Frame

```json
{
  "type": "attach",
  "sessionId": "term_123",
  "cols": 120,
  "rows": 32,
  "replayFromSeq": 100
}
```

## Terminal Input Frame

```json
{
  "type": "input",
  "sessionId": "term_123",
  "data": "ls\n"
}
```

## Language Service State Response

```json
{
  "sessionId": "lang_123",
  "projectId": "project_123",
  "language": "typescript",
  "state": "ready",
  "capabilities": ["diagnostics", "completion", "hover", "definitions"]
}
```

## Error Policy

- Client-facing responses use stable codes and generic messages.
- Logs may include internal provider, process, path, or language-server details, but those details must not be returned to the macOS UI.
- Zod issues, database errors, filesystem paths outside validated project context, and provider names must not be surfaced directly.
