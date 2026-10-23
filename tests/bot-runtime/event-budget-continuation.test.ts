import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { BotEvent } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import { createEventProjector, LIVE_TEXT_EVENTS } from "../../packages/bot-runtime/src/events.js";

const partial = fauxAssistantMessage(fauxText(""));
const delta = (text: string): AgentEvent => ({ type: "message_update", message: partial,
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial } });
const boundary: AgentEvent = { type: "message_end", message: partial };
const start = (id: string): AgentEvent => ({ type: "tool_execution_start", toolCallId: id,
  toolName: "read_artifact", args: { path: "synthetic.txt" } });
const end = (id: string): AgentEvent => ({ type: "tool_execution_end", toolCallId: id,
  toolName: "read_artifact", result: { content: [{ type: "text", text: "synthetic result" }] }, isError: false });
const text = (sent: BotEvent[]) => sent.flatMap(frame => frame.event.type === "assistant_delta" ? [frame.event.text] : []).join("");

function fixture(signal?: AbortSignal) {
  let clock = 0;
  const sent: BotEvent[] = [];
  const project = createEventProjector({ now: () => clock, signal, capabilityForTool: () => "artifact.read",
    send: async event => { sent.push(event); } });
  return { project, sent, tick() { clock += 300; } };
}

describe("bounded live-event continuation", () => {
  it("coalesces slow deltas and delivers text after the old cutoff", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 2_100; i++) { f.tick(); await f.project(delta("x")); }
      await f.project(delta("synthetic tail"));
      await f.project(boundary);
      await f.project(start("future")); await f.project(end("future"));
      await f.project.drain();
      expect(text(f.sent)).toBe("x".repeat(2_100) + "synthetic tail");
      expect(f.sent.filter(frame => frame.event.type === "tool_progress").map(frame => frame.event)).toMatchObject([
        { toolCallId: "future", phase: "started" }, { toolCallId: "future", phase: "completed" },
      ]);
      expect(f.sent.length).toBeGreaterThan(LIVE_TEXT_EVENTS);
      expect(f.sent.some(frame => frame.event.type === "activity" && /refresh once per second/.test(frame.event.label))).toBe(true);
      expect(f.sent.some(frame => frame.event.type === "activity" && /full reply appears/.test(frame.event.label))).toBe(false);
    } finally { f.project.close(); }
  });

  it("preserves a bounded Unicode and escaped-text prefix across all 63 model boundaries", async () => {
    const f = fixture(); let expected = "";
    try {
      for (let message = 0; message < 63; message++) {
        for (let i = 0; i < 80; i++) {
          const piece = "🧪\"\\\n"; expected += piece;
          f.tick(); await f.project(delta(piece));
        }
        await f.project(boundary);
      }
      await f.project.drain();
      expect(Buffer.byteLength(JSON.stringify(expected))).toBeLessThan(96 * 1024);
      expect(text(f.sent)).toBe(expected);
      expect(f.sent.every((frame, index) => frame.seq === index)).toBe(true);
      for (const frame of f.sent) if (frame.event.type === "assistant_delta") {
        expect(Buffer.byteLength(frame.event.text)).toBeLessThanOrEqual(12 * 1024);
        expect(frame.event.text).not.toContain("\uFFFD");
      }
    } finally { f.project.close(); }
  });

  it("preserves all 60 future tool lifecycles and later text after the old cutoff", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 2_100; i++) { f.tick(); await f.project(delta("x")); }
      // Repeated message boundaries cannot spend the later text or tool allocation.
      for (let i = 0; i < 200; i++) { await f.project(delta("y")); await f.project(boundary); }
      for (let tool = 0; tool < 60; tool++) {
        const id = `future_${tool}`; await f.project(start(id));
        for (let update = 0; update < 3; update++) {
          f.tick(); await f.project({ type: "tool_execution_update", toolCallId: id, toolName: "read_artifact", args: {},
            partialResult: { content: [{ type: "text", text: "synthetic update" }] } });
        }
        await f.project(end(id));
      }
      await f.project(start("over_budget")); await f.project(end("over_budget"));
      await f.project.drain();
      const tools = f.sent.flatMap(frame => frame.event.type === "tool_progress" ? [frame.event] : []);
      expect(tools.filter(event => event.phase === "started")).toHaveLength(60);
      expect(tools.filter(event => event.phase === "updated")).toHaveLength(180);
      expect(tools.filter(event => event.phase === "completed")).toHaveLength(60);
      expect(f.sent.length).toBeGreaterThan(LIVE_TEXT_EVENTS);
      expect(f.sent.every((frame, index) => frame.seq === index)).toBe(true);
      expect(f.sent.filter(frame => frame.event.type === "activity")).toHaveLength(1);
      expect(text(f.sent)).toBe("x".repeat(2_100) + "y".repeat(200));
    } finally { f.project.close(); }
  });

  it("keeps cancellation authoritative for a later tool terminal", async () => {
    const controller = new AbortController(); const f = fixture(controller.signal);
    try {
      for (let i = 0; i < 2_100; i++) { f.tick(); await f.project(delta("x")); }
      await f.project(start("stop_later")); controller.abort();
      await f.project(end("stop_later")); await f.project.drain();
      expect(f.sent.at(-1)?.event).toMatchObject({ type: "tool_progress", toolCallId: "stop_later", phase: "cancelled" });
    } finally { f.project.close(); }
  });
});
