# Tasks: Plugin System

**Spec**: spec.md | **Plan**: plan.md
**Task range**: T930-T969

## User Stories

- **US47**: "I can install a plugin that adds a new channel adapter to my Matrix OS"
- **US48**: "I can install a plugin that adds new tools to my agent"
- **US49**: "Plugins can react to events (messages, tool calls) via hooks"
- **US50**: "Plugins are sandboxed -- they can't access files outside their directory"
- **US51**: "I can see which plugins are installed and what they provide"

---

## Phase A: Types + Loader (T930-T935)

### Tests (TDD -- write FIRST)

- [x] T930a Write `tests/plugins/loader.test.ts`:
  - Discovers plugin from workspace path (~/plugins/my-plugin/)
  - Validates manifest (id required, configSchema required)
  - Rejects invalid manifest (missing id)
  - Loads plugin module (calls register function)
  - Discovers bundled plugins (packages/ with matrixos.plugin.json)
  - Returns discovery results with origin tag (bundled/workspace/config)

### T930 Plugin types
- [x] Create `packages/gateway/src/plugins/types.ts`
- [x] PluginManifest: id, name, version, description, configSchema, channels, skills
- [x] MatrixOSPluginApi interface: registerTool, registerHook, registerChannel, registerHttpRoute, registerService, registerSkill, resolvePath, logger
- [x] PluginModule type: object with register() or bare function
- [x] HookName: void hooks + modifying hooks
- [x] HookOpts: priority
- [x] Modifying hook result types (BeforeToolCallResult, MessageSendingResult, etc.)
- [x] BackgroundService: { name, start(), stop() }
- [x] HttpRoute: { path, method, handler }
- [x] ToolDefinition: { name, description, schema, execute }
- **Output**: Complete plugin type system

### T931 Manifest validator
- [x] Zod schema for matrixos.plugin.json
- [x] Required: id (string), configSchema (object)
- [x] Optional: name, version, description, channels, skills
- [x] Validate on load, throw descriptive errors for invalid manifests
- **Output**: Type-safe manifest parsing

### T932 Plugin discovery
- [x] Create `packages/gateway/src/plugins/loader.ts`
- [x] Scan locations in order:
  - [x] Bundled: `packages/*/matrixos.plugin.json`
  - [x] Workspace: `{home}/plugins/*/matrixos.plugin.json`
  - [x] Config: paths from `config.plugins.list[]`
- [x] Tag each with origin (bundled/workspace/config)
- [x] Deduplicate by id (first wins)
- [x] Return `DiscoveredPlugin[]` with manifest + path + origin
- **Output**: Plugin discovery from all sources

