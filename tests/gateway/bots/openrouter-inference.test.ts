import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { createOwnerOpenRouterKeySaver, readOwnerOpenRouterKey } from "../../../packages/gateway/src/ai-providers/owner-openrouter-key.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";

let home = "";
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = ""; });

it("sends only the generation-bound OpenRouter key and refuses rotation without fallback", async () => {
  home = await mkdtemp(join(tmpdir(), "openrouter-inference-"));
  await createOwnerOpenRouterKeySaver({ homePath: home })("sk-or-exact");
  const generation = (await readOwnerOpenRouterKey(home)).credentialGeneration!;
  const model = "anthropic/claude-sonnet-5";
  const binding: ManagedPiRuntimeBinding = {
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", kind: "managed_chat", ownerId: "owner",
    chatId: "chat_openrouter", runId: "run_openrouter", workspace: { kind: "chat_workspace" }, rootFingerprint: "b".repeat(64),
    accessSourceId: "owner_openrouter", openRouter: { credentialGeneration: generation },
    route: { api: "anthropic-messages", modelId: model, input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
    capabilities: ["artifact.read"], requestClass: "interactive",
  };
  const request: ScopeRuntimeBotInferenceRequest = { version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2",
    runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, action: "inference.messages",
    method: "POST", path: "/v1/messages", headers: { "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, stream: true, messages: [] }) };
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-or-exact");
    expect(headers.has("x-api-key")).toBe(false);
    return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  const authorize = () => ({ allowed: true as const, accessSourceId: "owner_openrouter" as const,
    allowedModelIds: [model], allowedEgressOrigins: [] });
  expect(await forwardBotInference(request, binding, authorize, { homePath: home,
    lifetime: new AbortController().signal, fetchImpl })).toMatchObject({ ok: true });
  expect(fetchImpl).toHaveBeenCalledOnce();

  await createOwnerOpenRouterKeySaver({ homePath: home })("sk-or-rotated");
  expect(await forwardBotInference(request, binding, authorize, { homePath: home,
    lifetime: new AbortController().signal, fetchImpl })).toMatchObject({ ok: false, error: "action_denied" });
  expect(fetchImpl).toHaveBeenCalledOnce();
});

