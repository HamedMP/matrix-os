import { describe, expect, it, vi } from "vitest";
import type { ManagedPiRuntimeBinding, PiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";

async function runFailure(options: { code?: "insufficient_credit" | "budget_exceeded"; mismatch?: Partial<ManagedPiRuntimeBinding>; recovered?: boolean; laterFailure?: boolean; completed?: boolean }) {
  const snapshot = makeAiProviderSnapshot();
  const model = "claude-sonnet-5"; const selection = { instanceId: "matrix_pi_default", model };
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: "owner", chatId: "chat_failure", runId: "run_failure",
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64),
    ...resolveManagedPiRoute(snapshot, selection), capabilities: ["artifact.read"], requestClass: "interactive" };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("PRIVATE SDK ERROR", { status: 403,
    ...(options.code ? { headers: { "x-matrix-funded-error": options.code } } : {}) }));
  const release = vi.fn(async () => undefined);
  const runtime = createManagedPiRuntime({ admission: { admit: async () => binding, release,
    workspace: async () => "/owned/chat", toolAuthority: async () => ({ permissionMode: "supervised" }) },
    lifetime: new AbortController().signal, providers: { getSnapshot: async () => snapshot }, forgetRun: () => undefined, cancelInference: () => undefined,
    host: { client: { runBot: async () => {
      const request = { version: 1 as const, action: "inference.messages" as const, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
        runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, method: "POST" as const,
        path: "/v1/messages" as const, headers: {}, body: JSON.stringify({ model, stream: true, messages: [] }) };
      const deps = { homePath: "/tmp", lifetime: new AbortController().signal, fetchImpl,
        resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "private", ANTHROPIC_BASE_URL: "https://relay.example.com" } }),
        onFundedFailure: (identity: PiRuntimeBinding, reason: "insufficient_credit" | "budget_exceeded" | undefined) => runtime.recordFundedFailure({ ...identity, ...options.mismatch }, reason) };
      const authorize = () => ({ allowed: true, accessSourceId: "matrix_included" as const, allowedModelIds: [model], allowedEgressOrigins: [] });
      await forwardBotInference(request, binding, authorize, deps);
      if (options.recovered || options.laterFailure) {
        if (options.laterFailure) fetchImpl.mockRejectedValueOnce(new Error("PRIVATE network error"));
        else fetchImpl.mockResolvedValueOnce(new Response("successful inference", { headers: { "content-type": "text/event-stream" } }));
        await forwardBotInference(request, binding, authorize, deps);
      }
      return { ok: true, reply: { runId: binding.runId, status: options.completed ? "completed" : "failed", failureCode: "unavailable", toolActions: 0 } };
    } } } as unknown as ScopeRuntimeHost,
  });
  const events = [];
  for await (const event of runtime.adapter.start({ owner: { type: "personal", ownerId: "owner" }, chatId: binding.chatId,
    turnId: "cturn_failure", runId: binding.runId, selection, prompt: "hello", parts: [{ type: "text", text: "hello" }],
    interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal })) events.push(event);
  expect(JSON.stringify(events)).not.toContain("PRIVATE SDK ERROR");
  expect(release).toHaveBeenCalledExactlyOnceWith(binding.runtimeHandle);
  // A terminal run's late broker diagnostic cannot resurrect state.
  runtime.recordFundedFailure(binding, "insufficient_credit");
  await runtime.close();
  return events.at(-1);
}

describe("canonical managed Pi credit failures", () => {
  it.each(["insufficient_credit", "budget_exceeded"] as const)("retains trusted %s from broker on the failed canonical run", async (code) => {
    expect(await runFailure({ code })).toMatchObject({ type: "run.completed", outcome: "failed", error: { code, retryable: false } });
  });
  it.each([{ ownerId: "another_owner" }, { chatId: "another_chat" }, { runId: "run_another" }, { executionGeneration: "2" }, { runtimeHandle: `runtime_${"b".repeat(32)}` }])(
    "ignores stale/cross-owner/cross-chat/cross-run diagnostics", async (mismatch) => {
      expect(await runFailure({ code: "insufficient_credit", mismatch })).toMatchObject({ error: { code: "run_failed" } });
    });
  it("does not infer credit failures from arbitrary worker error text", async () => {
    expect(await runFailure({})).toMatchObject({ error: { code: "run_failed" } });
  });
  it("clears a recovered credit refusal before a later unrelated failure", async () => {
    expect(await runFailure({ code: "insufficient_credit", recovered: true })).toMatchObject({ error: { code: "run_failed" } });
  });
  it("does not mislabel a later network failure using an earlier credit refusal", async () => {
    expect(await runFailure({ code: "insufficient_credit", laterFailure: true })).toMatchObject({ error: { code: "run_failed" } });
  });
  it("does not replace a completed worker result with a prior credit rejection", async () => {
    expect(await runFailure({ code: "insufficient_credit", completed: true })).toMatchObject({ type: "run.completed", outcome: "completed" });
  });
});
