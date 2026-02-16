# Plan: Plugin System

**Spec**: `specs/029-plugins/spec.md`
**Depends on**: Phase 006 (ChannelAdapter), Phase 007 (CronService), Gateway (Hono)
**Estimated effort**: Large (18 tasks + TDD)

## Approach

Build the type foundations first (manifest, API, hook types). Then the loader/registry. Then the hook runner (the most complex piece -- two execution modes). Then security. Then wire everything into the gateway lifecycle. A sample plugin at the end proves the system works end-to-end.

### Phase A: Types + Loader (T930-T935)

1. Plugin types (manifest, API, hook names, module shape)
2. Manifest validator (Zod schema for matrixos.plugin.json)
3. Plugin discovery (scan bundled, workspace, config paths)
4. Plugin loader (import module, validate manifest, instantiate)
5. Plugin API factory (createPluginApi with scoped logger, path resolver)

### Phase B: Registry + Hooks (T936-T942)

1. Plugin registry (central store of all registered tools, hooks, channels, routes, services)
2. Hook runner -- void hooks (parallel Promise.all)
3. Hook runner -- modifying hooks (sequential by priority, result merging)
4. Wire hooks into gateway lifecycle (gateway_start/stop, message pipeline)
5. Wire hooks into kernel (before/after tool call, agent start/end)
6. Tool registration into IPC server
7. Channel registration into ChannelManager

### Phase C: Security + HTTP + Services (T943-T949)

1. Plugin security -- origin trust, code scanning, audit logging
2. HTTP route registration (namespaced under /plugins/{id}/)
3. Background service lifecycle (start/stop with gateway)
4. Plugin config section in config.json
5. Plugin install command (copy to ~/plugins/)
6. Plugin list endpoint (GET /api/plugins)

### Phase D: Sample Plugin + Docs (T950-T952)

1. Sample plugin: "hello-world" with tool, hook, HTTP route
2. Sample channel plugin skeleton
3. Plugin developer documentation

## Files to Create

- `packages/gateway/src/plugins/types.ts`
- `packages/gateway/src/plugins/loader.ts`
- `packages/gateway/src/plugins/registry.ts`
- `packages/gateway/src/plugins/hooks.ts`
- `packages/gateway/src/plugins/security.ts`
- `packages/gateway/src/plugins/api.ts`
- `home/plugins/README.md`
- `tests/plugins/*.test.ts`

## Files to Modify

- `packages/gateway/src/index.ts` -- plugin lifecycle (discover, load, start services, fire gateway_start)
- `packages/gateway/src/dispatcher.ts` -- fire message hooks
- `packages/gateway/src/channels/manager.ts` -- accept plugin-registered channels
- `packages/kernel/src/ipc-server.ts` -- accept plugin-registered tools
- `packages/kernel/src/spawn.ts` -- fire before_agent_start, agent_end hooks
- `home/system/config.json` -- plugins config section
