import { describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createFundedAdmissionQueue } from "../../../packages/gateway/src/funded-ai/admission-queue.js";

const model = "@cf/zai-org/glm-5.3-flash";
const request: ScopeRuntimeBotInferenceRequest = {
  version: 1, action: "inference.chat_completions", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6", method: "POST",
  path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model, stream: true, messages: [] }),
};
const binding: ManagedPiRuntimeBinding = {
  runtimeHandle: request.runtimeHandle, executionGeneration: "6", kind: "managed_chat", ownerId: "owner",
  chatId: "chat_funded", runId: "run_funded", workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64),
  accessSourceId: "matrix_included", route: { api: "openai-completions", modelId: model, input: ["text"], contextWindow: 128_000, maxOutputTokens: 8_192 },
  capabilities: ["artifact.read"], requestClass: "interactive",
};
const authorization = { allowed: true, accessSourceId: "matrix_included", allowedModelIds: [model], allowedEgressOrigins: [] } as const;

describe("trusted funded broker diagnostics", () => {
  it.each(["insufficient_credit", "budget_exceeded"])("records %s for the exact binding without retry or upstream text", async (reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("SECRET DATABASE PATH", { status: 403, headers: { "x-matrix-funded-error": reason } }));
    const onFundedFailure = vi.fn(); const queue = createFundedAdmissionQueue();
    try {
      const result = await forwardBotInference(request, binding, () => authorization, {
        homePath: "/tmp", lifetime: new AbortController().signal, fetchImpl, fundedAdmission: queue, onFundedFailure,
        resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "test", ANTHROPIC_BASE_URL: "https://relay.example.com" } }),
      });
      expect(result).toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(onFundedFailure).toHaveBeenCalledExactlyOnceWith(binding, reason);
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { queue.close(); }
  });
  it.each([[401, "insufficient_credit"], [429, "insufficient_credit"], [502, "budget_exceeded"], [403, "secret/path"], [403, "insufficient_credit extra"]])("ignores unauthenticated/malformed/status-mismatched hints", async (status, reason) => {
    const onFundedFailure = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("SECRET", { status: status as number, headers: { "x-matrix-funded-error": reason as string } }));
    await forwardBotInference(request, binding, () => authorization, { homePath: "/tmp", lifetime: new AbortController().signal,
      fetchImpl, onFundedFailure, resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "test", ANTHROPIC_BASE_URL: "https://relay.example.com" } }) });
    expect(onFundedFailure).toHaveBeenCalledExactlyOnceWith(binding, undefined); expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("never treats an owner-provider hint as a Matrix credit error", async () => {
    const onFundedFailure = vi.fn();
    await forwardBotInference({ ...request, action: "inference.messages", path: "/v1/messages" }, binding,
      () => ({ ...authorization, accessSourceId: "owner_anthropic_profile" }), { homePath: "/tmp", lifetime: new AbortController().signal,
        onFundedFailure, fetchImpl: async () => new Response("SECRET", { status: 403, headers: { "x-matrix-funded-error": "insufficient_credit" } }),
        resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "test" } }) });
    expect(onFundedFailure).not.toHaveBeenCalled();
  });
  it("ignores a trusted hint after the run loses authority", async () => {
    let allowed = true; const onFundedFailure = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      allowed = false;
      return new Response("private", { status: 403, headers: { "x-matrix-funded-error": "insufficient_credit" } });
    });
    await forwardBotInference(request, binding, () => allowed ? authorization : { allowed: false }, {
      homePath: "/tmp", lifetime: new AbortController().signal, fetchImpl, onFundedFailure,
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "test", ANTHROPIC_BASE_URL: "https://relay.example.com" } }),
    });
    expect(onFundedFailure).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
