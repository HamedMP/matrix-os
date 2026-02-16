# 029: Plugin System

## Problem

Matrix OS's extensibility is limited to markdown skills and internal IPC tools. Users cannot add new channel adapters, AI providers, agent tools, or background services without modifying core code. Moltbot has a full plugin SDK with 30+ extensions contributing channels, tools, skills, hooks, providers, and HTTP routes through a structured manifest and API. Matrix OS needs a plugin system to enable community extensions and modular architecture.

## Solution

A plugin system with three layers: (1) a JSON manifest (`matrixos.plugin.json`) declaring what a plugin provides, (2) a Plugin API object passed to the plugin's `register()` function for registering capabilities, and (3) a hook system with two execution modes (void hooks for fire-and-forget events, modifying hooks for sequential mutation chains). Plugins can contribute: channel adapters, IPC tools, skills, lifecycle hooks, HTTP routes, and background services.

## Design

### Plugin Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "channels": ["my-channel"],
  "skills": ["my-skill"],
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" }
    }
  }
}
```

```typescript
interface PluginManifest {
  id: string;                              // required, unique plugin id
  name?: string;                           // human-readable name
  version?: string;                        // semver
  description?: string;
  configSchema: Record<string, unknown>;   // JSON Schema for plugin config
  channels?: string[];                     // channel IDs this plugin contributes
  skills?: string[];                       // skill files relative to plugin dir
}
```

### Plugin API

```typescript
interface MatrixOSPluginApi {
  id: string;                              // plugin id from manifest
  config: SystemConfig;                    // system config
  pluginConfig?: Record<string, unknown>;  // plugin-specific config
  home: string;                            // home directory path
  logger: PluginLogger;                    // scoped logger

  // Registration methods
  registerTool(tool: ToolDefinition): void;
  registerHook(event: HookName, handler: HookHandler, opts?: HookOpts): void;
  registerChannel(adapter: ChannelAdapter): void;
  registerHttpRoute(route: HttpRoute): void;
  registerService(service: BackgroundService): void;
  registerSkill(skillPath: string): void;

  // Utilities
  resolvePath(input: string): string;      // resolve path relative to plugin dir
}

// Plugin module shape
type PluginModule =
  | { register: (api: MatrixOSPluginApi) => void | Promise<void> }
  | ((api: MatrixOSPluginApi) => void | Promise<void>);
```

### Hook System

Two execution modes:

**Void hooks** (fire-and-forget, all handlers run in parallel):
- `message_received` -- after inbound message processed
- `message_sent` -- after outbound message delivered
- `agent_end` -- after kernel invocation completes
- `session_start` / `session_end` -- conversation lifecycle
- `gateway_start` / `gateway_stop` -- gateway lifecycle

**Modifying hooks** (sequential, handlers run in priority order, can mutate or cancel):
- `before_agent_start` -- inject systemPrompt or prependContext
- `message_sending` -- modify content or `cancel: true` to suppress
- `before_tool_call` -- modify params or `block: true` with blockReason
- `after_tool_call` -- inspect/modify tool results

```typescript
type VoidHookName =
  | "message_received" | "message_sent"
  | "agent_end"
  | "session_start" | "session_end"
  | "gateway_start" | "gateway_stop";

type ModifyingHookName =
  | "before_agent_start"
  | "message_sending"
  | "before_tool_call"
  | "after_tool_call";

type HookName = VoidHookName | ModifyingHookName;

interface HookOpts {
  priority?: number;  // higher runs first (default: 0)
}

// Modifying hook result
interface BeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;  // modified params
}

interface MessageSendingResult {
  cancel?: boolean;
  content?: string;  // modified content
}
```

### Plugin Discovery + Loading

```typescript
type PluginOrigin = "bundled" | "workspace" | "config";

// Discovery locations (checked in order):
// 1. bundled: packages/*/matrixos.plugin.json (workspace packages)
// 2. workspace: ~/plugins/*/matrixos.plugin.json (user-installed)
// 3. config: paths in config.json plugins.list array
```

### Plugin Security

- **Origin trust hierarchy**: bundled > workspace > config
- **Config-origin plugins**: warn on first load, require user acknowledgment
- **Tool registration audit**: log all tools registered by plugins
- **Hook sandboxing**: modifying hooks run with a timeout (default: 5s), killed if exceeded
- **HTTP route namespacing**: plugin routes mounted under `/plugins/{id}/`
- **No filesystem access**: plugins use `api.resolvePath()` scoped to their directory
- **Code scanning**: optional static analysis of plugin code for suspicious patterns (eval, require, import of banned modules)

## Dependencies

- Phase 006 (ChannelAdapter interface) -- complete
- Phase 007 (CronService) -- complete
- Gateway HTTP server (Hono) -- complete

## File Locations

```
packages/gateway/src/
  plugins/
    types.ts              # PluginManifest, PluginApi, HookName, etc.
    loader.ts             # discover, validate, load plugins
    registry.ts           # PluginRegistry (registered tools, hooks, channels, routes)
    hooks.ts              # HookRunner (void + modifying execution)
    security.ts           # trust checks, code scanning, route namespacing
    api.ts                # createPluginApi() factory
home/
  plugins/                # user-installed plugins directory
    README.md             # "Place plugins here"
tests/
  plugins/
    loader.test.ts
    registry.test.ts
    hooks.test.ts
    security.test.ts
```
