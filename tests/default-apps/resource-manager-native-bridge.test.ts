// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeAppBridge, createNativeAppGatewayRequester } from "@desktop/main/embeds/native-app-bridge";
import App from "../../home/apps/resource-manager/src/App.js";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));
vi.mock("electron", () => electron);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "MatrixOS");
});

it("loads Resource Manager through the actual native app preload", async () => {
  vi.spyOn(process, "argv", "get").mockReturnValue(["electron", "--matrix-app-bridge"]);
  electron.contextBridge.exposeInMainWorld.mockImplementation((name, value) => {
    Object.assign(window, { [name]: value });
  });
  const snapshot = {
    machine: { handle: "review", hostname: "review", status: "healthy", uptimeSeconds: 60 },
    resources: {
      cpu: { cores: 4, load1: 1 },
      memory: { totalBytes: 1024, usedBytes: 512, availableBytes: 512 },
      swap: { totalBytes: 0, usedBytes: 0 }, disk: [],
    },
    services: [], processes: [], cleanupSuggestions: [], collectionWarnings: [],
  };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(snapshot)));
  const bridge = new NativeAppBridge({
    request: vi.fn(),
    gatewayOrigin: () => "https://gateway.test",
    gatewayRequest: createNativeAppGatewayRequester({
      getGatewayOrigin: () => "https://gateway.test", getToken: () => "desktop-token", fetchFn,
    }),
  });
  bridge.register(42, "resource-manager");
  const mainFrame = {};
  const handle = vi.fn();
  bridge.registerIpc({ handle });
  electron.ipcRenderer.invoke.mockImplementation((channel, request) => {
    const handler = handle.mock.calls.find(([name]) => name === channel)?.[1];
    return handler({ senderFrame: mainFrame, sender: {
      id: 42, mainFrame, getURL: () => "https://gateway.test/apps/resource-manager/",
    } }, request);
  });
  await import("../../desktop/src/preload/index.js");
  render(React.createElement(App));
  await waitFor(() => expect(screen.getByText("4 cores")).toBeTruthy());
  expect(screen.queryByText("Resource data is unavailable.")).toBeNull();
  expect(fetchFn).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith("native-app:gateway-fetch", {
    url: "/api/system/activity?processLimit=25&includeSuggestions=true", init: { method: "GET" },
  });
});
