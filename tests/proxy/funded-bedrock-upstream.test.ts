import type {
  ConverseStreamCommandOutput,
  ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  BedrockUpstreamError,
  createBedrockFundedUpstream,
  translateOpenAiToBedrock,
} from "../../packages/proxy/src/funded-bedrock-upstream.js";
import {
  estimateBedrockWorstCaseMicrousd,
  isBedrockPricingCurrent,
  priceBedrockUsageMicrousd,
  resolveBedrockRouteConfig,
} from "../../packages/proxy/src/funded-bedrock-route.js";
import { serializeFundedOpenAiRequest } from "../../packages/proxy/src/funded-relay-openai-request.js";
import { createFundedOpenAiUsageTracker } from "../../packages/proxy/src/funded-relay-openai-usage.js";
import { resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay-config.js";

const NOW = new Date("2026-10-13T10:00:00.000Z");
const ROUTE_JSON = JSON.stringify({
  routeId: "bedrock-eu-primary",
  region: "eu-west-1",
  clientModelId: "matrix-bedrock-qualified",
  canonicalModelId: "bedrock/qualified-model",
  resolvedModel: "qualified-model",
  inferenceProfile: "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/qualified-model",
  maxInputTokens: 200_000,
  maxOutputTokens: 8_192,
  pricing: {
    version: "aws-bedrock-qualified-2026-10-13",
    reviewedAt: "2026-10-13T09:00:00.000Z",
    validThrough: "2026-10-20T23:59:59.999Z",
    inputRateHundredths: 100,
    outputRateHundredths: 500,
    cacheReadRateHundredths: 10,
    cacheWrite5mRateHundredths: 125,
    cacheWrite1hRateHundredths: 200,
  },
});

function route() {
  const parsed = resolveBedrockRouteConfig({ MATRIX_FUNDED_BEDROCK_ROUTE: ROUTE_JSON });
  expect(parsed).not.toBeNull();
  return parsed!;
}

function request() {
  return serializeFundedOpenAiRequest({
    model: "matrix-bedrock-qualified",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Read the weather." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tool_1",
          type: "function",
          function: { name: "weather", arguments: '{"city":"Rome"}' },
        }],
      },
      { role: "tool", tool_call_id: "tool_1", content: '{"temperature":21}' },
    ],
    tools: [{
      type: "function",
      function: {
        name: "weather",
        description: "Read weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    }],
    tool_choice: { type: "function", function: { name: "weather" } },
    max_tokens: 512,
    temperature: 0.2,
    top_p: 0.9,
    stop: ["done"],
    stream: true,
  }, new Set(["matrix-bedrock-qualified"])).request;
}

async function* stream(events: ConverseStreamOutput[]): AsyncIterable<ConverseStreamOutput> {
  for (const event of events) yield event;
}

function output(events: ConverseStreamOutput[], requestId = "aws-request-1"): ConverseStreamCommandOutput {
  return { $metadata: { requestId }, stream: stream(events) };
}

