import { createServer, type RequestListener } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBridgeModel, BROKER_PLACEHOLDER_KEY } from "../../packages/bot-runtime/src/providers.js";
import { createBotBridgeFetch } from "../../packages/bot-runtime/src/bridge-fetch.js";
import { MAX_BRIDGE_REQUEST_BYTES, MAX_BRIDGE_RESPONSE_BYTES, inferenceActionForPath, startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { ScopeRuntimeBotInferenceRequestSchema } from "@matrix-os/scope-runtime/broker-protocol";
import { FUNDED_GLM_FLASH } from "../../packages/proxy/src/funded-relay-model.js";
import { serializeFundedOpenAiRequest } from "../../packages/proxy/src/funded-relay-openai-request.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("Pi inference without TCP access", () => {
  it.each(["text", "tool"] as const)("completes installed GLM %s SSE through Unix bridge, EOF broker and funded serializer", async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "glm-unix-"));
    const brokerSocket = join(dir, "broker.sock");
    const socketPath = join(dir, "inference.sock");
    const frames: unknown[] = [];
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
      id: "chatcmpl_unix_qa", object: "chat.completion.chunk", created: 1, model: FUNDED_GLM_FLASH,
      choices: [{ index: 0, delta, finish_reason }],
    });
    const events = mode === "text"
      ? [chunk({ role: "assistant" }), chunk({ content: "GLM_UNIX_PASS" }), chunk({}, "stop")]
      : [chunk({ role: "assistant" }), chunk({ tool_calls: [{ index: 0, id: "call_read_qa", type: "function",
        function: { name: "read_artifact", arguments: '{"path":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"proof.txt"}' } }] }), chunk({}, "tool_calls")];
    const sse = [...events, { id: "chatcmpl_unix_qa", object: "chat.completion.chunk", created: 1,
      model: FUNDED_GLM_FLASH, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    const broker = createScopeRuntimeBrokerServer({ socketPath: brokerSocket,
      broker: { handle: async () => { throw new Error("GLM must use the registered bot inference route"); }, close: async () => undefined },
      routeFrame: async (raw) => {
        const frame = ScopeRuntimeBotInferenceRequestSchema.parse(raw);
        frames.push(frame);
        expect(frame).toMatchObject({ action: "inference.chat_completions", method: "POST",
          path: "/v1/chat/completions", runtimeHandle: `runtime_${"b".repeat(32)}`, executionGeneration: "3" });
        expect(frame.headers).toEqual({});
        expect(Buffer.byteLength(frame.body)).toBeLessThanOrEqual(MAX_BRIDGE_REQUEST_BYTES);
        const body = JSON.parse(frame.body);
        expect(body).toMatchObject({ model: FUNDED_GLM_FLASH, stream: true,
          max_completion_tokens: 8192, store: false, stream_options: { include_usage: true } });
        // The pinned Pi SDK marks this bridge non-reasoning and omits effort.
        // The managed GLM adapter must not let that omission select provider max.
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(body.messages[0]).toEqual({ role: "system", content: "Unix QA" });
        const serialized = serializeFundedOpenAiRequest(body);
        const upstream = JSON.parse(serialized.body);
        expect(upstream).toMatchObject({ model: FUNDED_GLM_FLASH, stream: true,
          max_tokens: 8192, reasoning_effort: "low", store: false, stream_options: { include_usage: true },
          messages: expect.arrayContaining([{ role: "user", content: "GLM_UNIX_QA" }]) });
        expect(upstream).not.toHaveProperty("max_completion_tokens");
        const { max_completion_tokens: outputLimit, ...sdkFields } = body;
        expect(upstream).toEqual({ ...sdkFields, max_tokens: outputLimit, reasoning_effort: "low" });
        if (mode === "tool") {
          expect(upstream.tool_choice).toBe("auto");
          expect(upstream.tools).toEqual(body.tools);
          expect(upstream.tools).toMatchObject([{
            type: "function", function: { name: "read_artifact", description: "Read an authorized QA artifact",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          }]);
        }
        expect(Buffer.byteLength(sse)).toBeLessThan(MAX_BRIDGE_RESPONSE_BYTES);
        return { version: 1, requestId: frame.requestId, ok: true, status: 200,
          headers: { "content-type": "text/event-stream" }, body: sse };
      },
    });
    cleanup.push(async () => { await broker.close(); await rm(dir, { recursive: true, force: true }); });
    await broker.start();
    const bridge = await startInferenceBridge({ brokerSocket, socketPath, runtimeHandle: `runtime_${"b".repeat(32)}`,
      executionGeneration: "3", actionFor: (req) => inferenceActionForPath(req.url) });
    cleanup.unshift(() => bridge.close());
    expect(bridge.port).toBe(0);
    expect(bridge.server.address()).toBe(socketPath);
    const route = createBridgeModel({ api: "openai-completions", modelId: FUNDED_GLM_FLASH,
      input: ["text"], contextWindow: 128_000, maxOutputTokens: 8192 }, "http://127.0.0.1:1", socketPath);
    const result = await route.provider.streamSimple(route.model, normalizeContext({ systemPrompt: "Unix QA",
      messages: [{ role: "user", content: "GLM_UNIX_QA", timestamp: 1 }],
      ...(mode === "tool" ? { tools: [{ name: "read_artifact", description: "Read an authorized QA artifact",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] } : {}),
    }), { apiKey: BROKER_PLACEHOLDER_KEY, reasoning: "off", ...(mode === "tool" ? { toolChoice: "auto" as const } : {}),
      maxTokens: 8192, maxRetries: 0, signal: AbortSignal.timeout(5000) }).result();
    expect(frames).toHaveLength(1);
    expect(result.usage).toMatchObject({ input: 7, output: 3 });
    expect(result.stopReason).toBe(mode === "text" ? "stop" : "toolUse");
    expect(result.content).toContainEqual(mode === "text" ? { type: "text", text: "GLM_UNIX_PASS" }
      : expect.objectContaining({ type: "toolCall", id: "call_read_qa", name: "read_artifact", arguments: { path: "proof.txt" } }));
  });

  it("routes the installed SDK through its private Unix HTTP socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-unix-"));
    const socketPath = join(dir, "inference.sock");
    let received = "";
    const server = createServer(async (req, res) => {
      expect(req.url).toBe("/v1/responses");
      for await (const chunk of req) received += chunk;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "QA request captured" } }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
    const route = createBridgeModel({ api: "openai-responses", modelId: "gpt-5.6-luna", input: ["text"], contextWindow: 128_000, maxOutputTokens: 8192 }, "http://127.0.0.1:1", socketPath);
    await route.provider.streamSimple(route.model, normalizeContext({ systemPrompt: "QA", messages: [{ role: "user", content: "UNIXQA", timestamp: Date.now() }] }), { apiKey: BROKER_PLACEHOLDER_KEY, maxRetries: 0 }).result();
    expect(JSON.parse(received)).toMatchObject({ model: "gpt-5.6-luna", stream: true });
    expect(received).toContain("UNIXQA");
  });
});


