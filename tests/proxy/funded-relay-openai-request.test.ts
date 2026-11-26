import { normalizeContext } from "@earendil-works/pi-ai";
import {
  ALIBABA_QWEN_37_PLUS_MODEL_ID,
  ALIBABA_QWEN_37_PLUS_PRICE,
  FUNDED_CLOUDFLARE_PREVIEW_COHORT_MODEL_IDS,
  GOOGLE_GEMINI_38_FLASH_MODEL_ID,
  GOOGLE_GEMINI_38_FLASH_PRICE,
  isManagedWorkersAiModel,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel } from "../../packages/bot-runtime/src/providers.js";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { createFundedRelayService, requireFundedRelayServiceConfig } from "../../packages/proxy/src/funded-main-app.js";
import { FUNDED_PRICING_VERSIONS } from "../../packages/proxy/src/funded-pricing-review.js";
import { FUNDED_GLM_FLASH } from "../../packages/proxy/src/funded-relay-model.js";
import { serializeFundedOpenAiRequest } from "../../packages/proxy/src/funded-relay-openai-request.js";
import { normalizeFundedGeminiResponse, normalizeFundedOpenAiResponse } from "../../packages/proxy/src/funded-relay-openai-response.js";
import { createFundedOpenAiUsageTracker } from "../../packages/proxy/src/funded-relay-openai-usage.js";
import type { FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";
import { probeFundedModel } from "../../packages/proxy/src/funded-relay-readiness.js";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";

const base = { model: FUNDED_GLM_FLASH, messages: [{ role: "user", content: "Discover a read-only tool" }] };

describe("managed GLM reasoning contract", () => {
  it.each([true, false, undefined])("defaults omitted reasoning to low (stream=%s)", (stream) => {
    const serialized = serializeFundedOpenAiRequest({ ...base, ...(stream === undefined ? {} : { stream }) });
    expect(serialized.request).toMatchObject({ reasoning_effort: "low", max_tokens: 8192 });
    expect(JSON.parse(serialized.body)).toMatchObject({ reasoning_effort: "low", max_tokens: 8192, store: false });
  });

  it.each(["low", "high", "max"])("preserves deliberate %s reasoning", (reasoning_effort) => {
    const serialized = serializeFundedOpenAiRequest({ ...base, reasoning_effort });
    expect(serialized.request.reasoning_effort).toBe(reasoning_effort);
    expect(JSON.parse(serialized.body).reasoning_effort).toBe(reasoning_effort);
  });

  it.each(["medium", "none", "minimal", "xhigh", "", null, 0, false, {}, ["low"]])("rejects unsupported %j reasoning instead of provider fallback", (reasoning_effort) => {
    expect(() => serializeFundedOpenAiRequest({ ...base, reasoning_effort })).toThrow();
  });

  it.each(["max_tokens", "max_completion_tokens"])("preserves the %s bound and every accepted tool/stream field", (bound) => {
    const input = { ...base, messages: [
      { role: "system", content: "Read-only integration QA" },
      ...base.messages,
      { role: "assistant", content: null, reasoning_content: "Choose inventory", tool_calls: [{
        id: "call_inventory", type: "function", function: { name: "integration_inventory", arguments: '{"service":"gmail"}' },
      }] },
      { role: "tool", tool_call_id: "call_inventory", content: '{"actions":["get_profile"]}' },
    ], [bound]: 512, stream: true, stream_options: { include_usage: false },
      tools: [{ type: "function", function: { name: "integration_inventory", description: "Discover read-only actions",
        parameters: { type: "object", properties: { service: { type: "string" } }, required: ["service"], additionalProperties: false } } }],
      tool_choice: "auto", parallel_tool_calls: false, temperature: 0.2, top_p: 0.9,
    };
    const original = structuredClone(input);
    const serialized = serializeFundedOpenAiRequest(input);
    const { [bound]: outputLimit, ...rest } = input;
    expect(JSON.parse(serialized.body)).toEqual({ ...rest, max_tokens: outputLimit, reasoning_effort: "low",
      stream_options: { include_usage: true }, store: false });
    expect(input).toEqual(original);
  });
});

describe("Gemini 3.8 Flash funded request", () => {
  it("bounds the exact Gemini model and requests final usage on a streamed preview chat", () => {
    const result = serializeFundedOpenAiRequest({
      model: "google/gemini-3.8-flash", messages: base.messages, stream: true, max_tokens: 256,
    });
    expect(result.request.max_tokens).toBe(256);
    expect(JSON.parse(result.body)).toMatchObject({
      model: "google/gemini-3.8-flash", max_completion_tokens: 256, stream_options: { include_usage: true },
    });
    expect(JSON.parse(result.body)).not.toHaveProperty("store");
  });
});

describe("Kimi K3.1 Pro Cloudflare Preview", () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  const platformToken = "c".repeat(32);
  const model = "moonshotai/kimi-k3.1-pro";
  const nativeModel = "kimi-k3.1-pro";
  const verifiedOutputLimit = 2048;
  const version = "cloudflare-2026-11-26-kimi-k3.1-pro";
  const request = { model, stream: true, max_tokens: 256, messages: [{ role: "user", content: "Read the preview fixture." }] };
  const reasoning = "The preview fixture tool must be used.";
  const toolCall = { id: "kimi-tool-123", type: "function",
    function: { name: "preview_fixture", arguments: '{"filename":"proof.txt"}' } };
  const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 15 },
    completion_tokens_details: { reasoning_tokens: 12 } };
  const now = new Date("2026-11-26T10:01:00.000Z");

  function event(delta: object, finish_reason?: string) {
    return { id: "kimi-completion", model: nativeModel, object: "chat.completion.chunk",
      choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }] };
  }

  function stream(frames: unknown[]) {
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  }

  const relayEnv = {
    MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
    CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/unmodified-worker-gateway/anthropic`,
    CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), PLATFORM_INTERNAL_URL: "https://platform.example.test",
    AI_RELAY_CONTROL_TOKEN: platformToken, AI_RELAY_METADATA_SECRET: "m".repeat(32),
  };
  const config = resolveFundedRelayConfig(relayEnv)!;
  const expectedBinding = { ownerId: "preview-owner", machineId: "preview-machine", runtimeSlot: "pv-3659-01234567" };
  const previewEnv = {
    ...relayEnv,
    CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
    MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED: "true",
    MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_BINDING: JSON.stringify(expectedBinding),
    MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_GATEWAY_ID: "isolated-preview",
  };
  const previewConfig = () => requireFundedRelayServiceConfig(previewEnv);
  const pricingReview = { modelId: model, version, reviewedAt: "2026-11-26T10:00:00.000Z",
    validThrough: "2026-11-26T11:00:00.000Z", sourceDigest: "a".repeat(64), blockedAt: null };

  function expectCloudflareUrl(init: RequestInit | undefined, url: string) {
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${previewEnv.CLOUDFLARE_WORKERS_AI_TOKEN}`);
    expect(headers.get("cf-aig-gateway-id")).toBe(previewEnv.MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_GATEWAY_ID);
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.has("cf-aig-authorization")).toBe(false);
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`);
  }

  function fixture(scope: {
    ownerId?: string; machineId?: string; runtimeSlot?: string; authorizedSlot?: string; candidate?: boolean;
    providerStatus?: number;
  } = {}) {
    const identity = { tokenId: "test_credential", ownerId: scope.ownerId ?? expectedBinding.ownerId,
      machineId: scope.machineId ?? expectedBinding.machineId, runtimeSlot: scope.runtimeSlot ?? expectedBinding.runtimeSlot,
      audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-11-26T11:00:00.000Z" };
    const platform = {
      check: vi.fn(async () => ({ identity })),
      authorize: vi.fn(async (input: { modelId: string; requestId: string; maxCostMicrousd: number }) => ({
        identity: { ...identity, runtimeSlot: scope.authorizedSlot ?? identity.runtimeSlot }, reservation: { ...input, reservationId: "test_reservation", reservedMicrousd: 0,
          billingMode: "usage", billingPolicy: "postpaid" },
      })),
      start: vi.fn(async ({ executionId }: { executionId?: string }) => ({
        executionId, contractVersion: 1, status: "in_flight", startedAt: now.toISOString(),
        expiresAt: identity.expiresAt, reservationId: "test_reservation", requestId: "test_request", tokenId: identity.tokenId,
      })),
      release: vi.fn(), terminal: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})),
    };
    const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
      expectCloudflareUrl(init, String(url));
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model, reasoning_effort: "low", max_tokens: 256, stream_options: { include_usage: true } });
      expect(body).not.toHaveProperty("store");
      if (scope.providerStatus) return Response.json({}, { status: scope.providerStatus });
      const finalUsage = { id: "kimi-completion", model: nativeModel, choices: [], usage };
      if (body.messages.at(-1).role === "tool") {
        expect(body.messages.at(-2)).toMatchObject({ role: "assistant", reasoning_content: reasoning, tool_calls: [toolCall] });
        expect(body.messages.at(-1)).toMatchObject({ tool_call_id: toolCall.id, content: "fixture result" });
        return stream([event({ content: "MATRIX_KIMI_OK" }, "stop"), finalUsage]);
      }
      return stream([event({ role: "assistant", reasoning_content: reasoning }),
        event({ tool_calls: [{ index: 0, ...toolCall }] }), event({}, "tool_calls"), finalUsage]);
    });
    const healthFailure = vi.fn((_input: unknown) => new Response(null, { status: 204 }));
    const relayFetch: typeof fetch = async (input, options) => {
      const url = String(input);
      if (url.endsWith("/internal/ai/funded/pricing-reviews")) return Response.json({ contractVersion: 1, reviews: [pricingReview] });
      if (url.endsWith("/internal/ai/funded/pricing-route-failure")) return healthFailure(JSON.parse(String(options?.body)));
      return providerFetch(input, options);
    };
    const relay = createFundedRelay({ ...(scope.candidate === false ? config : previewConfig()), now: () => now,
      fetch: relayFetch, requestIdFactory: () => "test_request",
      platformClient: platform as unknown as FundedPlatformClient });
    const app = new Hono();
    relay.register(app);
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer sk-matrix-funded-${identity.tokenId}.${"s".repeat(43)}`);
      return app.request(String(url), { ...init, headers });
    };
    return { relay, fetch, platform, providerFetch, healthFailure };
  }

  describe("Kimi relay for one private Preview", () => {
    it("preserves the tool reasoning across real Pi continuation and settles cached usage exactly", async () => {
      const f = fixture();
      try {
        const bridge = createBridgeModel({ api: "openai-completions", modelId: model, input: ["text"],
          contextWindow: 1_048_576, maxOutputTokens: 256 }, "http://127.0.0.1:41000");
        const messages = [{ role: "user" as const, content: request.messages[0]!.content, timestamp: 1 }];
        const tools = [{ name: "preview_fixture", description: "Read a synthetic fixture", parameters: {
          type: "object", properties: { filename: { type: "string" } }, required: ["filename"],
        } }];
        const opts = { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 256, maxRetries: 0, fetch: f.fetch };
        const first = await bridge.provider.streamSimple(bridge.model, normalizeContext({ messages, tools }), opts).result();
        expect(first.stopReason).toBe("toolUse");
        const second = await bridge.provider.streamSimple(bridge.model, normalizeContext({ messages: [...messages, first, {
          role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.function.name, isError: false,
          content: [{ type: "text", text: "fixture result" }], timestamp: 2,
        }], tools }), opts).result();
        expect(second.stopReason).toBe("stop");
        expect(second.content).toContainEqual({ type: "text", text: "MATRIX_KIMI_OK" });
        expect(f.providerFetch).toHaveBeenCalledTimes(2);
        expect(f.platform.authorize).toHaveBeenCalledTimes(2);
        expect(f.platform.authorize.mock.calls[0]?.[0]).toMatchObject({ maxCostMicrousd: 2_519_655 });
      } finally {
        await f.relay.close();
      }
      expect(f.platform.finalize).toHaveBeenCalledTimes(2);
      for (const [settlement] of f.platform.finalize.mock.calls as unknown as [unknown][]) {
        expect(settlement).toMatchObject({ mode: "exact", actualCostMicrousd: 324 });
      }
    });

    it.each([{ ownerId: "different-owner" }, { machineId: "different-machine" }, { runtimeSlot: "pv-3659-76543210" }])(
      "blocks a nonmatching identity before admission or upstream dispatch (%j)", async (scope) => {
        const f = fixture(scope);
        try {
          const response = await f.fetch("http://127.0.0.1/v1/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
          });
          expect(response.status).toBe(403);
          expect(f.platform.authorize).not.toHaveBeenCalled();
          expect(f.providerFetch).not.toHaveBeenCalled();
        } finally {
          await f.relay.close();
        }
      });

    it("releases a reservation when authorization changes the preview identity", async () => {
      const f = fixture({ authorizedSlot: "pv-3659-76543210" });
      try {
        const response = await f.fetch("http://127.0.0.1/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
        });
        expect(response.status).toBe(503);
        expect(f.platform.release).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "test_reservation" }), expect.any(AbortSignal));
        expect(f.platform.start).not.toHaveBeenCalled();
        expect(f.providerFetch).not.toHaveBeenCalled();
      } finally {
        await f.relay.close();
      }
    });

    it("leaves the standard Relay without Kimi credentials or access", async () => {
      const f = fixture({ candidate: false });
      try {
        const response = await f.fetch("http://127.0.0.1/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
        });
        expect(response.status).toBe(503);
        expect(f.platform.check).not.toHaveBeenCalled();
        expect(f.providerFetch).not.toHaveBeenCalled();
      } finally {
        await f.relay.close();
      }
    });

    it("probes the same scoped route at the real output cap, and requires the exact returned model and reply", async () => {
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        expectCloudflareUrl(init, String(url));
        expect(JSON.parse(String(init?.body))).toMatchObject({ model, reasoning_effort: "low", max_tokens: verifiedOutputLimit });
        return Response.json({ model, choices: [{ message: { content: "OK" } }] });
      });
      expect(await probeFundedModel(config, model, upstream)).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
      expect(await probeFundedModel(previewConfig(), model, upstream)).toBe(true);
      upstream.mockResolvedValueOnce(Response.json({ model, choices: [{ message: { content: "" }, finish_reason: "length" }] }));
      expect(await probeFundedModel(previewConfig(), model, upstream)).toBe(false);
      upstream.mockResolvedValueOnce(Response.json({ model, choices: [{ message: { content: "Unexpected reply" } }] }));
      expect(await probeFundedModel(previewConfig(), model, upstream)).toBe(false);
      upstream.mockResolvedValueOnce(Response.json({ model: "moonshotai/kimi-k3", choices: [{ message: { content: "OK" } }] }));
      expect(await probeFundedModel(previewConfig(), model, upstream)).toBe(false);
    });

    it.each([model, "google/gemini-3.8-flash"])("%s completes the actual Matrix routines schema without removing any variants or annotations", (modelId) => {
      const broker = { loadSession: vi.fn(), saveSession: vi.fn(), tool: vi.fn(), event: vi.fn() };
      const tools = createBotTools({ capabilities: ["routine.cli", "artifact.read"], broker,
        state: { waitingForPerson: false, effectUnknown: false } }).map(tool => ({
        type: "function", function: { name: tool.name, description: tool.description,
          parameters: JSON.parse(JSON.stringify(tool.parameters)) },
      }));
      const matrixRoutines = tools.find(tool => tool.function.name === "matrix_routines")!;
      expect(matrixRoutines.function.parameters).not.toHaveProperty("type");
      expect(matrixRoutines.function.parameters.oneOf).toHaveLength(7);
      const serialized = JSON.parse(serializeFundedOpenAiRequest({ ...request, model: modelId, tools }).body);
      expect(serialized.tools).toEqual(tools.map(tool => tool === matrixRoutines ? {
        ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, type: "object" } },
      } : tool));
      expect(matrixRoutines.function.parameters).not.toHaveProperty("type");
    });

    it.each([[{}], [[]], [{ type: "array" }], [{ oneOf: [] }], [{ oneOf: [{ type: "object" }, { type: "string" }] }]])(
      "rejects tool parameters whose root object type cannot be preserved (%j)", parameters => {
        expect(() => serializeFundedOpenAiRequest({ ...request,
          tools: [{ type: "function", function: { name: "preview_fixture", parameters } }],
        })).toThrow("Unsupported Cloudflare Preview tool parameter schema");
      },
    );

    it("rejects an ordinary cohort model from another runtime before reservation", async () => {
      const f = fixture({ ownerId: "different-owner" });
      try {
        const response = await f.fetch("http://127.0.0.1/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...request, model: "@cf/zai-org/glm-5.3" }),
        });
        expect(response.status).toBe(403);
        expect(f.platform.authorize).not.toHaveBeenCalled();
        expect(f.providerFetch).not.toHaveBeenCalled();
      } finally {
        await f.relay.close();
      }
    });

    it.each([402, 503])("reports isolated upstream %d so the successful health result is invalidated", async providerStatus => {
      const f = fixture({ providerStatus });
      try {
        const response = await f.fetch("http://127.0.0.1/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
        });
        expect(response.status).toBe(502);
        expect(f.healthFailure).toHaveBeenCalledExactlyOnceWith({ modelId: model, version, observedAt: now.toISOString() });
        expect(f.platform.finalize).not.toHaveBeenCalled();
      } finally {
        await f.relay.close();
      }
    });

    it("rejects unsupported controls and keeps reasoning in assistant tool replay", () => {
      expect(JSON.parse(serializeFundedOpenAiRequest({ ...request, max_tokens: undefined }).body).max_tokens).toBe(verifiedOutputLimit);
      expect(() => serializeFundedOpenAiRequest({ ...request, max_tokens: verifiedOutputLimit + 1 })).toThrow();
      expect(() => serializeFundedOpenAiRequest({ ...request, reasoning_effort: "none" })).toThrow();
      expect(() => serializeFundedOpenAiRequest({ ...request, messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "https://not-allowed.invalid/file" } },
      ] }] })).toThrow();
      const assistant = { role: "assistant", reasoning_content: reasoning, tool_calls: [toolCall] };
      expect(JSON.parse(serializeFundedOpenAiRequest({ ...request, messages: [...request.messages, assistant] }).body)
        .messages[1]).toEqual(assistant);
    });
  });

  describe("durable Cloudflare Preview Relay configuration", () => {
    it("boots the normal service and probes only the approved model on the configured Cloudflare gateway", async () => {
      const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/internal/ai/funded/pricing-reviews")) {
          return Response.json({ contractVersion: 1, reviews: [pricingReview] });
        }
        expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`);
        const headers = new Headers(init?.headers);
        expect(headers.get("cf-aig-gateway-id")).toBe("isolated-preview");
        expect(headers.get("authorization")).toBe(`Bearer ${previewEnv.CLOUDFLARE_WORKERS_AI_TOKEN}`);
        expect(init?.redirect).toBe("error");
        return Response.json({ model: nativeModel, choices: [{ message: { content: "OK" } }] });
      });
      const serviceConfig = requireFundedRelayServiceConfig(previewEnv);
      expect(serviceConfig.cloudflarePreview).toMatchObject({ ...expectedBinding, accountId, gatewayId: "isolated-preview" });
      const service = createFundedRelayService(serviceConfig, { fetchFn, now: () => now });
      try {
        const path = "/ready?model=" + encodeURIComponent(model);
        expect((await service.app.request(path)).status).toBe(401);
        const outsideCohort = "/ready?model=" + encodeURIComponent("anthropic/claude-sonnet-5");
        expect((await service.app.request(outsideCohort, { headers: { authorization: "Bearer " + platformToken } })).status).toBe(400);
        expect(fetchFn).not.toHaveBeenCalled();
        expect((await service.app.request(path, { headers: { authorization: "Bearer " + platformToken } })).status).toBe(200);
        expect(fetchFn).toHaveBeenCalledTimes(2);
      } finally {
        await service.close();
      }
    });

    it.each(FUNDED_CLOUDFLARE_PREVIEW_COHORT_MODEL_IDS.filter(isManagedWorkersAiModel))(
      "probes Worker Standard directly through Cloudflare without Unified Billing for %s", async (modelId) => {
        const workerPrice = FUNDED_PRICING_VERSIONS[modelId];
        const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input);
          if (url.endsWith("/internal/ai/funded/pricing-reviews")) {
            return Response.json({ contractVersion: 1, reviews: [{ ...pricingReview, modelId, version: workerPrice }] });
          }
          expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`);
          expect(new Headers(init?.headers).has("cf-aig-gateway-id")).toBe(false);
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${previewEnv.CLOUDFLARE_WORKERS_AI_TOKEN}`);
          expect(init?.redirect).toBe("error");
          return Response.json({ model: modelId, choices: [{ message: { content: "OK" } }] });
        });
        const service = createFundedRelayService(previewConfig(), { fetchFn, now: () => now });
        try {
          const response = await service.app.request("/ready?model=" + encodeURIComponent(modelId), {
            headers: { authorization: "Bearer " + platformToken },
          });
          expect(response.status).toBe(200);
          expect(fetchFn).toHaveBeenCalledTimes(2);
        } finally {
          await service.close();
        }
      },
    );

    it.each([
      ["extra models", { MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_BINDING: JSON.stringify({ ...expectedBinding, modelIds: ["external/model"] }) }],
      ["production slot", { MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_BINDING: JSON.stringify({ ...expectedBinding, runtimeSlot: "primary" }) }],
      ["empty binding", { MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_BINDING: "" }],
      ["missing binding", { MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_BINDING: undefined }],
      ["missing gateway ID", { MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_GATEWAY_ID: undefined }],
      ["untrusted gateway URL", { MATRIX_FUNDED_AI_CLOUDFLARE_PREVIEW_GATEWAY_ID: "https://external.invalid" }],
      ["missing Workers token", { CLOUDFLARE_WORKERS_AI_TOKEN: undefined }],
      ["non-usage admission", { MATRIX_FUNDED_AI_RESERVATION_MODE: "cloudflare-count" }],
      ["no pricing registry", { MATRIX_FUNDED_AI_PRICING_REGISTRY_ENABLED: "false" }],
    ])("rejects %s before the service can start", (_name, patch) => {
      expect(() => requireFundedRelayServiceConfig({ ...previewEnv, ...patch })).toThrow(/Preview|preview/);
    });
  });
});

describe("Gemini 3.8 Flash Cloudflare Preview", () => {
  const model = GOOGLE_GEMINI_38_FLASH_MODEL_ID;
  const accountId = "0123456789abcdef0123456789abcdef";
  const cloudflarePreview = {
    accountId, gatewayId: "matrix-funded-fuse-test-1116" as const, ownerId: "test_owner",
    machineId: "test_machine", runtimeSlot: "pv-3659-01234567", token: "w".repeat(32),
  };
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  const signature = "dG9vbC1yZXBsYXktc2lnbmF0dXJl";
  const toolCall = { id: "function-call-123", type: "function",
    function: { name: "preview_fixture", arguments: '{"marker":"fixture"}' } };
  const usage = { prompt_tokens: 41, completion_tokens: 18, total_tokens: 96,
    completion_tokens_details: { reasoning_tokens: 37 } };
  const secondUsage = { prompt_tokens: 81, completion_tokens: 9, total_tokens: 90 };

  function event(delta: object, finish_reason?: string) {
    return { id: "response-123", model, object: "chat.completion.chunk",
      choices: [{ index: 0, delta, ...(finish_reason ? { finish_reason } : {}) }] };
  }

  function sse(frames: unknown[]) {
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  }

  function events(text: string) {
    return text.split("\n\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  }

  const base = { model, stream: true, max_tokens: 256 };
  const user = { role: "user", content: "Call the preview fixture tool once." };

  describe("funded Gemini Cloudflare Preview transport", () => {
    it("probes the exact Cloudflare route at the paid Preview request output bound", async () => {
      const config = resolveFundedRelayConfig({
        MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
        CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/test/anthropic",
        CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), PLATFORM_INTERNAL_URL: "https://platform.example.test",
        AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32),
      })!;
      const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(endpoint);
        const headers = new Headers(init?.headers);
        expect(headers.get("cf-aig-gateway-id")).toBe(cloudflarePreview.gatewayId);
        expect(headers.get("authorization")).toBe(`Bearer ${cloudflarePreview.token}`);
        const request = JSON.parse(String(init?.body));
        return request.reasoning_effort === "low" && request.max_completion_tokens === 2048
          ? Response.json({ model, choices: [{ message: { content: "OK" } }] })
          : Response.json({ error: "Invalid effort" }, { status: 400 });
      });
      expect(await probeFundedModel(config, model, fetchFn)).toBe(false);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(await probeFundedModel({ ...config, cloudflarePreview }, model, fetchFn)).toBe(true);
      fetchFn.mockResolvedValueOnce(Response.json({ model, choices: [{ message: { content: "" } }] }));
      expect(await probeFundedModel({ ...config, cloudflarePreview }, model, fetchFn)).toBe(false);
      fetchFn.mockResolvedValueOnce(Response.json({ model: "unrelated/model", choices: [{ message: { content: "OK" } }] }));
      expect(await probeFundedModel({ ...config, cloudflarePreview }, model, fetchFn)).toBe(false);
    });

    it("round trips the opaque replay signature while preserving the real tool ID and exact final usage", async () => {
      const frames = [event({ tool_calls: [{ index: 0, ...toolCall, extra_content: { google: { thought_signature: signature } } }] }),
        event({}, "tool_calls"), { id: "response-123", model, object: "chat.completion.chunk", choices: [], usage }];
      const received = events(await normalizeFundedGeminiResponse(sse(frames), 16_384).text());
      const delta = received[0].choices[0].delta;
      expect(delta.tool_calls).toEqual([{ index: 0, ...toolCall }]);
      expect(delta.reasoning_details).toEqual([{ type: "reasoning.encrypted", format: "google-vertex-tool-signature-v1",
        id: toolCall.id, data: signature }]);
      expect(received.at(-1)).toMatchObject({ choices: [], usage: { ...usage, completion_tokens: 55 } });
      const continuation = serializeFundedOpenAiRequest({ ...base, messages: [user,
        { role: "assistant", tool_calls: [toolCall], reasoning_details: delta.reasoning_details },
        { role: "tool", tool_call_id: toolCall.id, content: "fixture result" },
      ] });
      expect(JSON.parse(continuation.body)).toMatchObject({ model, max_completion_tokens: 256, reasoning_effort: "low",
        stream_options: { include_usage: true }, messages: [user, { role: "assistant", tool_calls: [{ ...toolCall,
          extra_content: { google: { thought_signature: signature } } }] },
        { role: "tool", tool_call_id: toolCall.id, content: "fixture result" }] });
      expect(JSON.parse(continuation.body).messages[1]).not.toHaveProperty("reasoning_details");
    });

    it("rejects a replay detail that belongs to a different tool call", () => {
      expect(() => serializeFundedOpenAiRequest({ ...base, messages: [user, { role: "assistant", tool_calls: [toolCall],
        reasoning_details: [{ type: "reasoning.encrypted", format: "google-vertex-tool-signature-v1", id: "call-other", data: signature }] }] })).toThrow();
    });

    it("rejects Gemini replay metadata on other funded models and refuses a mismatched Cloudflare response", async () => {
      expect(() => serializeFundedOpenAiRequest({ ...base, model: "@cf/zai-org/glm-5.3", messages: [user,
        { role: "assistant", tool_calls: [toolCall], reasoning_details: [{ type: "reasoning.encrypted", format: "google-vertex-tool-signature-v1",
          id: toolCall.id, data: signature }] }] })).toThrow();
      await expect(normalizeFundedGeminiResponse(sse([{ ...event({ content: "wrong provider" }), model: "wrong" }]), 16_384).text()).rejects.toThrow();
    });
  });

  function relayFixture(ownerId = "test_owner", previewEnabled = true) {
    const now = new Date("2026-11-25T13:01:00.000Z");
    const config = resolveFundedRelayConfig({
      MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
      CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/test/anthropic",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), PLATFORM_INTERNAL_URL: "https://platform.example.test",
      AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32),
      MATRIX_FUNDED_GEMINI_38_FLASH_PRICING_REVIEW_VERSION: GOOGLE_GEMINI_38_FLASH_PRICE.version,
      MATRIX_FUNDED_GEMINI_38_FLASH_PRICING_REVIEWED_AT: "2026-11-25T13:00:00.000Z",
      MATRIX_FUNDED_GEMINI_38_FLASH_PRICING_VALID_THROUGH: "2026-11-25T15:00:00.000Z",
    })!;
    const identity = { tokenId: "test_credential", ownerId, machineId: "test_machine", runtimeSlot: cloudflarePreview.runtimeSlot,
      audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-11-25T13:10:00.000Z" };
    const credential = `sk-matrix-funded-test_credential.${"s".repeat(43)}`;
    const start = vi.fn(async ({ executionId }: { executionId?: string }) => ({
      executionId, contractVersion: 1, status: "in_flight", startedAt: now.toISOString(),
      expiresAt: "2026-11-25T13:10:00.000Z", reservationId: "test_reservation", requestId: "test_request", tokenId: identity.tokenId,
    }));
    const platform = { check: vi.fn(async () => ({ identity })),
      authorize: vi.fn(async (input: { modelId: string; requestId: string; maxCostMicrousd: number }) => ({
        identity, reservation: { ...input, reservationId: "test_reservation", reservedMicrousd: 0, billingMode: "usage", billingPolicy: "postpaid" },
      })), start, release: vi.fn(), terminal: vi.fn(async () => ({})), finalize: vi.fn(async () => ({})) };
    const providerFetch = vi.fn<typeof fetch>(async (_url, request) => {
      const headers = new Headers(request?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${cloudflarePreview.token}`);
      expect(headers.get("cf-aig-gateway-id")).toBe(cloudflarePreview.gatewayId);
      expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
      expect(headers.get("cf-aig-skip-cache")).toBe("true");
      expect(headers.has("cf-aig-metadata")).toBe(false);
      expect(String(_url)).toBe(endpoint);
      const body = JSON.parse(String(request?.body));
      if (body.messages.some((message: { role: string }) => message.role === "tool")) {
        expect(body.messages.find((message: { role: string }) => message.role === "assistant").tool_calls).toEqual(
          [{ ...toolCall, extra_content: { google: { thought_signature: signature } } }]);
        return sse([event({ content: "MATRIX_GEMINI_OK" }, "stop"), { id: "response-123", model, choices: [], usage: secondUsage }]);
      }
      const first = event({ tool_calls: [{ index: 0, ...toolCall, extra_content: { google: { thought_signature: signature } } }] });
      return sse([first, event({}, "tool_calls"), { id: "response-123", model, choices: [], usage }]);
    });
    const relay = createFundedRelay({ ...config, now: () => now, fetch: providerFetch,
      requestIdFactory: () => "test_request", platformClient: platform as unknown as FundedPlatformClient,
      ...(previewEnabled ? { cloudflarePreview } : {}) });
    const app = new Hono();
    relay.register(app);
    const brokerFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credential}`);
      return app.request(String(input), { ...init, headers });
    };
    return { relay, brokerFetch, providerFetch, platform };
  }

  describe("funded Gemini usage reconciliation", () => {
    it.each([
      [96, 237], // Cloudflare adds the 37 reasoning tokens to total, outside completion_tokens.
      [59, null], // If total excludes reasoning, 37 cannot be a subset of 18.
      [97, null], // Unexplained output is not charged as exact usage.
    ])("reconciles final provider totals (%i)", async (total_tokens, actualCostMicrousd) => {
      const tracker = createFundedOpenAiUsageTracker({ contentType: "text/event-stream", nativeModelId: model,
        canonicalModelId: model, pricingVersion: GOOGLE_GEMINI_38_FLASH_PRICE.version });
      const response = sse([event({ content: "OK" }, "stop"), { id: "response-123", model, choices: [],
        usage: { ...usage, total_tokens } }]);
      tracker.push(new Uint8Array(await response.arrayBuffer()));
      expect(tracker.complete()).toEqual(actualCostMicrousd === null ? { mode: "conservative" }
        : { mode: "exact", actualCostMicrousd });
    });
  });

  describe("funded Gemini owner scope and Pi replay", () => {
    it("keeps replay through actual Pi turns and settles both responses once", async () => {
      const fixture = relayFixture();
      const bridge = createBridgeModel({ api: "openai-completions", modelId: model, input: ["text"],
        contextWindow: 128_000, maxOutputTokens: 256 }, "http://127.0.0.1:41000");
      const messages = [{ role: "user" as const, content: user.content, timestamp: 1 }];
      const tools = [{ name: "preview_fixture", description: "Return a synthetic marker", parameters: {
        type: "object", properties: { marker: { type: "string" } }, required: ["marker"],
      } }];
      const opts = { apiKey: BROKER_PLACEHOLDER_KEY, maxTokens: 256, maxRetries: 0, fetch: fixture.brokerFetch };
      try {
        const first = await bridge.provider.streamSimple(bridge.model, normalizeContext({ messages, tools }), opts).result();
        expect(first.stopReason).toBe("toolUse");
        expect(first.usage).toMatchObject({ input: 41, output: 55, totalTokens: 96, reasoning: 37 });
        expect(first.content).toContainEqual(expect.objectContaining({ id: toolCall.id, type: "toolCall" }));
        const second = await bridge.provider.streamSimple(bridge.model, normalizeContext({ messages: [...messages, first, {
          role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.function.name, isError: false,
          content: [{ type: "text", text: "fixture result" }], timestamp: 2,
        }], tools }), opts).result();
        expect(second.stopReason).toBe("stop");
        expect(second.content).toContainEqual({ type: "text", text: "MATRIX_GEMINI_OK" });
      } finally {
        await fixture.relay.close();
      }
      expect(fixture.providerFetch).toHaveBeenCalledTimes(2);
      expect(fixture.platform.finalize).toHaveBeenCalledTimes(2);
      const [firstSettlement, secondSettlement] = fixture.platform.finalize.mock.calls as unknown as [unknown][];
      expect(firstSettlement?.[0]).toMatchObject({ mode: "exact", actualCostMicrousd: 237 });
      expect(secondSettlement?.[0]).toMatchObject({ mode: "exact", actualCostMicrousd: 95 });
    });

    it("refuses a different owner before reservation or Cloudflare dispatch", async () => {
      const fixture = relayFixture("other_owner");
      try {
        const response = await fixture.brokerFetch("http://127.0.0.1/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, messages: [user] }),
        });
        expect(response.status).toBe(403);
        expect(fixture.platform.authorize).not.toHaveBeenCalled();
        expect(fixture.providerFetch).not.toHaveBeenCalled();
      } finally {
        await fixture.relay.close();
      }
    });

    it("does not fall back to an ordinary route when the Preview binding is missing", async () => {
      const fixture = relayFixture("test_owner", false);
      try {
        const response = await fixture.brokerFetch("http://127.0.0.1/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, messages: [user] }),
        });
        expect(response.status).toBe(503);
        expect(fixture.platform.check).not.toHaveBeenCalled();
        expect(fixture.providerFetch).not.toHaveBeenCalled();
      } finally {
        await fixture.relay.close();
      }
    });
  });
});

describe("Qwen 3.7 Plus Cloudflare Preview", () => {
  const model = ALIBABA_QWEN_37_PLUS_MODEL_ID;
  const accountId = "0123456789abcdef0123456789abcdef";
  const cloudflarePreview = { accountId, gatewayId: "matrix-funded-fuse-test-1116" as const,
    ownerId: "preview-owner", machineId: "preview-machine", runtimeSlot: "pv-3659-01234567", token: "w".repeat(32) };
  const request = { model, messages: [{ role: "user", content: "Reply exactly OK." }] };
  const cloudflareAlias = "qwen3.7-plus";
  const cap = 2_048;

  describe("Qwen 3.7 Plus Cloudflare Preview", () => {
    it("uses the Cloudflare completion cap, including when Pi supplies max_tokens", () => {
      const wire = JSON.parse(serializeFundedOpenAiRequest({ ...request, max_tokens: 264, stream: true, store: false }).body);
      expect(wire).toMatchObject({ max_completion_tokens: 264, stream_options: { include_usage: true } });
      expect(wire).not.toHaveProperty("max_tokens");
      expect(wire).not.toHaveProperty("store");
      expect(JSON.parse(serializeFundedOpenAiRequest(request).body)).toMatchObject({ max_completion_tokens: cap });
      expect(() => serializeFundedOpenAiRequest({ ...request, max_tokens: cap + 1 })).toThrow();
    });

    it("probes only the explicit Preview route at the same cap and checks the returned alias", async () => {
      const config = resolveFundedRelayConfig({
        MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
        CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/default/anthropic`,
        CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), PLATFORM_INTERNAL_URL: "https://platform.example.test",
        AI_RELAY_CONTROL_TOKEN: "c".repeat(32), AI_RELAY_METADATA_SECRET: "m".repeat(32),
      })!;
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`);
        expect(new Headers(init?.headers).get("cf-aig-gateway-id")).toBe(cloudflarePreview.gatewayId);
        expect(JSON.parse(String(init?.body))).toMatchObject({ model, max_completion_tokens: cap });
        return Response.json({ model: cloudflareAlias, choices: [{ message: { content: "OK" } }] });
      });
      expect(await probeFundedModel(config, model, upstream)).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
      expect(await probeFundedModel({ ...config, cloudflarePreview }, model, upstream)).toBe(true);
      upstream.mockResolvedValueOnce(Response.json({ model: "qwen3.7-max", choices: [{ message: { content: "OK" } }] }));
      expect(await probeFundedModel({ ...config, cloudflarePreview }, model, upstream)).toBe(false);
    });

    it("keeps included reasoning tokens and the cached-input discount in exact settlement", async () => {
      const stream = [
        { id: "qwen-1", model: cloudflareAlias, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] },
        { id: "qwen-1", model: cloudflareAlias, choices: [], usage: {
          prompt_tokens: 36, completion_tokens: 55, total_tokens: 91,
          prompt_tokens_details: { cached_tokens: 12 }, completion_tokens_details: { reasoning_tokens: 25 },
        } },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
      const upstream = new Response(stream, { headers: { "content-type": "text/event-stream" } });
      const normalized = normalizeFundedOpenAiResponse(upstream, { modelId: model, maxBytes: 10_000,
        upstreamModelAlias: cloudflareAlias });
      const usage = createFundedOpenAiUsageTracker({ contentType: "text/event-stream", nativeModelId: model,
        canonicalModelId: model, pricingVersion: ALIBABA_QWEN_37_PLUS_PRICE.version });
      usage.push(new Uint8Array(await normalized.arrayBuffer()));
      expect(usage.complete()).toEqual({ mode: "exact", actualCostMicrousd: 79 });
    });
  });
});
