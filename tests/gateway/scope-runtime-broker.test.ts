import { describe, expect, it, vi } from "vitest";
import {
  ScopeRuntimeBrokerRequestSchema,
  type ScopeRuntimeBrokerRequest,
} from "../../packages/scope-runtime/src/broker-protocol.js";
import { createScopeRuntimeBroker } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";

const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
const RUNTIME_HANDLE = "runtime_22222222222222222222222222222222";
const MODEL = "claude-haiku-4-5-20251001";

const inferenceRequest = {
  version: 1 as const,
  action: "inference.messages" as const,
  requestId: REQUEST_ID,
  runtimeHandle: RUNTIME_HANDLE,
  executionGeneration: "7",
  method: "POST" as const,
  path: "/v1/messages?beta=true" as const,
  headers: {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219",
  },
  body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hello" }] }),
};

describe("scope runtime broker protocol", () => {
  it("accepts bounded actions and rejects host capability injection", () => {
    expect(ScopeRuntimeBrokerRequestSchema.parse(inferenceRequest)).toEqual(inferenceRequest);
    for (const injected of [
      { action: "host.fetch" },
      { path: "/v1/complete" },
      { accessSourceId: "owner_anthropic_key" },
      { headers: { authorization: "Bearer stolen" } },
      { body: "x".repeat(256 * 1024 + 1) },
      { command: "/bin/sh" },
    ]) {
      expect(ScopeRuntimeBrokerRequestSchema.safeParse({ ...inferenceRequest, ...injected }).success).toBe(false);
    }
  });
});

describe("scope runtime broker", () => {
  it("reauthorizes the runtime, applies the trusted access source, and never returns credentials", async () => {
    const authorize = vi.fn(async () => ({
      allowed: true as const,
      accessSourceId: "owner_anthropic_key" as const,
      allowedModelIds: [MODEL],
      allowedEgressOrigins: [],
    }));
    const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "owner-secret" } }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("owner-secret");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-provider-secret": "never-forward" },
      });
    });
    const broker = createScopeRuntimeBroker({
      homePath: "/home/matrix/home",
      authorize,
      resolveCredentials,
      fetchImpl,
    });

    const result = await broker.handle(inferenceRequest);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "7",
      action: "inference.messages",
      modelId: MODEL,
    }));
    expect(resolveCredentials).toHaveBeenCalledWith(
      "/home/matrix/home",
      expect.anything(),
      "owner_anthropic_key",
      undefined,
    );
    expect(result).toEqual({
      version: 1,
      requestId: REQUEST_ID,
      ok: true,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    });
    expect(JSON.stringify(result)).not.toContain("owner-secret");
    await broker.close();
  });

  it("fails closed for revoked runs, unapproved models, and unbrokerable owner profiles", async () => {
    const authorize = vi.fn(async (input: { modelId?: string }) => input.modelId === "revoked"
      ? { allowed: false as const }
      : {
          allowed: true as const,
          accessSourceId: "owner_anthropic_profile" as const,
          allowedModelIds: [MODEL],
          allowedEgressOrigins: [],
        });
    const fetchImpl = vi.fn();
    const broker = createScopeRuntimeBroker({
      homePath: "/home/matrix/home",
      authorize,
      resolveCredentials: async () => ({ env: { HOME: "/home/matrix/home" } }),
      fetchImpl,
    });

    const revokedBody = JSON.stringify({ model: "revoked", stream: true, messages: [{}] });
    await expect(broker.handle({ ...inferenceRequest, body: revokedBody }))
      .resolves.toMatchObject({ ok: false, error: "action_denied" });
    await expect(broker.handle({
      ...inferenceRequest,
      body: JSON.stringify({ model: "unapproved", stream: true, messages: [{}] }),
    })).resolves.toMatchObject({ ok: false, error: "action_denied" });
    await expect(broker.handle(inferenceRequest))
      .resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await broker.close();
  });

  it("permits only authorization-provided public egress origins through a pinned resolver", async () => {
    const authorize = vi.fn(async () => ({
      allowed: true as const,
      allowedModelIds: [],
      allowedEgressOrigins: ["https://api.example.dev"],
    }));
    const resolveEgress = vi.fn(async (url: string) => ({ url: new URL(url), dispatcher: { close: vi.fn() } }));
    const fetchImpl = vi.fn(async () => new Response("safe", {
      status: 200,
      headers: { "content-type": "text/plain", "set-cookie": "secret=1" },
    }));
    const broker = createScopeRuntimeBroker({
      homePath: "/home/matrix/home",
      authorize,
      resolveEgress,
      fetchImpl,
    });
    const request: ScopeRuntimeBrokerRequest = {
      version: 1,
      action: "egress.fetch",
      requestId: REQUEST_ID,
      runtimeHandle: RUNTIME_HANDLE,
      executionGeneration: "7",
      method: "GET",
      url: "https://api.example.dev/v1/items?q=one",
      accept: "text/plain",
    };

    await expect(broker.handle(request)).resolves.toMatchObject({
      ok: true,
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "safe",
    });
    await expect(broker.handle({ ...request, url: "https://metadata.google.internal/" }))
      .resolves.toMatchObject({ ok: false, error: "action_denied" });
    expect(resolveEgress).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await broker.handle(request))).not.toContain("set-cookie");
    await broker.close();
  });

  it("caps concurrent calls and aborts the bounded set on shutdown", async () => {
    const authorize = vi.fn(async () => ({
      allowed: true as const,
      accessSourceId: "owner_anthropic_key" as const,
      allowedModelIds: [MODEL],
      allowedEgressOrigins: [],
    }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const broker = createScopeRuntimeBroker({
      homePath: "/home/matrix/home",
      authorize,
      resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "secret" } }),
      fetchImpl,
      maxInFlight: 2,
    });
    const first = broker.handle(inferenceRequest);
    const second = broker.handle({ ...inferenceRequest, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2" });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await expect(broker.handle({
      ...inferenceRequest,
      requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d3",
    })).resolves.toMatchObject({ ok: false, error: "capacity_exceeded" });

    await broker.close();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: false, error: "provider_unavailable" }),
      expect.objectContaining({ ok: false, error: "provider_unavailable" }),
    ]);
  });

  it("fails closed when trusted policy returns an unbounded capability set", async () => {
    const fetchImpl = vi.fn();
    const broker = createScopeRuntimeBroker({
      homePath: "/home/matrix/home",
      authorize: async () => ({
        allowed: true,
        accessSourceId: "owner_anthropic_key",
        allowedModelIds: [MODEL, ...Array.from({ length: 128 }, (_value, index) => `model-${index}`)],
        allowedEgressOrigins: [],
      }),
      resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "secret" } }),
      fetchImpl,
    });

    await expect(broker.handle(inferenceRequest))
      .resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await broker.close();
  });
});
