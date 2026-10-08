import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundedRelay, resolveFundedRelayConfig } from "../../packages/proxy/src/funded-relay.js";
import { FundedControlPlaneError, type FundedPlatformClient } from "../../packages/proxy/src/funded-relay-platform-client.js";

const GLM = "@cf/zai-org/glm-5.3-flash";
const SONNET = "claude-sonnet-5";
const CREDENTIAL = `sk-matrix-funded-credential_123.${"s".repeat(43)}`;
const NOW = new Date("2026-09-10T12:00:00Z");
const IDENTITY = {
  tokenId: "credential_123", ownerId: "owner_private", machineId: "machine_private", runtimeSlot: "preview",
  audience: "matrix-funded-relay", scope: "ai:invoke", expiresAt: "2026-09-10T12:15:00Z",
};
const CONFIG = resolveFundedRelayConfig({
  MATRIX_FUNDED_AI_ENABLED: "true", MATRIX_FUNDED_AI_RESERVATION_MODE: "usage",
  CLOUDFLARE_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/preview/anthropic",
  CLOUDFLARE_AI_GATEWAY_TOKEN: "g".repeat(32), CLOUDFLARE_WORKERS_AI_TOKEN: "w".repeat(32),
  PLATFORM_INTERNAL_URL: "https://platform.example.test", AI_RELAY_CONTROL_TOKEN: "c".repeat(32),
  AI_RELAY_METADATA_SECRET: "m".repeat(32),
})!;
const relays: ReturnType<typeof createFundedRelay>[] = [];

function fixture(reservationMode: "usage" | "cloudflare-count" = "usage") {
  const control = {
    check: vi.fn(async () => ({ identity: IDENTITY })),
    authorize: vi.fn(async (input: { requestId: string; modelId: string; maxCostMicrousd: number }) => ({
      identity: IDENTITY, reservation: {
        reservationId: "reservation_1", requestId: input.requestId, modelId: input.modelId,
        reservedMicrousd: reservationMode === "usage" ? 1 : input.maxCostMicrousd,
        ...(reservationMode === "usage" ? { billingMode: "usage" } : {}),
      },
    })),
    start: vi.fn(async () => ({ reservationId: "reservation_1", requestId: "request_1", tokenId: IDENTITY.tokenId })),
    release: vi.fn(), finalize: vi.fn(async () => ({})),
  };
  const dispatches: Array<{ url: string; headers: Headers }> = [];
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    dispatches.push({ url: String(url), headers: new Headers(init?.headers) });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
    if (String(url).endsWith("/count_tokens")) return Response.json({ input_tokens: 100 });
    const body = JSON.parse(String(init?.body));
    return body.model === GLM
      ? Response.json({ id: "response_1", model: GLM, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      : Response.json({ id: "message_1", type: "message", role: "assistant", model: SONNET,
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 20 } });
  });
  const relay = createFundedRelay({ ...CONFIG, reservationMode, fetch: fetchFn, now: () => NOW,
    requestIdFactory: () => "request_1", platformClient: control as unknown as FundedPlatformClient });
  relays.push(relay);
  const app = new Hono(); relay.register(app);
  const request = (model: string, countOnly = false) => app.request(
    model === GLM ? "/v1/chat/completions" : countOnly ? "/v1/messages/count_tokens" : "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-api-key": CREDENTIAL,
        "cf-aig-collect-log": "false", "cf-aig-collect-log-payload": "true", "cf-aig-zdr": "false",
        "cf-aig-metadata": JSON.stringify({ raw_owner: "attacker", prompt: "private_prompt" }),
        "cf-aig-authorization": "Bearer caller_gateway_token", "cf-aig-gateway-id": "caller_gateway",
      },
      body: JSON.stringify({ model, max_tokens: 256, messages: [{ role: "user", content: "private_prompt" }],
        tools: model === GLM
          ? [{ type: "function", function: { name: "read_profile", description: "private_tool_description", parameters: { type: "object" } } }]
          : [{ name: "read_profile", description: "private_tool_description", input_schema: { type: "object" } }],
      }),
    });
  return { request, dispatches, control, fetchFn, relay };
}

