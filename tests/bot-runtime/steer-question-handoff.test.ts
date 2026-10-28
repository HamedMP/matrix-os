import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { BotRunCommand } from "@matrix-os/contracts";
import type { BotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { runBotTurn, type BotTurnControl } from "../../packages/bot-runtime/src/loop.js";

async function handoff(count: number, stop?: "cancel" | "budget") {
  const provider = fauxProvider({ models: [{ id: "handoff", input: ["text"], contextWindow: 128_000, maxTokens: 4096 }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_person", { header: "Format", question: "Which format?", blocking: true }, { id: "call_question" }), { stopReason: "toolUse" }),
    ...Array.from({ length: count }, (_, index) => fauxAssistantMessage(fauxText(`Applied correction ${index + 1}.`))),
  ]);
  const stream = vi.spyOn(provider.provider, "streamSimple");
  const saved: Record<string, unknown>[][] = [];
  const broker: BotBrokerClient = {
    loadSession: async () => ({ revision: 1, needsRecompaction: false, messages: [] }),
    saveSession: async input => { saved.push(input.messages); return { revision: 2 }; },
    event: async () => undefined,
    tool: vi.fn(async () => ({ ok: true, content: [{ type: "text", text: "Question remains pending." }] })),
  };
  const controller = new AbortController();
  let control!: BotTurnControl;
  const accepted: boolean[] = [];
  const command: BotRunCommand = { version: 1, kind: "bot.run", runId: "run_handoff",
    route: { api: "anthropic-messages", modelId: "handoff", input: ["text"], contextWindow: 128_000, maxOutputTokens: 4096 },
    systemPrompt: "Answer the owner.", capabilities: ["interaction.create"],
    limits: { maxToolActions: 3, ...(stop === "budget" ? { maxInferenceCalls: 1 } : {}) },
    turn: { kind: "prompt", text: "Ask which format." } };
  const outcome = await runBotTurn({ command, broker, signal: controller.signal, bridgeOrigin: "http://127.0.0.1:41000",
    route: { provider: provider.provider, model: provider.getModel() }, onControl: value => { control = value; },
    onAgent: agent => agent.subscribe(event => {
      if (event.type === "message_end" && event.message.role === "assistant" && accepted.length === 0
        && event.message.content.some(part => part.type === "toolCall")) {
        for (let i = 0; i < count; i++) accepted.push(control.steer(`Correction ${i + 1}`));
        if (stop === "cancel") controller.abort();
      }
    }) });
  return { outcome, accepted, stream, saved: JSON.stringify(saved), broker };
}

it.each([1, 2])("answers %i already-ACKed steers when inference ends by asking a blocking question", async count => {
  const r = await handoff(count);
  expect(r.accepted).toEqual(Array(count).fill(true));
  expect(r.outcome.status).toBe("waiting_person");
  expect(r.stream).toHaveBeenCalledTimes(count + 1);
  for (let i = 1; i <= count; i++) expect(r.saved).toContain(`Applied correction ${i}.`);
  // Steering is not an answer or approval: the original interaction stays pending.
  expect(r.broker.tool).toHaveBeenCalledTimes(1);
});

it("keeps Stop authoritative over already-ACKed steering at a question boundary", async () => {
  const r = await handoff(2, "cancel");
  expect(r.accepted).toEqual([true, true]);
  expect(["cancelled", "uncertain"]).toContain(r.outcome.status);
  expect(r.stream).toHaveBeenCalledTimes(1);
  expect(r.saved).not.toContain("Applied correction");
});

it("does not buy extra inference to answer steering after the trusted generation budget ends", async () => {
  const r = await handoff(1, "budget");
  expect(r.accepted).toEqual([false]);
  expect(r.stream).toHaveBeenCalledTimes(1);
  expect(r.saved).not.toContain("Applied correction");
  expect(r.outcome.status).toBe("waiting_person");
});
