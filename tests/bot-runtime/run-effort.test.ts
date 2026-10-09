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
/** A reply that thinks, signs its thinking and calls a brain tool. */
const THINKING_TOOL_STREAM = [
  ["message_start", { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Search the brain first." } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_think_1" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "brain_search", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":\"bot chats\"}" } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const OPENAI_STREAM = [
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

let server: Server;
let origin: string;
const bodies: Array<Record<string, unknown>> = [];
/** Scripted replies, served in order before the default one. */
const replies: string[] = [];

beforeEach(async () => {
  bodies.length = 0;
  replies.length = 0;
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(replies.shift() ?? (request.url?.includes("/chat/completions") ? OPENAI_STREAM : ANTHROPIC_STREAM));
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

async function turn(route: BotModelRoute, effort?: "low" | "medium" | "high", client = broker(), text = "What changed?") {
  const command: BotRunCommand = {
    version: 1, kind: "bot.run", runId: "run_effort1", route, systemPrompt: "You are Company Brain.", capabilities: ["brain.read"],
    limits: { maxToolActions: 6, ...(effort ? { effort } : {}) }, turn: { kind: "prompt", text },
  };
  return runBotTurn({ command, broker: client, bridgeOrigin: origin, now: () => 1_000 });
}

/** The assistant turns of a request body, as the relay receives them. */
function assistantTurns(body: Record<string, unknown> | undefined): unknown[][] {
  return ((body?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role === "assistant").map((message) => message.content as unknown[]);
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

  it("replays signed thinking with its tool call, in the tool result request and in a resumed turn", async () => {
    const thinking = { type: "thinking", thinking: "Search the brain first.", signature: "sig_think_1" };
    const toolUse = { type: "tool_use", id: "toolu_01", name: "brain_search", input: { query: "bot chats" } };
    let saved: Array<Record<string, unknown>> = [];
    const client = broker();
    vi.mocked(client.tool).mockResolvedValue({ ok: true, content: [{ type: "text", text: "1. PR #12 - Bot chats" }] });
    vi.mocked(client.saveSession).mockImplementation(async (session) => { saved = session.messages; return { revision: 2 }; });
    replies.push(THINKING_TOOL_STREAM);

    await expect(turn(ANTHROPIC, "low", client)).resolves.toMatchObject({ status: "completed", toolActions: 1 });
    expect(bodies).toHaveLength(2);
    expect(assistantTurns(bodies[1])).toEqual([[thinking, toolUse]]);
    expect(bodies[1]!.messages).toContainEqual({ role: "user", content: [expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_01" })] });
    const parsed = FundedRequestSchema.safeParse(bodies[1]);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([]);

    bodies.length = 0;
    const resumed = broker();
    vi.mocked(resumed.loadSession).mockResolvedValue({ revision: 2, needsRecompaction: false, messages: saved });
    await expect(turn(ANTHROPIC, "low", resumed, "And since then?")).resolves.toMatchObject({ status: "completed" });
    expect(bodies).toHaveLength(1);
    expect(assistantTurns(bodies[0])).toEqual([[thinking, toolUse], [{ type: "text", text: "Done." }]]);
    expect(FundedRequestSchema.safeParse(bodies[0]).success).toBe(true);
  });

  it("sends no thinking field for a call without a level, such as the summary", async () => {
    const { provider, model } = createBridgeModel(ANTHROPIC, origin, undefined, "low");
    const context = normalizeContext({ systemPrompt: "Summarize.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
    await provider.streamSimple(model, context, { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 1_024 }).result();
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("output_config");
  });
});
