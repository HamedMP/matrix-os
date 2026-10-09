import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotModelRoute, BotRunCommand } from "@matrix-os/contracts";
import type { BotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { runBotTurn } from "../../packages/bot-runtime/src/loop.js";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel, routeEffort, withoutThinkingDisplay } from "../../packages/bot-runtime/src/providers.js";
import { FundedRequestSchema } from "../../packages/proxy/src/funded-relay-request.js";

const ANTHROPIC_STREAM = [
  ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const OPENAI_STREAM = [
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

let server: Server;
let origin: string;
const bodies: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  bodies.length = 0;
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(request.url?.includes("/chat/completions") ? OPENAI_STREAM : ANTHROPIC_STREAM);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

const ANTHROPIC: BotModelRoute = { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4_096 };
const GLM: BotModelRoute = { api: "openai-completions", modelId: "@cf/zai-org/glm-5.3-flash", input: ["text"], contextWindow: 128_000, maxOutputTokens: 4_096 };

function broker(): BotBrokerClient {
  return {
    loadSession: vi.fn(async () => ({ revision: 1, needsRecompaction: false, messages: [] })),
    saveSession: vi.fn(async () => ({ revision: 2 })),
    tool: vi.fn(),
    event: vi.fn(async () => undefined),
  };
}

async function turn(route: BotModelRoute, effort?: "low" | "medium" | "high") {
  const command: BotRunCommand = {
    version: 1, kind: "bot.run", runId: "run_effort1", route, systemPrompt: "You are Company Brain.", capabilities: ["brain.read"],
    limits: { maxToolActions: 6, ...(effort ? { effort } : {}) }, turn: { kind: "prompt", text: "What changed?" },
  };
  return runBotTurn({ command, broker: broker(), bridgeOrigin: origin, now: () => 1_000 });
}

describe("bot run effort", () => {
  it("asks an Anthropic route for adaptive thinking at the run's effort and never disables thinking", async () => {
    await expect(turn(ANTHROPIC, "low")).resolves.toMatchObject({ status: "completed" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.thinking).toEqual({ type: "adaptive" });
    expect(bodies[0]!.output_config).toEqual({ effort: "low" });
    expect(JSON.stringify(bodies)).not.toContain("disabled");
  });

  it("sends a body the Matrix-funded relay accepts, tools included", async () => {
    await expect(turn(ANTHROPIC, "low")).resolves.toMatchObject({ status: "completed" });
    expect(bodies[0]!.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "brain_search" })]));
    const parsed = FundedRequestSchema.safeParse(bodies[0]);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([]);
  });

  it("drops only the thinking display, after the caller's own payload hook", async () => {
    expect(withoutThinkingDisplay({ model: "m", thinking: { type: "adaptive", display: "summarized" } }))
      .toEqual({ model: "m", thinking: { type: "adaptive" } });
    for (const payload of [{ model: "m" }, { thinking: { type: "adaptive" } }, null, "x", []]) {
      expect(withoutThinkingDisplay(payload)).toBeUndefined();
    }
    const { provider, model } = createBridgeModel(ANTHROPIC, origin, undefined, "low");
    const context = normalizeContext({ systemPrompt: "Answer.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
    const onPayload = vi.fn((payload: unknown) => ({ ...(payload as Record<string, unknown>), metadata: { user_id: "user_hook" } }));
    await provider.streamSimple(model, context, { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 1_024, reasoning: "low", onPayload }).result();
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({ thinking: { type: "adaptive" }, metadata: { user_id: "user_hook" } });
    expect(bodies[0]!.thinking).toEqual({ type: "adaptive" });
  });

  it("leaves the request unchanged without an effort", async () => {
    await expect(turn(ANTHROPIC)).resolves.toMatchObject({ status: "completed" });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("output_config");
  });

  it("is ignored on other routes", async () => {
    await expect(turn(GLM, "low")).resolves.toMatchObject({ status: "completed" });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });

  it("is ignored on Anthropic models that cannot think adaptively, and on unknown ones", async () => {
    for (const modelId of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-unknown-9"]) {
      bodies.length = 0;
      await expect(turn({ ...ANTHROPIC, modelId }, "low")).resolves.toMatchObject({ status: "completed" });
      expect(bodies[0]).not.toHaveProperty("thinking");
      expect(bodies[0]).not.toHaveProperty("output_config");
    }
    expect(routeEffort({ ...ANTHROPIC, modelId: "constructor" }, "low")).toBeUndefined();
    expect(routeEffort({ ...ANTHROPIC, modelId: "claude-opus-5" }, "low")).toBe("low");
  });

  it("sends no thinking field for a call without a level, such as the summary", async () => {
    const { provider, model } = createBridgeModel(ANTHROPIC, origin, undefined, "low");
    const context = normalizeContext({ systemPrompt: "Summarize.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
    await provider.streamSimple(model, context, { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 1_024 }).result();
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("output_config");
  });
});
