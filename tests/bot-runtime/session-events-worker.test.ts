import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { BotEvent } from "@matrix-os/contracts";
import { createEventProjector, MAX_EVENTS_PER_TURN, splitUtf8 } from "../../packages/bot-runtime/src/events.js";
import {
  BotSessionError,
  compactSession,
  decodeSession,
  encodeSession,
  encodedSessionBytes,
  fitForStorage,
  planCompaction,
  serializeForSummary,
  SESSION_MAX_BYTES,
} from "../../packages/bot-runtime/src/session.js";

const user = (text: string, timestamp = 1): AgentMessage => ({ role: "user", content: text, timestamp });
const assistantCall = (id: string): AgentMessage => fauxAssistantMessage([{ type: "toolCall", id, name: "read_artifact", arguments: { path: "a.md" } }], { stopReason: "toolUse" });
const toolResult = (id: string): AgentMessage => ({
  role: "toolResult", toolCallId: id, toolName: "read_artifact", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 1,
} as AgentMessage);

describe("bot session codec and compaction", () => {
  it("decodes only known roles with timestamps and enforces the size cap", () => {
    expect(decodeSession([{ role: "user", content: "hi", timestamp: 1 }])).toHaveLength(1);
    expect(() => decodeSession([{ role: "tool", content: "hi", timestamp: 1 }])).toThrow(BotSessionError);
    expect(() => decodeSession([{ role: "user", content: "hi" }])).toThrow(BotSessionError);
    expect(() => decodeSession([{ role: "user", content: "x".repeat(SESSION_MAX_BYTES), timestamp: 1 }])).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() => encodeSession([user("x".repeat(SESSION_MAX_BYTES))])).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("cuts at a user message so tool calls stay with their results", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "prompt", timestamp: 0 },
      user("turn 1"), assistantCall("c1"), toolResult("c1"),
      user("turn 2"), assistantCall("c2"), toolResult("c2"),
      user("turn 3"),
    ];
    const plan = planCompaction(messages, 2)!;
    expect(plan.head.map((message) => message.role)).toEqual(["system"]);
    expect(plan.older.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(plan.recent[0]).toMatchObject({ role: "user", content: "turn 2" });
    expect(planCompaction(messages, 3)).toBeUndefined();
  });

  it("replaces older turns with one summary message and keeps recent turns verbatim", async () => {
    const messages = [user("a"), user("b"), user("c"), user("d"), user("e"), user("f")];
    const summarize = vi.fn(async () => "The person wants Acme briefs.");
    const compacted = await compactSession({ messages, summarize, now: () => 99 });
    expect(compacted[0]).toMatchObject({ role: "user", timestamp: 99, content: expect.stringContaining("The person wants Acme briefs.") });
    expect(compacted.slice(1).map((message) => (message as { content: string }).content)).toEqual(["c", "d", "e", "f"]);
    expect(summarize).toHaveBeenCalledWith("Person: a\nPerson: b");
    await expect(compactSession({ messages, summarize: async () => "   ", now: () => 99 })).resolves.toEqual(messages);
  });

  it("keeps a text placeholder instead of image data in saved history", () => {
    const stored = fitForStorage([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "A".repeat(2_000_000), mimeType: "image/png" }], timestamp: 1 },
    ]);
    expect(JSON.stringify(stored)).not.toContain("AAAA");
    expect(stored[0]).toMatchObject({ content: [{ type: "text", text: "look" }, { type: "text", text: expect.stringContaining("image/png") }] });
  });

  it("never shortens the person's words, even when tool payloads must be cut", () => {
    const prompt = "p".repeat(60 * 1024);
    const big = Array.from({ length: 12 }, (_, index) => ({
      role: "toolResult", toolCallId: `c${index}`, toolName: "read_artifact",
      content: [{ type: "text", text: "y".repeat(40 * 1024) }], isError: false, timestamp: index,
    } as AgentMessage));
    const stored = fitForStorage([user(prompt), ...big], 256 * 1024);
    expect(encodedSessionBytes(stored)).toBeLessThanOrEqual(256 * 1024);
    expect(stored[0]).toEqual(user(prompt));
  });

  it("drops the oldest turns when cut tool payloads still do not fit, keeping the latest turn", () => {
    const turns = Array.from({ length: 40 }, (_, index) => [
      user(`${index}:${"q".repeat(30 * 1024)}`, index),
      fauxAssistantMessage(fauxText(`answer ${index}`)),
    ]).flat();
    const stored = fitForStorage([{ role: "system", content: "prompt", timestamp: 0 }, ...turns], 256 * 1024, () => 77);
    expect(encodedSessionBytes(stored)).toBeLessThanOrEqual(256 * 1024);
    expect(stored[0]).toMatchObject({ role: "system" });
    expect(stored[1]).toMatchObject({ role: "user", timestamp: 77, content: expect.stringContaining("removed to fit saved history") });
    expect(stored.at(-2)).toEqual(turns.at(-2));
    // Surviving person messages are whole and unchanged.
    const originals = new Set(turns.filter((message) => message.role === "user").map((message) => message.content));
    const kept = stored.slice(2).filter((message) => message.role === "user");
    expect(kept.length).toBeGreaterThan(0);
    for (const message of kept) expect(originals.has(message.content)).toBe(true);
  });

  it("cuts assistant prose before dropping turns, and never drops turns when told not to", () => {
    const turns = [1, 2, 3].flatMap((index) => [user(`ask ${index}`, index), fauxAssistantMessage(fauxText("z".repeat(100 * 1024)))]);
    const fitted = fitForStorage(turns, 128 * 1024);
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(128 * 1024);
    expect(JSON.stringify(fitted)).not.toContain("removed to fit saved history");
    expect(fitted.filter((message) => message.role === "user")).toHaveLength(3);

    const people = Array.from({ length: 10 }, (_, index) => user(`${index}:${"p".repeat(60 * 1024)}`, index));
    const kept = fitForStorage(people, 256 * 1024, () => 1, { allowDroppingTurns: false });
    expect(kept).toHaveLength(10);
    expect(() => encodeSession(kept)).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("shortens a reply by just the overflow instead of a fixed cap", () => {
    const reply = "R".repeat(150 * 1024);
    const turns = [user("ask", 1), fauxAssistantMessage(fauxText(reply))];
    const limit = encodedSessionBytes(turns) - 4 * 1024;
    const fitted = fitForStorage(turns, limit, () => 1, { allowDroppingTurns: false });
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(limit);
    const kept = (fitted[1] as { content: Array<{ text: string }> }).content[0]!.text;
    // Only the overflow (plus a small margin for the note) is lost, not all but 8 KiB.
    expect(kept.length).toBeGreaterThan(reply.length - 5 * 1024);
    expect(kept).toContain("left out of saved history");
  });

  it("shortens a multibyte reply by its encoded overflow, not by that many characters", () => {
    const reply = "\u65e5".repeat(60 * 1024);
    const turns = [user("ask", 1), fauxAssistantMessage(fauxText(reply))];
    const limit = encodedSessionBytes(turns) - 3 * 1024;
    const fitted = fitForStorage(turns, limit, () => 1, { allowDroppingTurns: false });
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(limit);
    const kept = (fitted[1] as { content: Array<{ text: string }> }).content[0]!.text;
    // Three bytes per character: about 1K characters go, not 3K.
    expect(kept.length).toBeGreaterThan(reply.length - 1_200);
    expect(kept).toContain("left out of saved history");
  });

  it("never splits a surrogate pair when shortening a reply", () => {
    const reply = "\u{1F600}".repeat(40 * 1024);
    const turns = [user("ask", 1), fauxAssistantMessage(fauxText(reply))];
    const limit = encodedSessionBytes(turns) - 3 * 1024 - 1;
    const fitted = fitForStorage(turns, limit, () => 1, { allowDroppingTurns: false });
    const kept = (fitted[1] as { content: Array<{ text: string }> }).content[0]!.text;
    expect(kept.isWellFormed()).toBe(true);
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(limit);
  });

  it("spreads a cancelled turn's overflow across as many reply parts as it takes", () => {
    const parts = Array.from({ length: 200 }, (_, index) => ({ type: "text" as const, text: `${index}:${"s".repeat(1_000)}` }));
    const turns = [user("ask", 1), fauxAssistantMessage(parts)];
    const limit = encodedSessionBytes(turns) - 80 * 1024;
    const fitted = fitForStorage(turns, limit, () => 1, { allowDroppingTurns: false });
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(limit);
    expect(() => encodeSession(fitted)).not.toThrow();
    const texts = (fitted[1] as { content: Array<{ text: string }> }).content.map((part) => part.text);
    expect(texts).toHaveLength(200);
    // A part is shortened once, so its note is never cut into by a later pass.
    for (const text of texts) expect(text.split("left out of saved history").length).toBeLessThanOrEqual(2);
  });

  it("lets a cancelled run shorten its latest reply rather than drop earlier turns", () => {
    const turns = [
      ...[1, 2].flatMap((index) => [user(`ask ${index}:${"q".repeat(80 * 1024)}`, index), fauxAssistantMessage(fauxText("a"))]),
      user("latest ask", 9),
      fauxAssistantMessage(fauxText("L".repeat(150 * 1024))),
    ];
    const fitted = fitForStorage(turns, 200 * 1024, () => 5, { allowDroppingTurns: false });
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(200 * 1024);
    expect(fitted.filter((message) => message.role === "user")).toHaveLength(3);
    expect(JSON.stringify(fitted)).not.toContain("removed to fit saved history");
  });

  it("keeps the latest reply whole, dropping older turns first when earlier prose is not enough", () => {
    const latestReply = fauxAssistantMessage(fauxText("L".repeat(150 * 1024)));
    const turns = [
      ...[1, 2, 3].flatMap((index) => [user(`ask ${index}:${"q".repeat(50 * 1024)}`, index), fauxAssistantMessage(fauxText("a".repeat(1024)))]),
      user("latest ask", 9),
      latestReply,
    ];
    const fitted = fitForStorage(turns, 200 * 1024, () => 5);
    expect(encodedSessionBytes(fitted)).toBeLessThanOrEqual(200 * 1024);
    expect(fitted.at(-1)).toEqual(latestReply);
    expect(JSON.stringify(fitted)).toContain("removed to fit saved history");
  });

  it("cuts oversized tool payloads only when the transcript would not fit", () => {
    const small = [user("hi"), toolResult("c1")];
    expect(fitForStorage(small)).toEqual(small);
    const big = Array.from({ length: 30 }, (_, index) => ({
      role: "toolResult", toolCallId: `c${index}`, toolName: "read_artifact",
      content: [{ type: "text", text: "y".repeat(40 * 1024) }], isError: false, timestamp: index,
    } as AgentMessage));
    const call = fauxAssistantMessage([{ type: "toolCall", id: "w", name: "write_artifact", arguments: { path: "a.md", content: "z".repeat(190 * 1024) } }], { stopReason: "toolUse" });
    const stored = fitForStorage([user("go"), call, ...big], 256 * 1024);
    expect(encodedSessionBytes(stored)).toBeLessThanOrEqual(256 * 1024);
    expect(stored).toHaveLength(32);
    expect(JSON.stringify(stored)).toContain("left out of saved history");
    expect(() => encodeSession(stored)).not.toThrow();
  });

  it("summarizes without images or raw tool arguments", () => {
    const text = serializeForSummary([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
      assistantCall("c1"),
      toolResult("c1"),
    ]);
    expect(text).toBe("Person: look\nBot used read_artifact.\nTool result (read_artifact): contents");
  });
});