describe("bounded private Unix fetch", () => {
  async function listener(handle: RequestListener) {
    const dir = await mkdtemp(join(tmpdir(), "pi-fetch-"));
    const path = join(dir, "http.sock");
    const server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
    return createBotBridgeFetch(path);
  }

  it("rejects external destinations and oversized bodies before connecting", async () => {
    const fetch = createBotBridgeFetch("/does-not-exist");
    await expect(fetch("https://example.com/v1/responses")).rejects.toThrow("private bridge");
    await expect(fetch("http://127.0.0.1/v1/responses", { method: "POST", body: "x".repeat(MAX_BRIDGE_REQUEST_BYTES + 1) })).rejects.toThrow("request exceeds capacity");
  });

  it("streams response bytes and caps them", async () => {
    const fetch = await listener((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("x".repeat(MAX_BRIDGE_RESPONSE_BYTES + 1)); });
    const response = await fetch("http://127.0.0.1/v1/responses", { method: "POST", body: "{}" });
    await expect(response.text()).rejects.toThrow("response exceeds capacity");
  });

  it("aborts a request waiting for headers", async () => {
    const fetch = await listener(() => undefined);
    await expect(fetch("http://127.0.0.1/v1/responses", { signal: AbortSignal.timeout(25) })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("composes the Unix bridge with the real EOF-framed broker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bridge-"));
    const brokerSocket = join(dir, "broker.sock");
    let action: unknown;
    const item = { id: "msg_qa", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "COMPOSEDPASS", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_qa" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "COMPOSEDPASS" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_qa", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    const broker = createScopeRuntimeBrokerServer({ socketPath: brokerSocket,
      broker: { handle: async () => { throw new Error("wrong broker route"); }, close: async () => undefined },
      routeFrame: async (raw) => {
        const frame = raw as { requestId: string; action: string; body: string };
        action = frame.action;
        expect(JSON.parse(frame.body)).toMatchObject({ model: "gpt-5.6-luna" });
        return { version: 1, requestId: frame.requestId, ok: true, status: 200,
          headers: { "content-type": "text/event-stream" }, body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") };
      },
    });
    await broker.start();
    const socketPath = join(dir, "inference.sock");
    const bridge = await startInferenceBridge({ brokerSocket, socketPath, runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "7", actionFor: (req) => req.url === "/v1/responses" ? "inference.responses" : undefined });
    cleanup.push(async () => { await bridge.close(); await broker.close(); await rm(dir, { recursive: true, force: true }); });
    const route = createBridgeModel({ api: "openai-responses", modelId: "gpt-5.6-luna", input: ["text"], contextWindow: 128_000, maxOutputTokens: 8192 }, "http://127.0.0.1", socketPath);
    const result = await route.provider.streamSimple(route.model, normalizeContext({ messages: [{ role: "user", content: "QA", timestamp: Date.now() }] }), { apiKey: BROKER_PLACEHOLDER_KEY, maxRetries: 0 }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "COMPOSEDPASS" }));
    expect(action).toBe("inference.responses");
  });
});
