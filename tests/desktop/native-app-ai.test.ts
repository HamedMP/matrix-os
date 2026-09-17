import { expect, it, vi } from "vitest";
import { NativeAppBridge, createNativeAppAiRequester } from "../../desktop/src/main/embeds/native-app-bridge.js";

it("binds AI requests to the registered app and rejects another origin", async () => {
  const aiRequest = vi.fn(async () => ({ text: "done" }));
  const bridge = new NativeAppBridge({ authGeneration: () => 0, generate: vi.fn(), request: vi.fn(), gatewayRequest: vi.fn(), aiRequest, gatewayOrigin: () => "https://gateway.test" });
  bridge.register(1, "brain");
  const sender = { id: 1, url: "https://gateway.test/apps/brain/" };
  await expect(bridge.aiGenerate(sender, { prompt: "hello" })).resolves.toEqual({ text: "done" });
  expect(aiRequest).toHaveBeenCalledWith("brain", { prompt: "hello" });
  await expect(bridge.aiGenerate({ ...sender, url: "https://evil.test/apps/brain/" }, { prompt: "hello" })).rejects.toThrow();
  await expect(bridge.aiGenerate(sender, { prompt: "hello", app: "other" })).rejects.toThrow();
  expect(aiRequest).toHaveBeenCalledTimes(1);
});

it("keeps credentials in main and posts only to the AI endpoint", async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ text: "done" })));
  const request = createNativeAppAiRequester({ getGatewayOrigin: () => "https://gateway.test", getToken: () => "test-token", fetchFn });
  await expect(request("brain", { prompt: "hello" })).resolves.toEqual({ text: "done" });
  expect(fetchFn).toHaveBeenCalledWith("https://gateway.test/api/bridge/ai", expect.objectContaining({
    method: "POST", redirect: "error", signal: expect.any(AbortSignal),
    body: JSON.stringify({ app: "brain", prompt: "hello" }),
  }));
});