describe("bot event projection", () => {
  it("splits deltas on UTF-8 boundaries within the byte bound", () => {
    const chunks = splitUtf8("é".repeat(10), 5);
    expect(chunks.join("")).toBe("é".repeat(10));
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 5)).toBe(true);
    expect(splitUtf8("")).toEqual([]);
  });

  it("forwards text and known tool progress in order and drops reasoning", async () => {
    const sent: BotEvent[] = [];
    const project = createEventProjector({
      send: async (event) => { sent.push(event); },
      capabilityForTool: (name) => (name === "read_artifact" ? "artifact.read" : undefined),
    });
    const partial = fauxAssistantMessage(fauxText(""));
    const events: AgentEvent[] = [
      { type: "message_update", message: partial, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "secret", partial } },
      { type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial } },
      { type: "tool_execution_start", toolCallId: "call_1", toolName: "read_artifact", args: {} },
      { type: "tool_execution_start", toolCallId: "call_2", toolName: "unknown_tool", args: {} },
      { type: "tool_execution_end", toolCallId: "call_1", toolName: "read_artifact", result: {}, isError: true },
    ];
    for (const event of events) await project(event);
    expect(sent).toEqual([
      { seq: 0, event: { type: "assistant_delta", text: "Hi" } },
      { seq: 1, event: { type: "tool_progress", toolCallId: "call_1", capability: "artifact.read", phase: "started" } },
      { seq: 2, event: { type: "tool_progress", toolCallId: "call_1", capability: "artifact.read", phase: "failed" } },
    ]);
  });
});

