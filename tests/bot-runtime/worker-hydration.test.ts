import { describe, expect, it, vi } from "vitest";
import { BOT_IMAGE_CHUNK_CHARS, type BotImageChunk, type BotRunSpec } from "@matrix-os/contracts";
import { BotBrokerError, type BotWorkerBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { createBotCommandHandler } from "../../packages/bot-runtime/src/worker-entry.js";
import { createBotWorker, loadRunImages, runCommandFromSpec } from "../../packages/bot-runtime/src/worker.js";
import { ScopeRuntimeBotCommandError } from "../../packages/scope-runtime/src/worker-bot.js";

const spec: BotRunSpec = {
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text", "image"], contextWindow: 200_000, maxOutputTokens: 4_096 },
  systemPrompt: "You are Research Rabbit.",
  capabilities: ["artifact.write"],
  limits: { maxToolActions: 20 },
  turn: { kind: "prompt", text: "What is in this photo?", imageCount: 1 },
};

function broker(chunks: (request: { index: number; offset: number }) => BotImageChunk, overrides: Partial<BotWorkerBrokerClient> = {}): BotWorkerBrokerClient {
  return {
    loadRun: vi.fn(async () => spec),
    readImageChunk: vi.fn(async (request) => chunks(request)),
    loadSession: vi.fn(),
    saveSession: vi.fn(),
    tool: vi.fn(),
    event: vi.fn(),
    ...overrides,
  };
}

describe("bot run hydration", () => {
  it("reads an image in bounded chunks and rebuilds the run command", async () => {
    const data = `${"A".repeat(BOT_IMAGE_CHUNK_CHARS + 100)}==`;
    const source = broker(({ offset }) => ({ mimeType: "image/png", totalChars: data.length, data: data.slice(offset, offset + BOT_IMAGE_CHUNK_CHARS) }));
    const images = await loadRunImages(source, 1);
    expect(images).toEqual([{ mimeType: "image/png", data }]);
    expect(vi.mocked(source.readImageChunk).mock.calls.map(([request]) => request)).toEqual([
      { index: 0, offset: 0 },
      { index: 0, offset: BOT_IMAGE_CHUNK_CHARS },
    ]);
    const command = runCommandFromSpec("run_photo", spec, images);
    expect(command).toMatchObject({ kind: "bot.run", runId: "run_photo", turn: { kind: "prompt", images: [{ mimeType: "image/png" }] } });
    expect(command.turn).not.toHaveProperty("imageCount");
  });

  it("fails an image whose chunks disagree or never finish", async () => {
    let call = 0;
    const flipping = broker(() => ({ mimeType: call++ === 0 ? "image/png" : "image/jpeg", totalChars: 8, data: "AAAA" }));
    await expect(loadRunImages(flipping, 1)).rejects.toThrow("invalid");
    const endless = broker(() => ({ mimeType: "image/png", totalChars: 2_000_000, data: "AAAA" }));
    await expect(loadRunImages(endless, 1)).rejects.toThrow("invalid");
    const overlong = broker(() => ({ mimeType: "image/png", totalChars: 4, data: "AAAAAAAA" }));
    await expect(loadRunImages(overlong, 1)).rejects.toThrow("invalid");
  });

  it("returns a failed outcome without a revision when the run cannot be loaded", async () => {
    const down = broker(() => { throw new Error("unused"); }, { loadRun: vi.fn(async () => { throw new BotBrokerError("stale_generation"); }) });
    const bot = createBotWorker({ brokerFor: () => down, bridgeOrigin: "http://127.0.0.1:41000" });
    await expect(bot.handle({ version: 1, kind: "bot.run", runId: "run_one" }))
      .resolves.toEqual({ runId: "run_one", status: "failed", failureCode: "stale_generation", toolActions: 0 });

    const badImage = broker(() => ({ mimeType: "image/png", totalChars: 4, data: "AAAAAAAA" }));
    const bot2 = createBotWorker({ brokerFor: () => badImage, bridgeOrigin: "http://127.0.0.1:41000" });
    await expect(bot2.handle({ version: 1, kind: "bot.run", runId: "run_two" }))
      .resolves.toEqual({ runId: "run_two", status: "failed", failureCode: "invalid_arguments", toolActions: 0 });
    expect(badImage.loadSession).not.toHaveBeenCalled();
  });

  it("maps worker refusals onto the scope runtime's allowlisted command errors", async () => {
    let release!: () => void;
    const slow = broker(() => { throw new Error("unused"); }, {
      loadRun: vi.fn(() => new Promise<BotRunSpec>((resolve) => { release = () => resolve(spec); })),
    });
    const handler = createBotCommandHandler(
      { runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "7", brokerSocket: "/unused", bridgeOrigin: "http://127.0.0.1:41000" },
      () => slow,
    );
    const pending = handler.handle({ version: 1, kind: "bot.run", runId: "run_one" });
    await expect(handler.handle({ version: 1, kind: "bot.run", runId: "run_two" })).rejects.toEqual(new ScopeRuntimeBotCommandError("busy"));
    await expect(handler.handle({ version: 1, kind: "bot.cancel", runId: "run_one" })).resolves.toEqual({ acknowledged: true });
    release();
    await expect(pending).resolves.toMatchObject({ runId: "run_one" });
  });
});
