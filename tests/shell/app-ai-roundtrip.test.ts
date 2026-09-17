import { runInNewContext } from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { buildBridgeScript } from "../../shell/src/lib/os-bridge.js";
import { prepareAppAiRequest } from "../../shell/src/components/app-ai-request.js";
import { createAppAiRoutes } from "../../packages/gateway/src/app-ai/routes.js";

it("executes the injected app API through postMessage and the authenticated route seam", async () => {
  const generate = vi.fn(async () => ({ text: "brain summary" }));
  const routes = createAppAiRoutes({ authorize: async (_c, app) => app === "brain", generate });
  const window: {
    MatrixOS?: { ai: { generate(input: { prompt: string }): Promise<{ text: string }> } };
    addEventListener: ReturnType<typeof vi.fn>;
    parent: { postMessage(message: { payload: { init: RequestInit } }, origin: string, ports: MessagePort[]): Promise<void> };
  } = {
    addEventListener: vi.fn(),
    parent: { postMessage: async (message: { payload: { init: RequestInit } }, _origin: string, ports: MessagePort[]) => {
      const response = await routes.request("/", prepareAppAiRequest("brain", message.payload.init));
      ports[0].postMessage({ ok: response.ok, body: await response.json() });
      ports[0].close();
    } },
  };
  runInNewContext(buildBridgeScript("brain"), {
    window, MessageChannel, setTimeout, clearTimeout,
    document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild: vi.fn() } },
  });
  expect(await window.MatrixOS!.ai.generate({ prompt: "notes" })).toEqual({ text: "brain summary" });
  expect(generate).toHaveBeenCalledWith({ app: "brain", prompt: "notes" }, expect.any(AbortSignal));
});

it("keeps legacy kernel submission alongside the new text API in the injected Web bridge", async () => {
  const { handleBridgeMessage } = await import("../../shell/src/lib/os-bridge.js");
  const sendToKernel = vi.fn();
  const source = {};
  const window = {
    MatrixOS: undefined as unknown as { generate(context: string): void; ai: { generate: unknown } },
    addEventListener: vi.fn(),
    parent: { postMessage: (data: unknown) => handleBridgeMessage(
      { data, source, origin: "null" } as unknown as MessageEvent,
      { sendToKernel, fetchData: vi.fn(), openApp: vi.fn() },
      { expectedSource: source as Window, expectedApp: "brain", expectedOrigins: new Set(["null"]) },
    ) },
  };
  runInNewContext(buildBridgeScript("brain"), {
    window, MessageChannel, setTimeout, clearTimeout,
    document: { documentElement: { dataset: {} }, createElement: () => ({}), head: { appendChild: vi.fn() } },
  });
  expect(window.MatrixOS.generate("Read my notes")).toBeUndefined();
  expect(sendToKernel).toHaveBeenCalledWith("[App: brain] Read my notes");
  expect(window.MatrixOS.ai.generate).toBeTypeOf("function");
});