describe("AWS Bedrock funded upstream", () => {
  it("fails closed on stale pricing and prices bounded exact usage with integer arithmetic", () => {
    expect(isBedrockPricingCurrent(route(), NOW)).toBe(true);
    expect(isBedrockPricingCurrent(route(), new Date("2026-10-21T00:00:00.000Z"))).toBe(false);
    expect(estimateBedrockWorstCaseMicrousd({ route: route(), inputTokens: 100, maxOutputTokens: 20, now: NOW }))
      .toEqual({ amountMicrousd: 360, pricingVersion: "aws-bedrock-qualified-2026-10-13",
        pricingValidThrough: "2026-10-20T23:59:59.999Z" });
    expect(priceBedrockUsageMicrousd({ route: route(), pricingVersion: "aws-bedrock-qualified-2026-10-13",
      usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 10,
        cacheWrite5mTokens: 5, cacheWrite1hTokens: 5 } })).toBe(198);
    expect(() => priceBedrockUsageMicrousd({ route: route(), pricingVersion: "other",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 } })).toThrow(/pricing/i);
  });

  it("settles streamed cache usage with the route-bound Bedrock price", () => {
    const tracker = createFundedOpenAiUsageTracker({
      contentType: "text/event-stream",
      nativeModelId: route().clientModelId,
      canonicalModelId: route().canonicalModelId,
      pricingVersion: route().pricing.version,
      priceUsage: (usage) => priceBedrockUsageMicrousd({
        route: route(), pricingVersion: route().pricing.version, usage,
      }),
    });
    tracker.push(new TextEncoder().encode([
      'data: {"id":"response_1","model":"matrix-bedrock-qualified","choices":[{"index":0,"finish_reason":"stop"}]}',
      'data: {"id":"response_1","model":"matrix-bedrock-qualified","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":10,"cache_write_5m_tokens":5,"cache_write_1h_tokens":5}}}',
      "data: [DONE]", "",
    ].join("\n\n")));
    expect(tracker.complete()).toEqual({ mode: "exact", actualCostMicrousd: 198 });
  });

  it("fails closed on malformed, credential-bearing, and stale route configuration", () => {
    expect(resolveBedrockRouteConfig({})).toBeNull();
    expect(() => resolveBedrockRouteConfig({ MATRIX_FUNDED_BEDROCK_ROUTE: "{" })).toThrow(/configuration/i);
    const value = JSON.parse(ROUTE_JSON) as Record<string, unknown>;
    expect(() => resolveBedrockRouteConfig({
      MATRIX_FUNDED_BEDROCK_ROUTE: JSON.stringify({ ...value, accessKeyId: "secret" }),
    })).toThrow(/configuration/i);
    expect(() => resolveBedrockRouteConfig({
      MATRIX_FUNDED_BEDROCK_ROUTE: JSON.stringify({ ...value, endpoint: "http://127.0.0.1" }),
    })).toThrow(/configuration/i);
    expect(() => resolveBedrockRouteConfig({
      MATRIX_FUNDED_BEDROCK_ROUTE: JSON.stringify({ ...value, canonicalModelId: "a".repeat(161) }),
    })).toThrow(/configuration/i);
    expect(() => resolveBedrockRouteConfig({
      MATRIX_FUNDED_BEDROCK_ROUTE: JSON.stringify({ ...value, canonicalModelId: "provider//model" }),
    })).toThrow(/configuration/i);
    expect(route().pricing.validThrough).toBe("2026-10-20T23:59:59.999Z");
  });

  it("loads the optional route into funded relay configuration without provider credentials", () => {
    const config = resolveFundedRelayConfig({
      MATRIX_FUNDED_AI_ENABLED: "true",
      MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
      MATRIX_FUNDED_BEDROCK_ROUTE: ROUTE_JSON,
      CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "cloudflare-gateway-token-123456789012345",
      PLATFORM_INTERNAL_URL: "https://platform.example.com",
      AI_RELAY_CONTROL_TOKEN: "relay-control-token-1234567890123456789",
      AI_RELAY_METADATA_SECRET: "metadata-secret-12345678901234567890123",
    });
    expect(config?.bedrockRoute).toEqual(route());
  });

  it("translates OpenAI messages, tools, and bounds into Converse input", () => {
    expect(translateOpenAiToBedrock(request(), route())).toEqual({
      modelId: "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/qualified-model",
      system: [{ text: "Be concise." }],
      messages: [
        { role: "user", content: [{ text: "Read the weather." }] },
        { role: "assistant", content: [{ toolUse: {
          toolUseId: "tool_1", name: "weather", input: { city: "Rome" },
        } }] },
        { role: "user", content: [{ toolResult: {
          toolUseId: "tool_1", content: [{ text: '{"temperature":21}' }],
        } }] },
      ],
      inferenceConfig: {
        maxTokens: 512,
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ["done"],
      },
      toolConfig: {
        tools: [{ toolSpec: {
          name: "weather",
          description: "Read weather",
          inputSchema: { json: { type: "object", properties: { city: { type: "string" } } } },
        } }],
        toolChoice: { tool: { name: "weather" } },
      },
    });
  });

  it("rejects non-streaming requests instead of returning an unexpected SSE shape", () => {
    expect(() => translateOpenAiToBedrock({ ...request(), stream: false }, route()))
      .toThrow(/streaming/i);
  });

  it("translates text, tool calls, stop reason, and exact token metadata to bounded OpenAI SSE", async () => {
    const client = {
      send: vi.fn(async () => output([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
        { contentBlockStart: { contentBlockIndex: 1, start: {
          toolUse: { toolUseId: "tool_2", name: "weather" },
        } } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city"' } } } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: ':"Rome"}' } } } },
        { contentBlockStop: { contentBlockIndex: 1 } },
        { messageStop: { stopReason: "tool_use" } },
        { metadata: { metrics: { latencyMs: 12 }, usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 10,
          cacheWriteInputTokens: 5,
          cacheDetails: [{ ttl: "5m", inputTokens: 5 }],
        } } },
      ])),
      destroy: vi.fn(),
    };
    const upstream = createBedrockFundedUpstream(route(), { client });
    const result = await upstream.dispatch({
      request: request(), requestId: "matrix-request-1", signal: AbortSignal.timeout(5_000),
    });
    expect(result.provenance).toEqual({
      upstream: "aws_bedrock",
      routeId: "bedrock-eu-primary",
      resolvedModel: "qualified-model",
      inferenceProfile: "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/qualified-model",
      region: "eu-west-1",
      pricingVersion: "aws-bedrock-qualified-2026-10-13",
      providerRequestId: "aws-request-1",
    });
    expect(result.response.headers.get("content-type")).toBe("text/event-stream");
    const body = await result.response.text();
    expect(body).toContain('"content":"Hello"');
    expect(body).toContain('"id":"tool_2"');
    expect(body).toContain('"arguments":"{\\"city\\""');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"prompt_tokens":100');
    expect(body).toContain('"completion_tokens":20');
    expect(body).toContain('"cached_tokens":10');
    expect(body).toContain('"cache_write_5m_tokens":5');
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(JSON.stringify(client.send.mock.calls[0]?.[0])).not.toContain("matrix-request-1");
    upstream.close();
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing usage", { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }],
    ["inconsistent usage", { inputTokens: 100, outputTokens: 20, totalTokens: 121 }],
  ] as const)("leaves %s conservative instead of emitting exact settlement usage", async (_label, usage) => {
    const client = {
      send: vi.fn(async () => output([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage } },
      ])),
      destroy: vi.fn(),
    };
    const tracker = createFundedOpenAiUsageTracker({
      contentType: "text/event-stream",
      nativeModelId: route().clientModelId,
      canonicalModelId: route().canonicalModelId,
      pricingVersion: route().pricing.version,
      priceUsage: (trackedUsage) => priceBedrockUsageMicrousd({
        route: route(), pricingVersion: route().pricing.version, usage: trackedUsage,
      }),
    });
    const upstream = createBedrockFundedUpstream(route(), { client });
    const result = await upstream.dispatch({
      request: request(), requestId: "matrix-request-invalid-usage", signal: AbortSignal.timeout(5_000),
    });
    const reader = result.response.body!.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      tracker.push(next.value);
    }
    expect(tracker.complete()).toEqual({ mode: "conservative" });
    upstream.close();
  });

  it.each([
    ["a truncated stream", [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
    ] satisfies ConverseStreamOutput[], undefined],
    ["the response-byte cap", [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x".repeat(512) } } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } } },
    ] satisfies ConverseStreamOutput[], 128],
  ] as const)("fails %s without producing exact usage", async (_label, events, maxResponseBytes) => {
    const client = { send: vi.fn(async () => output([...events])), destroy: vi.fn() };
    const tracker = createFundedOpenAiUsageTracker({
      contentType: "text/event-stream",
      nativeModelId: route().clientModelId,
      canonicalModelId: route().canonicalModelId,
      pricingVersion: route().pricing.version,
      priceUsage: (trackedUsage) => priceBedrockUsageMicrousd({
        route: route(), pricingVersion: route().pricing.version, usage: trackedUsage,
      }),
    });
    const upstream = createBedrockFundedUpstream(route(), { client,
      ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }) });
    const result = await upstream.dispatch({
      request: request(), requestId: "matrix-request-stream-failure", signal: AbortSignal.timeout(5_000),
    });
    const reader = result.response.body!.getReader();
    await expect((async () => {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        tracker.push(next.value);
      }
    })()).rejects.toMatchObject({ name: "BedrockUpstreamError", kind: "invalid_response" });
    expect(tracker.complete()).toEqual({ mode: "conservative" });
    upstream.close();
  });

  it("cancels the SDK stream when the downstream response is cancelled", async () => {
    let iteratorReturned = false;
    let sdkSignal: AbortSignal | undefined;
    const events: AsyncIterable<ConverseStreamOutput> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next: async () => sent
            ? new Promise<IteratorResult<ConverseStreamOutput>>(() => undefined)
            : (sent = true, { done: false, value: { messageStart: { role: "assistant" } } }),
          return: async () => {
            iteratorReturned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const client = {
      send: vi.fn(async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        sdkSignal = options?.abortSignal;
        return { $metadata: { requestId: "aws-request-2" }, stream: events };
      }),
      destroy: vi.fn(),
    };
    const upstream = createBedrockFundedUpstream(route(), { client });
    const result = await upstream.dispatch({ request: request(), requestId: "matrix-request-2", signal: new AbortController().signal });
    const reader = result.response.body!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");
    expect(iteratorReturned).toBe(true);
    expect(sdkSignal?.aborted).toBe(true);
    upstream.close();
  });

  it.each([
    ["ThrottlingException", "throttled"],
    ["ServiceUnavailableException", "unavailable"],
    ["ValidationException", "rejected"],
  ] as const)("maps %s without leaking the provider error", async (name, kind) => {
    const client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("raw provider secret and endpoint"), { name });
      }),
      destroy: vi.fn(),
    };
    const upstream = createBedrockFundedUpstream(route(), { client });
    await expect(upstream.dispatch({ request: request(), requestId: "matrix-request-3", signal: AbortSignal.timeout(5_000) }))
      .rejects.toMatchObject({ name: "BedrockUpstreamError", kind });
    try {
      await upstream.dispatch({ request: request(), requestId: "matrix-request-4", signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      expect(error).toBeInstanceOf(BedrockUpstreamError);
      expect(String(error)).not.toContain("raw provider");
      expect(String(error)).not.toContain("endpoint");
    }
    upstream.close();
  });
});
