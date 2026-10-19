import { expect, it, vi } from "vitest";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";

// Exercise the real broker with only the network/credential boundary substituted.
const binding: BotRuntimeBinding = {
  runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6",
  ownerId: "guard_owner", botId: "bot_guard", chatId: "chat_guard",
  taskId: "task_guard", runId: "run_guard", rootFingerprint: "f".repeat(64),
  accessSourceId: "matrix_included", capabilities: [], requestClass: "interactive",
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"],
    contextWindow: 200_000, maxOutputTokens: 8_192 },
};

it.each([16_384, 0, -1, 8_192.5, "8192"])("rejects invalid output bound %s before relay dispatch", async maxTokens => {
  const fetchImpl = vi.fn(async () => new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
  const result = await forwardBotInference({ version: 1, action: "inference.messages",
    requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle: binding.runtimeHandle,
    executionGeneration: binding.executionGeneration, method: "POST", path: "/v1/messages?beta=true", headers: {},
    body: JSON.stringify({ model: binding.route.modelId, stream: true,
      messages: [{ role: "user", content: "synthetic" }], max_tokens: maxTokens }),
  }, binding, () => ({ allowed: true, accessSourceId: "matrix_included", allowedModelIds: [binding.route.modelId] }), {
    homePath: "/synthetic", lifetime: new AbortController().signal,
    resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_BASE_URL: "https://relay.invalid" } }),
    fetchImpl: fetchImpl as typeof fetch,
  });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(result.ok).toBe(false);
});

it("uses the registry route bound when a worker omits its output bound", async () => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  await forwardBotInference({ version: 1, action: "inference.messages",
    requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle: binding.runtimeHandle,
    executionGeneration: binding.executionGeneration, method: "POST", path: "/v1/messages?beta=true", headers: {},
    body: JSON.stringify({ model: binding.route.modelId, stream: true, messages: [{ role: "user", content: "synthetic" }] }),
  }, binding, () => ({ allowed: true, accessSourceId: "matrix_included", allowedModelIds: [binding.route.modelId] }), {
    homePath: "/synthetic", lifetime: new AbortController().signal,
    resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_BASE_URL: "https://relay.invalid" } }),
    fetchImpl: fetchImpl as typeof fetch,
  });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).max_tokens).toBe(8_192);
});

it.each([8_192, 2_048])("preserves the explicit output bound %s", async output => {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response("done", { headers: { "content-type": "text/event-stream" } }));
  const body = JSON.stringify({ model: binding.route.modelId, stream: true, max_tokens: output });
  const result = await forwardBotInference({ version: 1, action: "inference.messages",
    requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle: binding.runtimeHandle,
    executionGeneration: binding.executionGeneration, method: "POST", path: "/v1/messages?beta=true", headers: {}, body,
  }, binding, () => ({ allowed: true, accessSourceId: "matrix_included", allowedModelIds: [binding.route.modelId] }), {
    homePath: "/synthetic", lifetime: new AbortController().signal,
    resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_BASE_URL: "https://relay.invalid" } }), fetchImpl: fetchImpl as typeof fetch,
  });
  expect(result.ok).toBe(true);
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(body);
});

it.each(["bounded", "oversized", "conflicting"] as const)("enforces GLM completion-token alias: %s", async kind => {
  const glm: BotRuntimeBinding = { ...binding, route: { ...binding.route, api: "openai-completions", modelId: "@cf/zai-org/glm-5.3-flash" } };
  const fetchImpl = vi.fn(async () => new Response("done", { headers: { "content-type": "text/event-stream" } }));
  const result = await forwardBotInference({ version: 1, action: "inference.chat_completions",
    requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle: glm.runtimeHandle,
    executionGeneration: glm.executionGeneration, method: "POST", path: "/v1/chat/completions", headers: {},
    body: JSON.stringify({ model: glm.route.modelId, stream: true, max_completion_tokens: kind === "oversized" ? 16_384 : 8_192,
      ...(kind === "conflicting" ? { max_tokens: 8_192 } : {}) }),
  }, glm, () => ({ allowed: true, accessSourceId: "matrix_included", allowedModelIds: [glm.route.modelId] }), {
    homePath: "/synthetic", lifetime: new AbortController().signal,
    resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic", ANTHROPIC_BASE_URL: "https://relay.invalid" } }), fetchImpl: fetchImpl as typeof fetch,
  });
  expect(result.ok).toBe(kind === "bounded");
  expect(fetchImpl).toHaveBeenCalledTimes(kind === "bounded" ? 1 : 0);
});
