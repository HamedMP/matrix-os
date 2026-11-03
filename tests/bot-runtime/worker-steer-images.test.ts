import { expect, it, vi } from "vitest";
import { createBotWorker } from "../../packages/bot-runtime/src/worker.js";
import type { BotWorkerBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";

const state = vi.hoisted(() => ({ control: vi.fn(() => true), release: () => {}, ready: () => {} }));
vi.mock("../../packages/bot-runtime/src/loop.js", () => ({ runBotTurn: async (input: { onControl(value: unknown): void; command: { runId: string } }) => {
  input.onControl({ steer: state.control }); state.ready();
  await new Promise<void>(resolve => { state.release = resolve; });
  return { runId: input.command.runId, status: "completed", toolActions: 0 };
} }));

it.each([false, true])("ACKs image steering only after hydration and keeps Cancel authoritative: cancel=%s", async cancel => {
  state.control.mockClear();
  const ready = Promise.withResolvers<void>(); state.ready = ready.resolve;
  const image = Promise.withResolvers<{ mimeType: "image/png"; totalChars: number; data: string }>();
  const broker = { loadRun: async () => ({ route: { api: "openai-responses", modelId: "gpt-6.1-sol", input: ["text", "image"], contextWindow: 128000, maxOutputTokens: 8192 },
    systemPrompt: "Matrix", capabilities: [], limits: { maxToolActions: 1 }, turn: { kind: "prompt", text: "Work" } }),
    readImageChunk: vi.fn(() => image.promise) } as unknown as BotWorkerBrokerClient;
  const worker = createBotWorker({ brokerFor: () => broker, bridgeOrigin: "http://127.0.0.1:41000" });
  const run = worker.handle({ version: 1, kind: "bot.run", runId: "run_images" }); await ready.promise;
  const steer = worker.handle({ version: 1, kind: "bot.steer", runId: "run_images", text: "Inspect", imageRange: { start: 1, count: 1 } });
  await vi.waitFor(() => expect(broker.readImageChunk).toHaveBeenCalledWith({ index: 1, offset: 0 }));
  expect(state.control).not.toHaveBeenCalled();
  if (cancel) await worker.handle({ version: 1, kind: "bot.cancel", runId: "run_images" });
  image.resolve({ mimeType: "image/png", totalChars: 4, data: "AAAA" });
  expect(await steer).toEqual({ acknowledged: !cancel });
  if (cancel) expect(state.control).not.toHaveBeenCalled();
  else expect(state.control).toHaveBeenCalledWith("Inspect", [{ mimeType: "image/png", data: "AAAA" }]);
  state.release(); await run;
});
