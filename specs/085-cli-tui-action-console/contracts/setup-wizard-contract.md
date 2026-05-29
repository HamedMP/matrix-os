# Contract: Setup Wizard And Config Migration

## Wizard Steps

```text
agents -> migration -> preview -> running -> complete
                              \-> failed
```

The wizard may be cancelled from `agents`, `migration`, or `preview`. Once `running`, cancellation is best effort and must leave completed/skipped/failed step results visible.

## Agent Selection

First implementation agents:

| ID | Label | Default |
|----|-------|---------|
| `codex` | Codex | selected |
| `claude` | Claude | unselected |

At least one agent must be selected to continue.

## Local Source Detection

Candidate sources:

| Source ID | Candidate Path |
|-----------|----------------|
| `codex-config` | `~/.codex` |
| `claude-config` | `~/.claude` |
| `agent-config` | `~/.agent` |
| `agents-config` | `~/.agents` |

Detection rules:
- Resolve candidates under the user's home directory.
- Use `lstat` and skip symlinks by default.
- Cap traversal by depth, file count, total bytes, and per-file bytes.
- Skip credentials, tokens, logs, histories, caches, sockets, device files, binaries, and unknown large files.

## Preview Contract

Before setup writes anything, the TUI shows:

```ts
type SetupPreview = {
  agents: Array<{ id: "codex" | "claude"; enabled: boolean }>;
  imports: Array<{
    sourceId: string;
    selected: boolean;
    eligibleFileCount: number;
    skippedFileCount: number;
    totalBytes: number;
  }>;
  destination: "active-matrix-runtime" | "local-profile";
};
```

## Execution Result

```ts
type SetupResult = {
  completed: Array<{ id: string; label: string }>;
  skipped: Array<{ id: string; label: string; reason: string }>;
  failed: Array<{ id: string; label: string; code: string; message: string }>;
  sessionName?: string;
  nextAction: "open-terminal" | "retry" | "done";
};
```

## Remote Import Endpoint (if required)

If setup imports selected config into the active Matrix runtime, add a gateway endpoint:

```http
POST /api/setup/coding-agents/import
Authorization: Bearer <profile token>
Content-Type: application/json
```

Request:

```json
{
  "agents": ["codex"],
  "sources": [
    {
      "sourceId": "codex-config",
      "files": [
        { "path": "config.json", "contentBase64": "..." }
      ]
    }
  ]
}
```

Response:

```json
{
  "completed": [{ "id": "codex-config", "label": "Codex config" }],
  "skipped": [],
  "failed": [],
  "sessionName": "matrix-main"
}
```

Route requirements:
- `bodyLimit` before JSON parsing.
- Zod 4 schema validation.
- Auth scoped to active runtime owner.
- Atomic writes under owner-controlled Matrix home.
- Generic client errors only.
