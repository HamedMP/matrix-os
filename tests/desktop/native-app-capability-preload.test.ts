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

it("keeps non-Resource Manager apps on their previous native capability surface", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  await import("../../desktop/src/preload/index.js");
  const [name, bridge] = electron.contextBridge.exposeInMainWorld.mock.calls[0];
  expect(name).toBe("MatrixOS");
  expect(bridge.db).toBeDefined();
  expect(bridge.ai.generate).toBeTypeOf("function");
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
