import { join, resolve, normalize } from "node:path";
import type {
  PluginManifest,
  MatrixOSPluginApi,
  PluginLogger,
  ToolDefinition,
  HookName,
  HookHandler,
  HookOpts,
  HttpRoute,
  BackgroundService,
} from "./types.js";
import type { PluginRegistry } from "./registry.js";

function createPluginLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    info(msg: string) { console.log(`${prefix} ${msg}`); },
    warn(msg: string) { console.warn(`${prefix} ${msg}`); },
    error(msg: string) { console.error(`${prefix} ${msg}`); },
    debug(msg: string) { console.debug(`${prefix} ${msg}`); },
  };
}

export function createResolvePath(pluginDir: string): (input: string) => string {
  const normalizedBase = normalize(resolve(pluginDir));
  return (input: string): string => {
    if (input.startsWith("/")) {
      const normalizedInput = normalize(input);
      if (!normalizedInput.startsWith(normalizedBase)) {
        throw new Error(`Path traversal blocked: ${input} is outside plugin directory`);
      }
      return normalizedInput;
    }
    const resolved = normalize(resolve(pluginDir, input));
    if (!resolved.startsWith(normalizedBase)) {
      throw new Error(`Path traversal blocked: ${input} resolves outside plugin directory`);
    }
    return resolved;
  };
}

export interface CreatePluginApiOpts {
  manifest: PluginManifest;
  pluginDir: string;
  homePath: string;
  systemConfig: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registry: PluginRegistry;
}

export function createPluginApi(opts: CreatePluginApiOpts): MatrixOSPluginApi {
  const { manifest, pluginDir, homePath, systemConfig, pluginConfig, registry } = opts;
  const logger = createPluginLogger(manifest.id);
  const resolvePathFn = createResolvePath(pluginDir);

  return {
    id: manifest.id,
    config: systemConfig,
    pluginConfig,
    home: homePath,
    logger,

    registerTool(tool: ToolDefinition) {
      registry.registerTool(manifest.id, tool);
      logger.info(`Registered tool: ${tool.name}`);
    },

    registerHook(event: HookName, handler: HookHandler, hookOpts?: HookOpts) {
      registry.registerHook(manifest.id, event, handler, hookOpts);
      logger.info(`Registered hook: ${event}`);
    },

    registerChannel(adapter: unknown) {
      registry.registerChannel(manifest.id, adapter);
      logger.info("Registered channel adapter");
    },

    registerHttpRoute(route: HttpRoute) {
      registry.registerHttpRoute(manifest.id, route);
      logger.info(`Registered HTTP route: ${route.method} ${route.path}`);
    },

    registerService(service: BackgroundService) {
      registry.registerService(manifest.id, service);
      logger.info(`Registered service: ${service.name}`);
    },

    registerSkill(skillPath: string) {
      registry.registerSkill(manifest.id, skillPath);
      logger.info(`Registered skill: ${skillPath}`);
    },

    resolvePath: resolvePathFn,
  };
}
