/** Load plugins, mount their HTTP routes, start their services and fire `gateway_start`. */
import type { Hono } from "hono";
import { loadAllPlugins, type HookRunner, type LoadedPlugin, type PluginRegistry } from "../plugins/index.js";

export interface GatewayPluginStartupOptions {
  app: Hono;
  homePath: string;
  pluginsConfig: { list?: string[]; configs?: Record<string, Record<string, unknown>> };
  pluginRegistry: PluginRegistry;
  hookRunner: HookRunner;
  port: number;
  loadPlugins?: typeof loadAllPlugins;
}

/** Plugin failures are logged and never stop the gateway; returns whatever loaded. */
export async function startGatewayPlugins({
  app, homePath, pluginsConfig, pluginRegistry, hookRunner, port, loadPlugins = loadAllPlugins,
}: GatewayPluginStartupOptions): Promise<LoadedPlugin[]> {
  let loadedPlugins: LoadedPlugin[] = [];
  try {
    loadedPlugins = await loadPlugins({
      homePath,
      configPaths: pluginsConfig.list,
      registry: pluginRegistry,
      systemConfig: {},
      pluginConfigs: pluginsConfig.configs,
    });

    // T944: Mount plugin HTTP routes
    for (const route of pluginRegistry.getRoutes()) {
      const fullPath = `/plugins/${route.pluginId}${route.path}`;
      const method = route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch";
      app[method](fullPath, route.handler);
    }

    // T945: Start background services
    for (const svc of pluginRegistry.getServices()) {
      try {
        await svc.start();
      } catch (err) {
        console.error(`[plugin:${svc.pluginId}] Service ${svc.name} failed to start: ${err}`);
      }
    }

    // T939: Fire gateway_start hook
    await hookRunner.fireVoidHook("gateway_start", { port });
  } catch (err) {
    console.error("[plugins] Failed to initialize plugins:", err);
  }
  return loadedPlugins;
}
