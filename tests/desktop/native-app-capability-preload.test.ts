import { afterEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));
vi.mock("electron", () => electron);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

it("exposes shared app capabilities while reserving activity access for Resource Manager", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  await import("../../desktop/src/preload/index.js");
  const [name, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  expect(name).toBe("MatrixOS");
  expect(bridge.db).toBeDefined();
  expect(bridge.ai.generate).toBeTypeOf("function");
  expect(bridge.ai.routes).toBeTypeOf("function");
  expect(bridge.integrations).toBeTypeOf("function");
  expect(bridge.service).toBeTypeOf("function");
  expect(bridge.describeService).toBeTypeOf("function");
  expect(bridge.capabilities).toBeTypeOf("function");
  expect(Object.hasOwn(bridge, "gatewayFetch")).toBe(false);
  // Capability detection must retain the app's fallback instead of selecting
  // the Resource Manager-only request path introduced by #1624.
  expect(typeof bridge.gatewayFetch === "function" ? "native" : "fallback").toBe("fallback");
  expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
});

it("exposes the activity capability when the main process opts the app in", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "electron", "--matrix-app-bridge", "--matrix-app-activity-bridge",
  ]);
  electron.ipcRenderer.invoke.mockResolvedValue({ resources: {} });
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  await expect(bridge.gatewayFetch("/api/system/activity")).resolves.toEqual({ resources: {} });
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("native-app:gateway-fetch", {
    url: "/api/system/activity",
  });
});

 it("wires the app AI API to its dedicated IPC channel", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  electron.ipcRenderer.invoke.mockResolvedValue({ text: "summary" });
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  await expect(bridge.ai.generate({ prompt: "notes" })).resolves.toEqual({ text: "summary" });
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("native-app:ai-generate", { prompt: "notes" });
});

it("restores the one-way legacy API alongside text generation", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  electron.ipcRenderer.invoke.mockResolvedValue({ ok: true });
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  expect(bridge.generate("Summarize my notes")).toBeUndefined();
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("native-app:generate", "Summarize my notes");
  expect(bridge.ai.generate).toBeTypeOf("function");
  expect(() => bridge.generate({ context: "forged" })).toThrow("Invalid app task");
  expect(() => bridge.generate("x".repeat(32001))).toThrow("Invalid app task");
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
});

it("exposes the one-way installed-app launch request in native app views", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  electron.ipcRenderer.invoke.mockResolvedValue({ ok: true });
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  expect(bridge.openApp("Planner", "/files/apps/planner/index.html")).toBeUndefined();
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("native-app:open", {
    name: "Planner", path: "/files/apps/planner/index.html",
  });
  expect(() => bridge.openApp("Settings", "__settings__")).toThrow("Invalid app launch");
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
});

it("advertises gallery discovery and owner integration inventory only when explicitly opted in", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge", "--matrix-app-gallery-bridge", "--matrix-app-integrations-bridge"]);
  electron.ipcRenderer.invoke.mockResolvedValue([{ service: "gmail", account_label: "personal", status: "active" }]);
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  expect(bridge.db.compareAndSwap).toBeTypeOf("function");
  await expect(bridge.integrations()).resolves.toEqual([{ service: "gmail", account_label: "personal", status: "active" }]);
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("native-app:gateway-fetch", { url: "/api/integrations" });
  expect(bridge.gatewayFetch).toBeTypeOf("function");
});

it("offers connected starters inventory without advertising general gateway access", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge", "--matrix-app-integrations-bridge"]);
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  expect(bridge.integrations).toBeTypeOf("function");
  expect(Object.hasOwn(bridge, "gatewayFetch")).toBe(false);
});

it("runs the real integration preload -> IPC -> authenticated gateway request chain", async () => {
  const { NativeAppBridge } = await import("../../desktop/src/main/embeds/native-app-bridge");
  const { createNativeAppCapabilityRequester, createNativeAppAiRoutesRequester } = await import("../../desktop/src/main/embeds/native-app-capabilities");
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  const calls: Array<{ url: string; body: unknown; token: string | null }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body, token: new Headers(init?.headers).get("authorization") });
    if (String(url).includes("/api/bridge/ai/routes")) return Response.json({ routes: [], defaultRoute: null });
    switch (body.input.kind) {
      case "capabilities": return Response.json({ version: 1, integrations: true, ai: true });
      case "integrations.list": return Response.json({ services: [{ service: "google-drive", account_label: "default", status: "connected" }] });
      case "integrations.describe": return Response.json({ service: "google-drive", name: "Google Drive", actions: [{ id: "list_files", description: "List files", risk: "read", params: { limit: { type: "number" } } }] });
      default: return Response.json({ files: [{ id: "notes", name: "Notes" }] });
    }
  });
  let generation = 0;
  const frame = {};
  const event = { senderFrame: frame, sender: { id: 7, mainFrame: frame, getURL: () => "https://gateway.test/apps/drive-chat/", isDestroyed: () => false } };
  const requesterOptions = { getGatewayOrigin: () => "https://gateway.test", getToken: () => "host-only-token", fetchFn };
  const native = new NativeAppBridge({ authGeneration: () => generation, gatewayOrigin: requesterOptions.getGatewayOrigin, generate: vi.fn(), aiRequest: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), capabilityRequest: createNativeAppCapabilityRequester(requesterOptions), aiRoutesRequest: createNativeAppAiRoutesRequester(requesterOptions) });
  native.register(7, "tools/drive-chat", "drive-chat");
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  native.registerIpc({ handle: (channel, handler) => handlers.set(channel, handler as never) });
  electron.ipcRenderer.invoke.mockImplementation(async (channel, input) => handlers.get(channel)!(event, input));
  await import("../../desktop/src/preload/index.js");
  const [, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  await expect(bridge.capabilities()).resolves.toEqual({ version: 1, integrations: true, ai: true });
  await expect(bridge.integrations()).resolves.toEqual([{ service: "google-drive", account_label: "default", status: "connected" }]);
  await expect(bridge.describeService("google-drive")).resolves.toMatchObject({ service: "google-drive", actions: [{ id: "list_files" }] });
  await expect(bridge.service("google-drive", "list_files", { limit: 10 }, "default")).resolves.toEqual({ files: [{ id: "notes", name: "Notes" }] });
  expect(calls[3]).toEqual({ url: "https://gateway.test/api/bridge/capabilities", body: { app: "tools/drive-chat", input: { kind: "integrations.call", service: "google-drive", action: "list_files", params: { limit: 10 }, label: "default" } }, token: "Bearer host-only-token" });
  await expect(bridge.ai.routes()).resolves.toEqual({ routes: [], defaultRoute: null });
  expect(JSON.stringify(bridge)).not.toContain("host-only-token");
  generation++;
  await expect(bridge.integrations()).rejects.toThrow("App integrations are unavailable");
  expect(fetchFn).toHaveBeenCalledTimes(5);
});
