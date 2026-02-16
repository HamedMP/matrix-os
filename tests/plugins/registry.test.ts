import { describe, it, expect, beforeEach } from "vitest";
import { createPluginRegistry, type PluginRegistry } from "../../packages/gateway/src/plugins/registry.js";
import type { ToolDefinition, HttpRoute, BackgroundService } from "../../packages/gateway/src/plugins/types.js";

describe("T936a: Plugin registry", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createPluginRegistry();
  });

  it("registerTool stores tool definition", () => {
    const tool: ToolDefinition = {
      name: "greet",
      description: "Greet a user",
      schema: { name: { type: "string" } },
      execute: async () => ({ content: [{ type: "text", text: "Hello" }] }),
    };
    registry.registerTool("hello-world", tool);

    const tools = registry.getTools();
    expect(tools.size).toBe(1);
    expect(tools.has("hello-world_greet")).toBe(true);
    expect(tools.get("hello-world_greet")!.pluginId).toBe("hello-world");
  });

  it("registerTool namespaces tool name", () => {
    const tool: ToolDefinition = {
      name: "fetch",
      description: "Fetch data",
      schema: {},
      execute: async () => ({ content: [{ type: "text", text: "data" }] }),
    };
    registry.registerTool("my-plugin", tool);

    const tools = registry.getTools();
    expect(tools.has("my-plugin_fetch")).toBe(true);
    expect(tools.get("my-plugin_fetch")!.name).toBe("my-plugin_fetch");
  });

  it("registerChannel stores channel adapter", () => {
    const adapter = { id: "my-channel", start: async () => {}, stop: async () => {} };
    registry.registerChannel("my-plugin", adapter);

    const channels = registry.getChannels();
    expect(channels.size).toBe(1);
    expect(channels.get("my-plugin")).toBe(adapter);
  });

  it("registerHook stores hook handler", () => {
    const handler = () => {};
    registry.registerHook("test-plugin", "message_received", handler);

    const hooks = registry.getHooks("message_received");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].pluginId).toBe("test-plugin");
  });

  it("registerHttpRoute stores route", () => {
    const route: HttpRoute = {
      path: "/status",
      method: "GET",
      handler: async (c) => c.json({ ok: true }),
    };
    registry.registerHttpRoute("my-plugin", route);

    const routes = registry.getRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].pluginId).toBe("my-plugin");
    expect(routes[0].path).toBe("/status");
  });

  it("registerService stores service", () => {
    const service: BackgroundService = {
      name: "bg-worker",
      start: async () => {},
      stop: async () => {},
    };
    registry.registerService("my-plugin", service);

    const services = registry.getServices();
    expect(services).toHaveLength(1);
    expect(services[0].pluginId).toBe("my-plugin");
    expect(services[0].name).toBe("bg-worker");
  });

  it("getTools returns all registered tools", () => {
    registry.registerTool("p1", { name: "a", description: "A", schema: {}, execute: async () => ({ content: [] }) });
    registry.registerTool("p2", { name: "b", description: "B", schema: {}, execute: async () => ({ content: [] }) });

    expect(registry.getTools().size).toBe(2);
  });

  it("getHooks returns handlers sorted by priority (higher first)", () => {
    const h1 = () => {};
    const h2 = () => {};
    const h3 = () => {};

    registry.registerHook("p1", "message_received", h1, { priority: 1 });
    registry.registerHook("p2", "message_received", h2, { priority: 10 });
    registry.registerHook("p3", "message_received", h3, { priority: 5 });

    const hooks = registry.getHooks("message_received");
    expect(hooks[0].priority).toBe(10);
    expect(hooks[1].priority).toBe(5);
    expect(hooks[2].priority).toBe(1);
  });

  it("getHooks returns empty array for unregistered events", () => {
    expect(registry.getHooks("gateway_start")).toEqual([]);
  });

  it("registerSkill stores skill path", () => {
    registry.registerSkill("my-plugin", "skills/helper.md");
    const skills = registry.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].pluginId).toBe("my-plugin");
    expect(skills[0].skillPath).toBe("skills/helper.md");
  });

  it("getPluginContributions summarizes correctly", () => {
    registry.registerTool("p1", { name: "t1", description: "", schema: {}, execute: async () => ({ content: [] }) });
    registry.registerTool("p1", { name: "t2", description: "", schema: {}, execute: async () => ({ content: [] }) });
    registry.registerHook("p1", "message_received", () => {});
    registry.registerService("p1", { name: "svc", start: () => {}, stop: () => {} });

    const contrib = registry.getPluginContributions("p1");
    expect(contrib.tools).toBe(2);
    expect(contrib.hooks).toBe(1);
    expect(contrib.services).toBe(1);
    expect(contrib.channels).toBe(0);
    expect(contrib.routes).toBe(0);
  });

  it("clear removes everything", () => {
    registry.registerTool("p1", { name: "t", description: "", schema: {}, execute: async () => ({ content: [] }) });
    registry.registerHook("p1", "agent_end", () => {});
    registry.clear();

    expect(registry.getTools().size).toBe(0);
    expect(registry.getHooks("agent_end")).toHaveLength(0);
  });
});