### T933 Plugin loader
- [x] Import plugin module (dynamic import of the entry point)
- [x] Entry point: `index.ts` / `index.js` / `src/index.ts` in plugin dir
- [x] Create Plugin API via factory, pass to register()
- [x] Catch and log registration errors (don't crash gateway)
- [x] Track load time per plugin
- **Output**: Plugins loaded and registered

### T934 Plugin API factory
- [x] Create `packages/gateway/src/plugins/api.ts`
- [x] `createPluginApi(manifest, pluginDir, config)` returns MatrixOSPluginApi
- [x] Scoped logger: prefix all log lines with `[plugin:{id}]`
- [x] `resolvePath()`: resolve relative to plugin directory, BLOCK path traversal (../)
- [x] Pass registrations to central registry (tools, hooks, channels, routes, services)
- **Output**: Plugin API with scoped access

### T935 Plugin config
- [x] Config section in `~/system/config.json`:
  ```json
  {
    "plugins": {
      "list": [],
      "configs": {
        "my-plugin": { "apiKey": "${MY_PLUGIN_API_KEY}" }
      }
    }
  }
  ```
- [x] Per-plugin config passed via `api.pluginConfig`
- [ ] Validate against plugin's configSchema
- **Output**: Plugin configuration via Everything Is a File

---

## Phase B: Registry + Hooks (T936-T942)

### Tests (TDD -- write FIRST)

- [x] T936a Write `tests/plugins/registry.test.ts`:
  - registerTool stores tool definition
  - registerChannel stores channel adapter
  - registerHook stores hook handler
  - registerHttpRoute stores route
  - registerService stores service
  - getTools() returns all registered tools
  - getHooks(name) returns handlers sorted by priority

- [x] T937a Write `tests/plugins/hooks.test.ts`:
  - Void hooks: all handlers run in parallel
  - Void hooks: one handler error doesn't block others
  - Modifying hooks: run in priority order (higher first)
  - Modifying hooks: result merges across handlers
  - before_tool_call: block=true prevents tool execution
  - message_sending: cancel=true prevents message delivery
  - Hook timeout: handler killed after 5s, logged as error

### T936 Plugin registry
- [x] Create `packages/gateway/src/plugins/registry.ts`
- [x] Central store: tools Map, hooks Map<HookName, Handler[]>, channels Map, routes[], services[]
- [x] Thread-safe registration (plugins load sequentially)
- [x] `getTools()`, `getHooks(name)`, `getChannels()`, `getRoutes()`, `getServices()`
- [x] Hooks sorted by priority (descending, higher runs first)
- **Output**: Central plugin capability registry

### T937 Hook runner -- void hooks
- [x] Create `packages/gateway/src/plugins/hooks.ts`
- [x] `fireVoidHook(name, context)`: run all handlers via `Promise.allSettled()`
- [x] Log errors from individual handlers (don't throw)
- [x] Void hooks: message_received, message_sent, agent_end, session_start/end, gateway_start/stop
- **Output**: Fire-and-forget event hooks

### T938 Hook runner -- modifying hooks
- [x] `fireModifyingHook(name, context)`: run handlers sequentially by priority
- [x] Each handler returns a result object (or undefined to skip)
- [x] Merge results: later handler results override earlier ones
- [x] Timeout per handler (default: 5s, configurable)
- [x] Modifying hooks: before_agent_start, message_sending, before_tool_call, after_tool_call
- **Output**: Sequential mutation chain hooks

### T939 Wire hooks into gateway
- [x] Fire `gateway_start` after gateway fully initialized
- [x] Fire `gateway_stop` before gateway shutdown
- [ ] Fire `message_received` in dispatcher after inbound message
- [ ] Fire `message_sending` before outbound send (can cancel)
- [ ] Fire `message_sent` after successful outbound
- **Output**: Gateway lifecycle hooks active

### T940 Wire hooks into kernel
- [ ] Fire `before_agent_start` before kernel spawn (can inject systemPrompt)
- [ ] Fire `agent_end` after kernel invocation completes
- [ ] Fire `before_tool_call` in PreToolUse hook (can block)
- [ ] Fire `after_tool_call` in PostToolUse hook
- **Output**: Kernel lifecycle hooks active

### T941 Tool registration into IPC
- [ ] Plugin-registered tools merged into IPC server tool list
- [x] Tools namespaced: `{pluginId}_{toolName}` to avoid collisions
- [ ] Tool descriptions prefixed with `[plugin:{id}]` for transparency
- **Output**: Plugin tools available to the agent

### T942 Channel registration into ChannelManager
- [ ] Plugin-registered channels added to ChannelManager
- [ ] Channel config from plugin config section
- [ ] Standard ChannelAdapter interface (same as built-in channels)
- [ ] Channel start/stop lifecycle managed by ChannelManager
- **Output**: Plugin channels work like built-in channels

---

## Phase C: Security + HTTP + Services (T943-T949)

### Tests (TDD -- write FIRST)

- [x] T943a Write `tests/plugins/security.test.ts`:
  - Bundled plugins load without warning
  - Workspace plugins load without warning
  - Config-origin plugins log a trust warning
  - resolvePath blocks path traversal (../)
  - resolvePath blocks absolute paths outside plugin dir
  - Suspicious code patterns detected in static analysis
  - Hook timeout kills handler and logs error

### T943 Plugin security
- [x] Create `packages/gateway/src/plugins/security.ts`
- [x] Origin trust: bundled (trusted), workspace (trusted), config (warn on first load)
- [x] Path sandboxing: `resolvePath()` rejects `../` and absolute paths outside plugin dir
- [x] Audit log: log all tool/hook/channel registrations with plugin id
- [x] Optional code scanning: detect dangerous patterns (dynamic code execution, child process spawning) in plugin source via static regex analysis
- [ ] Scan runs on first load, results cached
- **Output**: Plugin security baseline

### T944 HTTP route registration
- [x] Plugin HTTP routes mounted under `/plugins/{pluginId}/` namespace
- [x] Routes added to Hono app during plugin load
- [x] Standard Hono handler signature
- [ ] Auth: plugin routes inherit gateway auth by default
- **Output**: Plugins can expose HTTP endpoints

### T945 Background service lifecycle
- [x] Services started after all plugins loaded
- [x] Services stopped before gateway shutdown (in reverse order)
- [x] Service errors logged, don't crash gateway
- [ ] Health check: `GET /api/plugins` includes service status
- **Output**: Plugins can run background processes

### T946 Plugin list endpoint
- [x] `GET /api/plugins` -- returns all loaded plugins with:
  - id, name, version, origin
  - Contributed: tools, hooks, channels, routes, services (counts)
  - Status: loaded / error
- **Output**: Plugin visibility in API

### T947 [P] Plugin install helper
- [ ] `POST /api/plugins/install` -- accepts { url } or { path }
- [ ] URL: git clone to ~/plugins/{id}/
- [ ] Path: symlink to ~/plugins/{id}/
- [ ] Validate manifest after install
- [ ] Hot-reload: re-discover and load without gateway restart
- **Output**: Plugin installation from API

### T948 [P] Plugin uninstall
- [ ] `DELETE /api/plugins/{id}` -- remove from ~/plugins/
- [ ] Stop running services
- [ ] Deregister tools, hooks, channels, routes
- [ ] Hot-reload: deregister without gateway restart
- **Output**: Clean plugin removal

### T949 [P] Plugin directory template
- [x] Create `home/plugins/README.md` -- explains plugin format
- [x] Template includes example directory structure
- **Output**: Users know how to create plugins

---

## Phase D: Sample Plugin + Docs (T950-T952)

### T950 [P] Sample plugin: hello-world
- [x] Create `home/plugins/hello-world/`
- [x] matrixos.plugin.json: `{ "id": "hello-world", "configSchema": {} }`
- [x] index.ts: registers one tool (`hello_greet`), one hook (`message_received` logs to console), one HTTP route (`GET /plugins/hello-world/status`)
- [ ] Tests: verify the plugin loads and all registrations work
- **Output**: Working reference plugin

### T951 [P] Sample channel plugin skeleton
- [x] Create `home/plugins/example-channel/`
- [x] Implements ChannelAdapter with stub methods
- [x] Shows how to register a channel plugin
- **Output**: Channel plugin development template

### T952 [P] Plugin developer guide
- [x] Create `docs/plugins.md` (only because explicitly needed for plugin developers)
- [x] Covers: manifest format, API methods, hook types, security rules, config, examples
- [x] Links to sample plugins
- **Output**: Plugin development documentation

---

## Checkpoint

1. Place `hello-world` plugin in `~/plugins/` -- gateway discovers and loads it.
2. Agent uses `hello_greet` tool -- returns greeting.
3. Send a message -- `message_received` hook fires, logs to console.
4. `GET /api/plugins` -- shows hello-world with its tools, hooks, routes.
5. `GET /plugins/hello-world/status` -- returns plugin HTTP route response.
6. Create a plugin with `before_tool_call` hook that blocks `rm` -- agent tries rm, gets blocked.
7. Plugin with path traversal in resolvePath -- blocked.
8. `bun run test` passes.