function expectPrivateMetadata(headers: Headers, model: string) {
  const canonicalModel = model === SONNET ? `anthropic/${SONNET}` : model;
  const ref = (domain: string, value: string) => createHmac("sha256", CONFIG.metadataSecret)
    .update(`${domain}:${value}`).digest("base64url");
  expect(JSON.parse(headers.get("cf-aig-metadata")!)).toEqual({
    access_source: "matrix_funded", matrix_user_ref: ref("owner", IDENTITY.ownerId),
    model_ref: ref("model", canonicalModel), run_ref: ref("run", "request_1"),
    runtime_ref: ref("runtime", `${IDENTITY.machineId}:${IDENTITY.runtimeSlot}`),
  });
  for (const raw of [IDENTITY.ownerId, IDENTITY.machineId, IDENTITY.tokenId, "request_1", CREDENTIAL,
    "attacker", "private_prompt", "private_tool_description", "read_profile", "caller_gateway_token"]) {
    expect(headers.get("cf-aig-metadata")).not.toContain(raw);
  }
  expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
  expect(headers.get("cf-aig-zdr")).toBe("true");
  expect(headers.has("x-api-key")).toBe(false);
}

describe("funded generation metadata-only logging", () => {
  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.close();
  });

  it.each([SONNET, GLM])("collects only pseudonymous generation metadata for %s", async (model) => {
    const f = fixture();
    const response = await f.request(model);
    expect(response.status).toBe(200); await response.text(); await f.relay.close();
    expect(f.dispatches).toHaveLength(1);
    const { headers } = f.dispatches[0]!;
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expectPrivateMetadata(headers, model);
    expect(headers.get("authorization")).toBe(model === GLM ? `Bearer ${CONFIG.workersAiToken}` : null);
    expect(headers.get("cf-aig-authorization")).toBe(model === GLM ? null : `Bearer ${CONFIG.gatewayToken}`);
    expect(headers.get("cf-aig-gateway-id")).toBe(model === GLM ? "preview" : null);
    expect(f.control.start).toHaveBeenCalledTimes(1);
    expect(f.control.finalize).toHaveBeenCalledWith(expect.objectContaining({ mode: "exact" }), expect.any(AbortSignal));
  });

  it("does not enable collection for the token-count preflight", async () => {
    const f = fixture("cloudflare-count");
    const response = await f.request(SONNET);
    expect(response.status).toBe(200); await response.text();
    expect(f.dispatches).toHaveLength(2);
    const [count, generation] = f.dispatches;
    expect(count!.url).toMatch(/\/count_tokens$/);
    expect(count!.headers.has("cf-aig-collect-log")).toBe(false);
    expectPrivateMetadata(count!.headers, SONNET);
    expect(generation!.headers.get("cf-aig-collect-log")).toBe("true");
    expectPrivateMetadata(generation!.headers, SONNET);
  });

  it("leaves explicit count-only behavior unchanged without generation or reservation", async () => {
    const f = fixture();
    const response = await f.request(SONNET, true);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ input_tokens: 100 });
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]!.headers.has("cf-aig-collect-log")).toBe(false);
    expectPrivateMetadata(f.dispatches[0]!.headers, SONNET);
    expect(f.control.authorize).not.toHaveBeenCalled();
    expect(f.control.start).not.toHaveBeenCalled();
  });

  it("does not dispatch or collect logs when the control plane denies the caller", async () => {
    const f = fixture();
    f.control.check.mockRejectedValueOnce(new FundedControlPlaneError(403));
    expect((await f.request(GLM)).status).toBe(403);
    expect(f.fetchFn).not.toHaveBeenCalled();
    expect(f.control.authorize).not.toHaveBeenCalled();
  });
});
