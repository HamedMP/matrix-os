import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry, createHookRunner, type LoadedPlugin } from "../../packages/gateway/src/plugins/index.js";
import { startGatewayPlugins } from "../../packages/gateway/src/server/plugin-startup.js";

describe("gateway plugin startup", () => {
  it("loads plugins, mounts their routes, starts their services and fires gateway_start", async () => {
    const app = new Hono();
    const registry = createPluginRegistry();
    const hooks = createHookRunner(registry);
    const fire = vi.spyOn(hooks, "fireVoidHook");
    const start = vi.fn(async () => {});
    const loaded = [{ id: "demo" }] as unknown as LoadedPlugin[];
    const loadPlugins = vi.fn(async () => {
      registry.registerHttpRoute("demo", { method: "GET", path: "/ping", handler: (c) => c.text("pong") });
      registry.registerService("demo", { name: "worker", start, stop: vi.fn(async () => {}) });
      return loaded;
    });

    const result = await startGatewayPlugins({
      app, homePath: "/home", pluginsConfig: { list: ["demo"], configs: { demo: { on: true } } },
      pluginRegistry: registry, hookRunner: hooks, port: 4000, loadPlugins,
    });

    expect(result).toBe(loaded);
    expect(loadPlugins).toHaveBeenCalledWith({
      homePath: "/home", configPaths: ["demo"], registry, systemConfig: {}, pluginConfigs: { demo: { on: true } },
    });
    expect(await (await app.request("/plugins/demo/ping")).text()).toBe("pong");
    expect(start).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith("gateway_start", { port: 4000 });
  });

  it("keeps the gateway starting when plugins fail to load or a service fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = createPluginRegistry();
    const failed = await startGatewayPlugins({
      app: new Hono(), homePath: "/home", pluginsConfig: {}, pluginRegistry: registry, hookRunner: createHookRunner(registry), port: 4000,
      loadPlugins: vi.fn(async () => { throw new Error("bad plugin"); }),
    });
    expect(failed).toEqual([]);

    registry.registerService("demo", { name: "worker", start: vi.fn(async () => { throw new Error("boom"); }), stop: vi.fn(async () => {}) });
    const loaded = [{ id: "demo" }] as unknown as LoadedPlugin[];
    expect(await startGatewayPlugins({
      app: new Hono(), homePath: "/home", pluginsConfig: {}, pluginRegistry: registry, hookRunner: createHookRunner(registry), port: 4000,
      loadPlugins: vi.fn(async () => loaded),
    })).toBe(loaded);
    expect(error).toHaveBeenCalled();
  });
});
