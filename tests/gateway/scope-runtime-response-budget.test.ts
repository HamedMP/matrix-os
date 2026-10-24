import { describe, expect, it, vi } from "vitest";
import {
  createScopeRuntimeBroker,
  readBoundedBody,
} from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";

const REQUEST = {
  version: 1 as const,
  action: "inference.messages" as const,
  requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: "runtime_22222222222222222222222222222222",
  executionGeneration: "7",
  method: "POST" as const,
  path: "/v1/messages?beta=true" as const,
  headers: { "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "claude-test", stream: true, messages: [{ role: "user", content: "hello" }] }),
};

function sseOfBytes(bytes: number, fill: string): string {
  const terminal = '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const remaining = bytes - Buffer.byteLength(`: ${terminal}`, "utf8");
  const fillBytes = Buffer.byteLength(fill, "utf8");
  return `: ${fill.repeat(Math.floor(remaining / fillBytes))}${"x".repeat(remaining % fillBytes)}${terminal}`;
}

describe("scope runtime inference response budget", () => {
  it.each([
    { bytes: 512 * 1024 + 1, fill: "中", label: "over the former 512 KiB cap with UTF-8 text" },
    { bytes: 1024 * 1024, fill: "\u0001", label: "exactly 1 MiB even when JSON escaping expands it" },
  ])("accepts Anthropic SSE $label", async ({ bytes, fill }) => {
    const body = sseOfBytes(bytes, fill);
    expect(Buffer.byteLength(body, "utf8")).toBe(bytes);
    const fetchImpl = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const broker = createScopeRuntimeBroker({
      homePath: "/unused-response-budget-test",
      authorize: async () => ({ allowed: true as const, accessSourceId: "owner_anthropic_key" as const,
        allowedModelIds: ["claude-test"], allowedEgressOrigins: [] }),
      resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "fixture-only" } }),
      fetchImpl,
    });
    try {
      const response = await broker.handle(REQUEST);
      expect(response).toMatchObject({ ok: true, status: 200 });
      if (!response.ok) throw new Error("Expected successful inference response");
      expect(response.body).toBe(body);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it("rejects Anthropic SSE exceeding 1 MiB by one UTF-8 byte", async () => {
    const body = sseOfBytes(1024 * 1024 + 1, "中");
    expect(Buffer.byteLength(body, "utf8")).toBe(1024 * 1024 + 1);
    expect(body.length).toBeLessThan(1024 * 1024);
    const fetchImpl = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const broker = createScopeRuntimeBroker({
      homePath: "/unused-response-budget-test",
      authorize: async () => ({ allowed: true as const, accessSourceId: "owner_anthropic_key" as const,
        allowedModelIds: ["claude-test"], allowedEgressOrigins: [] }),
      resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "fixture-only" } }),
      fetchImpl,
    });
    try {
      expect(await broker.handle(REQUEST)).toMatchObject({ ok: false, error: "response_too_large" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it("keeps the default egress reader accepting exactly 512 KiB", async () => {
    const body = "x".repeat(512 * 1024);
    await expect(readBoundedBody(new Response(body))).resolves.toBe(body);
  });

  it("keeps the default egress reader rejecting 512 KiB plus one byte", async () => {
    await expect(readBoundedBody(new Response("x".repeat(512 * 1024 + 1))))
      .rejects.toThrow("response_too_large");
  });
});
