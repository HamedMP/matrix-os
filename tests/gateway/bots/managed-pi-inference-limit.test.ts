import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { BotRunSpec, BotToolRequest, BotRunOutcome } from "@matrix-os/contracts";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { runCommandFromSpec } from "../../../packages/bot-runtime/src/worker.js";
import type { BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const MODEL = "@cf/zai-org/glm-5.3-flash";

function fixture(isolated = false) {
  const snapshot = makeAiProviderSnapshot();
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: "matrix_cloudflare", eligibleModelIds: [MODEL], vendor: "cloudflare" });
  snapshot.models.push({ ...snapshot.models[0]!, id: MODEL, vendor: "cloudflare", capabilities: ["tools"], eligibleAccessSourceIds: ["matrix_cloudflare"] });
  const selection = { instanceId: "matrix_pi_default", model: MODEL };
  const resolved = resolveManagedPiRoute(snapshot, selection);
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: "user_limit", chatId: "chat_limit",
    runId: "run_limit", runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1",
    workspace: { kind: "chat_workspace" }, rootFingerprint: "b".repeat(64), ...resolved,
    route: { ...resolved.route, maxOutputTokens: isolated ? 256 : 8192 },
    capabilities: ["artifact.read"], requestClass: "interactive" };
  const specList: BotRunSpec[] = [];
  const handle = fauxProvider({ models: [{ id: MODEL, input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  const stream = vi.spyOn(handle.provider, "streamSimple");
  const tools: BotToolRequest[] = [];
  let messages: Record<string, unknown>[] = [{ role: "user", content: "Keep my earlier requirement.", timestamp: 1 }];
  let revision = 1;
  let workerOutcome: BotRunOutcome | undefined;
  const broker: BotBrokerClient = {
    loadSession: async () => ({ revision, needsRecompaction: false, messages }),
    saveSession: async session => { messages = session.messages; return { revision: ++revision }; },
    event: async () => undefined,
    tool: async request => { tools.push(request); return { ok: true, content: [{ type: "text", text: "OWNED_PROOF" }] }; },
  };
  const host = { client: { runBot: async () => {
    const spec = await runtime.runs.loadRunSpec(binding);
    specList.push(spec);
    workerOutcome = await runBotTurn({ command: runCommandFromSpec(binding.runId, spec, []), broker,
      bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() } });
    return { ok: true, reply: workerOutcome };
  } } } as unknown as ScopeRuntimeHost;
  const runtime: ReturnType<typeof createManagedPiRuntime> = createManagedPiRuntime({
    admission: { admit: async () => binding, release: async () => undefined,
      toolAuthority: async () => ({ permissionMode: "supervised" }), workspace: async () => "/owned/chat",
      startRenewal: () => ({ stop: async () => undefined }) },
    host, providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal,
    forgetRun: () => undefined, cancelInference: () => undefined,
    ...(isolated ? { isolatedChat: { select: () => true, targets: () => true,
      claim: async () => ({ phaseId: "phase_limit", maxInputBytes: 131072 as const }), consume: async () => true } } : {}),
  });
  return { runtime, handle, stream, tools, specList, messages: () => messages, outcome: () => workerOutcome,
    async start() {
      const events = [];
      for await (const event of runtime.adapter.start({ owner: { type: "personal", ownerId: binding.ownerId },
        chatId: binding.chatId, turnId: "cturn_limit", runId: binding.runId, prompt: "Read my proof.",
        parts: [{ type: "text", text: "Read my proof." }], selection, interactionMode: "default",
        permissionMode: "supervised", signal: new AbortController().signal })) events.push(event);
      return events;
    },
  };
}

describe("ordinary Matrix Chat trusted inference limit", () => {
  it("enforces the host ceiling through the broker spec and real worker without consuming invalid tool actions", async () => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", "2");
    const f = fixture();
    f.handle.setResponses([...Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(
      fauxToolCall("missing_tool", {}, { id: `unknown_${i}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage(fauxText("Must not reach this reply."))]);
    await f.start();
    expect(f.stream).toHaveBeenCalledTimes(2);
    expect(f.outcome()).toMatchObject({ status: "failed", toolActions: 0 });
    expect(f.specList[0]?.limits).toEqual({ maxToolActions: 60, maxInferenceCalls: 2 });
    expect(f.stream.mock.calls.every(([, , options]) => options?.maxTokens === 8192 && options?.maxRetries === 0)).toBe(true);
    await f.runtime.close();
  });

  it("retains an ordinary artifact tool roundtrip and transcript with a lower host ceiling", async () => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", "2");
    const f = fixture();
    f.handle.setResponses([
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "proof.txt" }, { id: "read_proof" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("OWNED_PROOF")),
    ]);
    expect((await f.start()).at(-1)).toMatchObject({ outcome: "completed" });
    expect(f.stream).toHaveBeenCalledTimes(2);
    expect(f.tools).toEqual([{ toolCallId: "read_proof", capability: "artifact.read", args: { relPath: "proof.txt" } }]);
    expect(f.specList[0]?.limits).toEqual({ maxToolActions: 60, maxInferenceCalls: 2 });
    expect(f.specList[0]?.isolatedTurn).toBeUndefined();
    expect(JSON.stringify(f.messages())).toContain("Keep my earlier requirement.");
    expect(JSON.stringify(f.messages())).toContain("OWNED_PROOF");
    await f.runtime.close();
  });

  it("keeps the conservative default when no host override is configured", async () => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", undefined);
    const f = fixture();
    f.handle.setResponses([...Array.from({ length: 70 }, (_, i) => fauxAssistantMessage(
      fauxToolCall("missing_tool", {}, { id: `unknown_${i}` }), { stopReason: "toolUse" })),
      fauxAssistantMessage(fauxText("Must not exceed the default."))]);
    await f.start();
    expect(f.stream).toHaveBeenCalledTimes(63);
    expect(f.outcome()?.status).toBe("failed");
    expect(f.specList[0]?.limits).toEqual({ maxToolActions: 60 });
    await f.runtime.close();
  });

  it.each(["", "0", "64", "2.5", " 2", "02", "-1", "NaN"])("rejects invalid trusted configuration %j before admitting Chat", value => {
    vi.stubEnv("MATRIX_BOT_MAX_INFERENCE_CALLS", value);
    expect(() => fixture()).toThrow();
  });
});
