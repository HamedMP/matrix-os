import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, normalizeContext } from "@earendil-works/pi-ai";
import type { BotEvent, BotRunCommand, BotToolRequest } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { BotBrokerError, type BotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { runBotTurn } from "../../packages/bot-runtime/src/loop.js";
import { BROKER_PLACEHOLDER_KEY, createBridgeModel } from "../../packages/bot-runtime/src/providers.js";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
import { readBotArtifactBytes } from "../../packages/gateway/src/bots/artifact-read.js";
import { BotBrokerActionError } from "../../packages/gateway/src/bots/broker-actions.js";
import { chatGptPlanWire } from "../../packages/gateway/src/bots/chatgpt-plan-wire.js";

const text = '{"name":"matrix-os"}\n';
const bytes = Buffer.from(text);
const chunk = { offset: 0, length: 32, sha256: "0".repeat(64) };

function fixture() {
  const calls: BotToolRequest[] = [];
  const saved: Record<string, unknown>[][] = [];
  const events: BotEvent[] = [];
  const broker: BotBrokerClient = {
    loadSession: async () => ({ revision: 3, needsRecompaction: false, messages: [] }),
    saveSession: async session => { saved.push(session.messages); return { revision: 4 }; },
    event: async event => { events.push(event); },
    tool: async request => {
      calls.push(request);
      if (request.capability !== "artifact.read") throw new Error("Unexpected capability");
      try {
        return { ok: true, content: [{ type: "text", text: readBotArtifactBytes(bytes, request.args) }] };
      } catch (error: unknown) {
        if (error instanceof BotBrokerActionError) throw new BotBrokerError(error.code);
        throw error;
      }
    },
  };
  return { broker, calls, saved, events };
}

const command: BotRunCommand = {
  version: 1, kind: "bot.run", runId: "run_digest_recovery",
  route: { api: "openai-responses", modelId: "gpt-6.1-sol", input: ["text"], contextWindow: 128_000, maxOutputTokens: 4_096 },
  systemPrompt: "Read only the requested workspace file.", capabilities: ["artifact.read"],
  limits: { maxToolActions: 2 }, turn: { kind: "prompt", text: "Read package.json." },
};

describe("Pi artifact recovery in one agent run (scripted provider, no live inference)", () => {
  it("retains the digest refusal then accepts an explicit path-only read in the same run", async () => {
    const handle = fauxProvider({ models: [{ id: "gpt-6.1-sol", input: ["text"], contextWindow: 128_000, maxTokens: 4_096 }] });
    handle.setResponses([
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "package.json", chunk }, { id: "call_bad" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "package.json" }, { id: "call_recover" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Read the workspace file.")),
    ]);
    const f = fixture();
    const outcome = await runBotTurn({ command, broker: f.broker, bridgeOrigin: "http://127.0.0.1:41000",
      route: { provider: handle.provider, model: handle.getModel() } });
    expect(outcome).toMatchObject({ runId: "run_digest_recovery", status: "completed", toolActions: 2, sessionRevision: 4 });
    expect(f.calls).toEqual([
      { toolCallId: "call_bad", capability: "artifact.read", args: { relPath: "package.json", chunk } },
      { toolCallId: "call_recover", capability: "artifact.read", args: { relPath: "package.json" } },
    ]);
    const results = f.saved[0]!.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ toolCallId: "call_bad", isError: true });
    expect(JSON.stringify(results[0])).toContain("SHA-256");
    expect(JSON.stringify(results[0])).not.toContain("matrix-os");
    expect(results[1]).toMatchObject({ toolCallId: "call_recover", isError: false, content: [{ type: "text", text }] });
    expect(f.events.flatMap(event => event.event.type === "tool_progress" ? [event.event.phase] : []))
      .toEqual(["started", "failed", "started", "completed"]);
  });

  it("never strips an incorrect digest or discloses bytes when repeated chunk reads fail", async () => {
    const handle = fauxProvider({ models: [{ id: "gpt-6.1-sol", input: ["text"], contextWindow: 128_000, maxTokens: 4_096 }] });
    handle.setResponses([
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "package.json", chunk }, { id: "call_bad1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "package.json", chunk }, { id: "call_bad2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Both reads were refused.")),
    ]);
    const f = fixture();
    await runBotTurn({ command, broker: f.broker, bridgeOrigin: "http://127.0.0.1:41000",
      route: { provider: handle.provider, model: handle.getModel() } });
    const results = f.saved[0]!.filter(message => message.role === "toolResult");
    expect(results).toHaveLength(2);
    expect(results.every(result => result.isError === true)).toBe(true);
    expect(JSON.stringify(results)).not.toContain("matrix-os");
    expect(f.calls.every(call => call.capability === "artifact.read" && call.args.chunk?.sha256 === chunk.sha256)).toBe(true);
  });

  it("keeps chunk optional in the real Responses SDK request schema", async () => {
    const f = fixture();
    const tools = createBotTools({ capabilities: ["artifact.read"], broker: f.broker,
      state: { waitingForPerson: false, effectUnknown: false } });
    const route = createBridgeModel(command.route, "http://127.0.0.1:41000");
    let finalTool: { strict?: boolean; parameters?: unknown } | undefined;
    let tool: { strict?: boolean; parameters?: { required?: string[]; properties?: Record<string, unknown> } } | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const raw = JSON.parse(String(init?.body));
      tool = raw.tools?.find((item: { name: string }) => item.name === "read_artifact");
      const wire = JSON.parse(chatGptPlanWire(raw, route.model.id));
      finalTool = wire.input.find((item: { type: string }) => item.type === "additional_tools")?.tools.find((item: { name: string }) => item.name === "read_artifact");
      return new Response(JSON.stringify({ error: { message: "Synthetic transport stop" } }),
        { status: 400, headers: { "content-type": "application/json" } });
    };
    await route.provider.streamSimple(route.model, normalizeContext({ systemPrompt: "Read the requested file.",
      messages: [{ role: "user", content: "Read package.json.", timestamp: 1 }], tools }),
    { apiKey: BROKER_PLACEHOLDER_KEY, fetch: fetchImpl, maxRetries: 0 }).result();
    expect(tool).toBeDefined();
    expect(tool!.parameters?.required).toContain("path");
    expect(tool!.parameters?.required).not.toContain("chunk");
    expect(finalTool?.parameters).toEqual(tool!.parameters);
    expect(finalTool?.strict).toBe(false);
    console.log("Synthetic schema evidence", JSON.stringify({ strict: tool!.strict ?? null, required: tool!.parameters?.required,
      chunkExposed: Boolean(tool!.parameters?.properties?.chunk) }));
  });
  it("preserves an explicit strict tool contract on the subscription wire", () => {
    const tool = { type: "function", name: "strict_read", strict: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } };
    const wire = JSON.parse(chatGptPlanWire({ model: "gpt-6.1-sol", stream: true, store: false,
      input: [{ role: "user", content: "Synthetic wire test" }], tools: [tool] }, "gpt-6.1-sol"));
    expect(wire.input[0].tools).toEqual([tool]);
  });

});
