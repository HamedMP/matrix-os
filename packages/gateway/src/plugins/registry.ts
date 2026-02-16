import type {
  ToolDefinition,
  HookName,
  RegisteredHook,
  HookHandler,
  HookOpts,
  HttpRoute,
  BackgroundService,
} from "./types.js";

export interface PluginRegistry {
  registerTool(pluginId: string, tool: ToolDefinition): void;
  registerHook(pluginId: string, event: HookName, handler: HookHandler, opts?: HookOpts): void;
  registerChannel(pluginId: string, adapter: unknown): void;
  registerHttpRoute(pluginId: string, route: HttpRoute): void;
  registerService(pluginId: string, service: BackgroundService): void;
  registerSkill(pluginId: string, skillPath: string): void;

  getTools(): Map<string, ToolDefinition & { pluginId: string }>;
  getHooks(event: HookName): RegisteredHook[];
  getChannels(): Map<string, unknown>;
  getRoutes(): Array<HttpRoute & { pluginId: string }>;
  getServices(): Array<BackgroundService & { pluginId: string }>;
  getSkills(): Array<{ pluginId: string; skillPath: string }>;

  getPluginContributions(pluginId: string): {
    tools: number;
    hooks: number;
    channels: number;
    routes: number;
    services: number;
    skills: number;
  };

  clear(): void;
}

export function createPluginRegistry(): PluginRegistry {
  const tools = new Map<string, ToolDefinition & { pluginId: string }>();
  const hooks = new Map<HookName, RegisteredHook[]>();
  const channels = new Map<string, unknown>();
  const routes: Array<HttpRoute & { pluginId: string }> = [];
  const services: Array<BackgroundService & { pluginId: string }> = [];
  const skills: Array<{ pluginId: string; skillPath: string }> = [];

  return {
    registerTool(pluginId, tool) {
      const namespacedName = `${pluginId}_${tool.name}`;
      tools.set(namespacedName, { ...tool, name: namespacedName, pluginId });
    },

    registerHook(pluginId, event, handler, opts) {
      const entry: RegisteredHook = {
        pluginId,
        event,
        handler,
        priority: opts?.priority ?? 0,
      };
      const existing = hooks.get(event) ?? [];
      existing.push(entry);
      existing.sort((a, b) => b.priority - a.priority);
      hooks.set(event, existing);
    },

    registerChannel(pluginId, adapter) {
      channels.set(pluginId, adapter);
    },

    registerHttpRoute(pluginId, route) {
      routes.push({ ...route, pluginId });
    },

    registerService(pluginId, service) {
      services.push({ ...service, pluginId });
    },

    registerSkill(pluginId, skillPath) {
      skills.push({ pluginId, skillPath });
    },

    getTools() {
      return tools;
    },

    getHooks(event) {
      return hooks.get(event) ?? [];
    },

    getChannels() {
      return channels;
    },

    getRoutes() {
      return routes;
    },

    getServices() {
      return services;
    },

    getSkills() {
      return skills;
    },

    getPluginContributions(pluginId) {
      let toolCount = 0;
      for (const t of tools.values()) {
        if (t.pluginId === pluginId) toolCount++;
      }
      let hookCount = 0;
      for (const hList of hooks.values()) {
        hookCount += hList.filter((h) => h.pluginId === pluginId).length;
      }
      return {
        tools: toolCount,
        hooks: hookCount,
        channels: channels.has(pluginId) ? 1 : 0,
        routes: routes.filter((r) => r.pluginId === pluginId).length,
        services: services.filter((s) => s.pluginId === pluginId).length,
        skills: skills.filter((s) => s.pluginId === pluginId).length,
      };
    },

    clear() {
      tools.clear();
      hooks.clear();
      channels.clear();
      routes.length = 0;
      services.length = 0;
      skills.length = 0;
    },
  };
}