describe("bot event batching", () => {
  const partial = fauxAssistantMessage(fauxText(""));
  const delta = (text: string): AgentEvent => ({ type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial } });

  it("combines small deltas until the interval passes or the message ends", async () => {
    let clock = 0;
    const sent: BotEvent[] = [];
    const project = createEventProjector({ send: async (event) => { sent.push(event); }, capabilityForTool: () => undefined, now: () => clock });
    for (const part of ["a", "b", "c"]) await project(delta(part));
    expect(sent).toEqual([]);
    clock = 300;
    await project(delta("d"));
    expect(sent.map((event) => event.event)).toEqual([{ type: "assistant_delta", text: "abcd" }]);
    await project(delta("e"));
    await project({ type: "message_end", message: partial });
    expect(sent.map((event) => event.event)).toEqual([{ type: "assistant_delta", text: "abcd" }, { type: "assistant_delta", text: "e" }]);
  });

  it("sends paused text on a timer instead of waiting for the next event", async () => {
    vi.useFakeTimers();
    try {
      const sent: BotEvent[] = [];
      const project = createEventProjector({ send: async (event) => { sent.push(event); }, capabilityForTool: () => undefined, now: () => Date.now() });
      await project(delta("Thinking about"));
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(260);
      expect(sent.map((event) => event.event)).toEqual([{ type: "assistant_delta", text: "Thinking about" }]);
      await project(delta(" it"));
      await project.drain();
      expect(sent.map((event) => event.seq)).toEqual([0, 1]);
      project.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a failed timed send on drain and on the next event", async () => {
    vi.useFakeTimers();
    try {
      const project = createEventProjector({
        send: async () => { throw new Error("broker down"); },
        capabilityForTool: () => undefined,
        now: () => Date.now(),
      });
      await project(delta("hello"));
      await vi.advanceTimersByTimeAsync(260);
      await expect(project.drain()).rejects.toThrow("broker down");
      await expect(project({ type: "message_end", message: partial })).rejects.toThrow("broker down");
      project.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops forwarding after the per-turn budget with one notice", async () => {
    let clock = 0;
    const sent: BotEvent[] = [];
    const project = createEventProjector({ send: async (event) => { sent.push(event); }, capabilityForTool: () => undefined, now: () => clock });
    for (let index = 0; index < MAX_EVENTS_PER_TURN + 50; index += 1) {
      clock += 1_000;
      await project(delta("x"));
    }
    expect(sent).toHaveLength(MAX_EVENTS_PER_TURN);
    expect(sent.at(-1)!.event).toMatchObject({ type: "activity", state: "started" });
  });
});
