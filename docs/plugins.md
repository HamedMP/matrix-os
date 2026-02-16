# Plugin Developer Guide

Matrix OS plugins extend the system with new tools, hooks, channels, HTTP routes, and background services.

## Quick Start

1. Create a directory in `~/plugins/`:

```
~/plugins/my-plugin/
  matrixos.plugin.json
  index.ts
```

2. Add a manifest (`matrixos.plugin.json`):

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "configSchema": {}
}
```

3. Create `index.ts`:

```typescript
export function register(api) {
  api.registerTool({
    name: "my_tool",
    description: "Does something useful",
    schema: { input: { type: "string" } },
    execute: async (params) => ({
      content: [{ type: "text", text: `Result: ${params.input}` }],
    }),
  });
}
```

4. Restart the gateway -- plugin is discovered and loaded automatically.

## Manifest

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique plugin identifier |
| `name` | No | Human-readable name |
| `version` | No | Semver version |
| `description` | No | What the plugin does |
| `configSchema` | No | JSON Schema for plugin config (defaults to `{}`) |
| `channels` | No | Channel IDs this plugin contributes |
| `skills` | No | Skill files relative to plugin directory |

## Plugin API

The `register()` function receives a `MatrixOSPluginApi` object:

### Properties

- `api.id` -- Plugin ID from manifest
- `api.config` -- System configuration
- `api.pluginConfig` -- Plugin-specific config from `config.json`
- `api.home` -- Home directory path
- `api.logger` -- Scoped logger (`info`, `warn`, `error`, `debug`)

### Registration Methods

#### `api.registerTool(tool)`

Register an IPC tool available to the agent. Tool name is auto-namespaced as `{pluginId}_{toolName}`.

#### `api.registerHook(event, handler, opts?)`

Register an event hook. Two types:

**Void hooks** (fire-and-forget, parallel execution):
- `message_received`, `message_sent`
- `agent_end`
- `session_start`, `session_end`
- `gateway_start`, `gateway_stop`

**Modifying hooks** (sequential by priority, can mutate):
- `before_agent_start` -- inject systemPrompt or context
- `message_sending` -- modify content or `cancel: true`
- `before_tool_call` -- modify params or `block: true`
- `after_tool_call` -- inspect/modify results

Options: `{ priority?: number }` (higher runs first, default 0)

#### `api.registerChannel(adapter)`

Register a channel adapter (implements `ChannelAdapter` interface).

#### `api.registerHttpRoute(route)`

Register an HTTP route. Mounted under `/plugins/{pluginId}/{path}`.

```typescript
api.registerHttpRoute({
  path: "/status",
  method: "GET",
  handler: async (c) => c.json({ ok: true }),
});
// Available at GET /plugins/my-plugin/status
```

#### `api.registerService(service)`

Register a background service with `start()` and `stop()` lifecycle.

#### `api.registerSkill(skillPath)`

Register a skill file (markdown with frontmatter).

### `api.resolvePath(input)`

Resolve a path relative to the plugin directory. Throws if path traversal is attempted.

## Configuration

Plugin-specific configuration goes in `~/system/config.json`:

```json
{
  "plugins": {
    "list": [],
    "configs": {
      "my-plugin": {
        "apiKey": "sk-..."
      }
    }
  }
}
```

Accessible via `api.pluginConfig`.

## Security

- Plugins from `~/plugins/` (workspace) are trusted
- Plugins from config paths are untrusted (warning on load)
- Path sandboxing: `resolvePath()` blocks `../` traversal
- Code scanning: suspicious patterns (dynamic code execution) are logged
- Hook timeout: modifying hooks killed after 5s
- HTTP routes namespaced under `/plugins/{id}/`

## Discovery

Plugins are discovered from three locations (first match wins):

1. **Bundled**: `packages/*/matrixos.plugin.json`
2. **Workspace**: `~/plugins/*/matrixos.plugin.json`
3. **Config**: paths in `config.plugins.list[]`

## Sample Plugins

- `~/plugins/hello-world/` -- Tool, hook, and HTTP route example
- `~/plugins/example-channel/` -- Channel adapter skeleton
