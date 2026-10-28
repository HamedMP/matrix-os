import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { BOT_OUTPUT_MAX_ENCODED_BYTES, BotEventSchema, botOutputEncodedBytes, type BotEvent } from "@matrix-os/contracts";
import { expect, it, vi } from "vitest";
import { createEventProjector } from "../../packages/bot-runtime/src/events.js";

it("refreshes a small new delta on time after 2,100 prior live updates without a message boundary", async () => {
  vi.useFakeTimers();
  const partial = fauxAssistantMessage(fauxText(""));
  const delta = (text: string): AgentEvent => ({ type: "message_update", message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial } });
  const sent: BotEvent[] = [];
  const project = createEventProjector({ send: async event => { sent.push(event); }, capabilityForTool: () => undefined });
  const text = () => sent.flatMap(frame => frame.event.type === "assistant_delta" ? [frame.event.text] : []).join("");
  try {
    for (let index = 0; index < 2_100; index++) {
      await project(delta("x"));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await project(delta("VISIBLE_TAIL"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(text()).toBe("x".repeat(2_100) + "VISIBLE_TAIL");
  } finally { project.close(); vi.useRealTimers(); }
});

it("bounds encoded output and individual frames while retaining tool cancellation after the text limit", async () => {
  const partial = fauxAssistantMessage(fauxText(""));
  let bytes = 0;
  let notices = 0;
  const tools: string[] = [];
  const controller = new AbortController();
  const project = createEventProjector({ signal: controller.signal, capabilityForTool: () => "artifact.read", send: async frame => {
    expect(BotEventSchema.safeParse(frame).success).toBe(true);
    if (frame.event.type === "assistant_delta") bytes += botOutputEncodedBytes(frame.event.text);
    if (frame.event.type === "activity" && /retention limit/.test(frame.event.label)) notices++;
    if (frame.event.type === "tool_progress") tools.push(frame.event.phase);
  } });
  try {
    for (let index = 0; index < 705; index++) {
      await project({ type: "message_update", message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\u0000".repeat(2_000), partial } });
    }
    await project({ type: "tool_execution_start", toolCallId: "after_output_limit", toolName: "read_artifact", args: {} });
    controller.abort();
    await project({ type: "tool_execution_end", toolCallId: "after_output_limit", toolName: "read_artifact", result: {}, isError: false });
    await project.drain();
    expect(bytes).toBeLessThanOrEqual(BOT_OUTPUT_MAX_ENCODED_BYTES);
    expect(bytes).toBeGreaterThan(BOT_OUTPUT_MAX_ENCODED_BYTES - 6);
    expect(notices).toBe(1);
    expect(tools).toEqual(["started", "cancelled"]);
  } finally { project.close(); }
});
