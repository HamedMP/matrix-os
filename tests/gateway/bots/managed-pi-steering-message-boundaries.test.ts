import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { BotEventSchema, type BotEvent } from "@matrix-os/contracts";
import { runBotTurn, type BotTurnControl } from "../../../packages/bot-runtime/src/loop.js";
import type { BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { mapBotEvent } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";

it.each(["Original answer.", "Original answer. " + "🌳".repeat(4_200)])(
  "keeps an actual Pi steered reply separate from earlier assistant output (%#)", async first => {
    // Keep upstream Unicode valid; the SDK faux tokenizer otherwise slices
    // arbitrary UTF-16 units. Production worker/mapper chunking stays real.
    const handle = fauxProvider({ tokenSize: { min: 32_768, max: 32_768 },
      models: [{ id: "faux-steer", input: ["text"], contextWindow: 128_000, maxTokens: 4_096 }] });
    const correction = "Answer the correction instead.";
    const acknowledgement = "CORRECTION_ACK";
    const contexts: string[] = [];
    handle.setResponses([first, acknowledgement].map(text => context => {
      contexts.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText(text));
    }));
    const frames: BotEvent[] = [];
    const canonical: CanonicalProviderRunEvent[] = [];
    let control!: BotTurnControl;
    let steered = false;
    const broker: BotBrokerClient = {
      loadSession: async () => ({ revision: 0, needsRecompaction: false, messages: [] }),
      saveSession: async () => ({ revision: 1 }),
      tool: async () => { throw new Error("No tool is part of this scenario"); },
      event: async frame => {
        // Preserve the real worker -> validated broker -> canonical consumer seam.
        const received = BotEventSchema.parse(JSON.parse(JSON.stringify(frame)));
        frames.push(received);
        canonical.push(...mapBotEvent(received.event).map(event => CanonicalProviderRunEventSchema.parse(event)));
        if (received.event.type === "assistant_delta" && !steered) {
          steered = true;
          expect(control.steer(correction)).toBe(true);
        }
      },
    };
    const result = await runBotTurn({
      command: { version: 1, kind: "bot.run", runId: "run_message_boundary", systemPrompt: "Follow the person's correction.",
        route: { api: "anthropic-messages", modelId: "faux-steer", input: ["text"], contextWindow: 128_000, maxOutputTokens: 4_096 },
        capabilities: [], limits: { maxToolActions: 1 }, turn: { kind: "prompt", text: "Give the original answer." } },
      broker, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() },
      onControl: value => { control = value; },
    });
    expect(result.status).toBe("completed");
    expect(contexts).toHaveLength(2);
    expect(contexts[1]).toContain(correction);
    expect(frames.every((frame, index) => frame.seq === index)).toBe(true);
    const deltas = canonical.filter(event => event.type === "assistant.delta");
    const ids = [...new Set(deltas.map(event => event.messageId))];
    // Without both producer and consumer preserving identity, canonical Chat
    // appends the ACK to the pre-correction row, above the person's correction.
    expect(ids).toHaveLength(2);
    expect(ids.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    // Each broker-to-canonical chunk must survive encoding on its own, as it
    // does when persisted; joining broken surrogate halves first hides loss.
    for (const event of deltas) {
      expect(new TextDecoder().decode(new TextEncoder().encode(event.delta))).toBe(event.delta);
    }
    expect(deltas.filter(event => event.messageId === ids[0]).map(event => event.delta).join("")).toBe(first);
    expect(deltas.filter(event => event.messageId === ids[1]).map(event => event.delta).join("")).toBe(acknowledgement);
  },
);

it("retains compatibility with older worker deltas without a message identity", () => {
  const frame = BotEventSchema.parse({ seq: 0, event: { type: "assistant_delta", text: "Legacy reply." } });
  expect(mapBotEvent(frame.event)).toEqual([{ type: "assistant.delta", delta: "Legacy reply." }]);
});
