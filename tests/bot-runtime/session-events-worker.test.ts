import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { BotEvent } from "@matrix-os/contracts";
import { createEventProjector, splitUtf8 } from "../../packages/bot-runtime/src/events.js";
import {
  BotSessionError,
  compactSession,
  decodeSession,
  encodeSession,
  planCompaction,
  serializeForSummary,
  SESSION_MAX_BYTES,
} from "../../packages/bot-runtime/src/session.js";
import { BotWorkerError, createBotWorker } from "../../packages/bot-runtime/src/worker.js";

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

describe("bot worker commands", () => {
  function worker() {
    const handle = fauxProvider({ models: [{ id: "faux-bot" }] });
    handle.setResponses([fauxAssistantMessage(fauxText("done"))]);
    let releaseLoad!: () => void;
    const loaded = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const broker = {
      loadSession: vi.fn(async () => { await loaded; return { revision: 0, messages: [] }; }),
      saveSession: vi.fn(async () => ({ revision: 1 })),
      tool: vi.fn(),
      event: vi.fn(async () => {}),
    };
    return { releaseLoad, bot: createBotWorker({ broker, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() }, now: () => 1 }) };
  }
  const runCommand = {
    version: 1, kind: "bot.run", runId: "run_one",
    route: { api: "anthropic-messages", modelId: "faux-bot", input: ["text"], contextWindow: 128_000, maxOutputTokens: 1_024 },
    systemPrompt: "You are a bot.", capabilities: [], limits: { maxToolActions: 5 }, turn: { kind: "prompt", text: "hi" },
  };

  it("runs one turn at a time and targets steer and cancel at the active run", async () => {
    const { bot, releaseLoad } = worker();
    const pending = bot.handle(runCommand);
    expect(bot.activeRunId).toBe("run_one");
    await expect(bot.handle({ ...runCommand, runId: "run_two" })).rejects.toEqual(new BotWorkerError("busy"));
    await expect(bot.handle({ version: 1, kind: "bot.cancel", runId: "run_other" })).resolves.toEqual({ acknowledged: false });
    await expect(bot.handle({ version: 1, kind: "bot.steer", runId: "run_one", text: "shorter" })).resolves.toEqual({ acknowledged: false });
    await expect(bot.handle({ version: 1, kind: "bot.cancel", runId: "run_one" })).resolves.toEqual({ acknowledged: true });
    releaseLoad();
    await expect(pending).resolves.toMatchObject({ runId: "run_one", status: "cancelled" });
    expect(bot.activeRunId).toBeUndefined();
  });

  it("rejects malformed commands", async () => {
    const { bot } = worker();
    await expect(bot.handle({ kind: "bot.run" })).rejects.toEqual(new BotWorkerError("invalid_command"));
  });
});
