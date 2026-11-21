import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { BotEvent } from "@matrix-os/contracts";
import { runBotTurn, type BotTurnControl } from "../../packages/bot-runtime/src/loop.js";
import type { BotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";

// Real Pi -> worker -> broker. Only the external model response is scripted.
it.each([false, true].flatMap(steered => [false, true].map(partial => ({ steered, partial }))))(
  "reports exhaustion without an answer and retains partial output (steered=$steered, partial=$partial)", async ({ steered, partial }) => {
  const handle = fauxProvider({ models: [{ id: "empty-answer", input: ["text"], contextWindow: 128_000, maxTokens: 4_096 }] });
  const empty = fauxAssistantMessage(partial ? fauxText("A partial answer.") : [{ type: "thinking", thinking: "" }], { stopReason: "length" });
  handle.setResponses(steered ? [fauxAssistantMessage(fauxText("Original answer.")), empty] : [empty]);
  const events: BotEvent[] = [];
  const contexts: string[] = [];
  const saved: unknown[] = [];
  let control!: BotTurnControl;
  let correctionAccepted = false;
  const broker: BotBrokerClient = {
    loadSession: async () => ({ revision: 0, needsRecompaction: false, messages: [] }),
    saveSession: async session => { saved.push(session.messages); return { revision: 1 }; },
    tool: async () => { throw new Error("This text-only scenario has no tool"); },
    event: async frame => {
      events.push(frame);
      if (steered && frame.event.type === "assistant_delta" && !correctionAccepted) {
        correctionAccepted = control.steer("Make the answer shorter.");
        expect(correctionAccepted).toBe(true);
      }
    },
  };
  const result = await runBotTurn({
    command: { version: 1, kind: "bot.run", runId: "run_empty_answer", systemPrompt: "Answer the person.",
      route: { api: "anthropic-messages", modelId: "empty-answer", input: ["text"], contextWindow: 128_000, maxOutputTokens: 4_096 },
      capabilities: [], limits: { maxToolActions: 1 }, turn: { kind: "prompt", text: "Describe the forest." } },
    broker, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() },
    onControl: value => { control = value; },
    onAgent: agent => { agent.subscribe(event => {
      if (event.type === "message_start" && event.message.role === "assistant") contexts.push("assistant");
    }); },
  });
  expect(result).toMatchObject(partial ? { status: "completed", sessionRevision: 1 }
    : { status: "failed", failureCode: "unavailable", sessionRevision: 1 });
  expect(contexts).toHaveLength(steered ? 2 : 1);
  expect(correctionAccepted).toBe(steered);
  expect(saved).toHaveLength(1);
  expect(JSON.stringify(saved)).toContain('"stopReason":"length"');
  if (steered) {
    expect(JSON.stringify(saved)).toContain("Make the answer shorter.");
    expect(events.filter(frame => frame.event.type === "assistant_delta").map(frame =>
      frame.event.type === "assistant_delta" ? frame.event.text : "").join("")).toBe("Original answer." + (partial ? "A partial answer." : ""));
  } else {
    expect(events.filter(frame => frame.event.type === "assistant_delta").map(frame =>
      frame.event.type === "assistant_delta" ? frame.event.text : "").join("")).toBe(partial ? "A partial answer." : "");
  }
});
