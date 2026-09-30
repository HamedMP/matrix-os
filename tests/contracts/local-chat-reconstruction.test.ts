import { describe, expect, it } from "vitest";
import { reconstructLocalChat } from "../../packages/contracts/src/local-chat-import/reconstruct.js";
const session = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const timestamp = "2026-09-03T16:16:38.000Z";
function wrapped(type: string, payload: unknown) { return { timestamp, type, payload }; }
function text(type: string, value: string) { return { type, text: value }; }
async function project(harness: "codex" | "claude", records: unknown[]) {
  async function* source() {
    for (let index = 0; index < records.length; index += 1) {
      yield { kind: "record" as const, line: index + 1, offset: index * 100, end: (index + 1) * 100,
        value: records[index] as Record<string, unknown> };
    }
  }
  return Array.fromAsync(reconstructLocalChat(harness, source()));
}
function counts(events: Awaited<ReturnType<typeof project>>) {
  return {
    messages: new Set(events.filter(e => e.kind === "message").map(e => e.messageKey)).size,
    calls: events.filter(e => e.kind === "tool_call").length,
    results: events.filter(e => e.kind === "tool_result").length,
    media: (() => {
      const fragments: Record<string, unknown[]> = {};
      const tools = events.filter(e => e.kind === "tool_result").flatMap(e => e.blocks);
      for (const e of events) if (e.kind === "message") {
        if (e.mode === "replace_mirror") fragments[e.messageKey] = e.blocks;
        else fragments[e.messageKey] = [...(fragments[e.messageKey] ?? []), ...e.blocks];
      }
      return [...Object.values(fragments).flat(), ...tools].filter(b => (b as { kind: string }).kind === "media").length;
    })(),
  };
}
describe("local Codex and Claude history reconstruction", () => {
  it("reconciles different-ID Codex user mirrors and same-ID commentary mirrors locally", async () => {
    const events = await project("codex", [
      wrapped("session_meta", { id: session, cwd: "/synthetic/repo" }),
      wrapped("response_item", { type: "message", id: "u-model", role: "user", content: [text("input_text", "prompt")] }),
      wrapped("event_msg", { type: "item_completed", thread_id: session, turn_id: "t", item: { type: "UserMessage", id: "u-event", content: [text("text", "prompt")] } }),
      wrapped("event_msg", { type: "item_completed", thread_id: session, turn_id: "t", item: { type: "AgentMessage", id: "a", phase: "commentary", content: [text("Text", "progress")] } }),
      wrapped("response_item", { type: "message", id: "a", role: "assistant", phase: "commentary", content: [text("output_text", "progress")] }),
      wrapped("response_item", { type: "custom_tool_call", call_id: "c", name: "synthetic", input: "{}" }),
      wrapped("response_item", { type: "custom_tool_call_output", call_id: "c", output: [text("input_text", "one"), text("input_text", "two")] }),
      wrapped("response_item", { type: "message", id: "f", role: "assistant", phase: "final_answer", content: [text("output_text", "final")] }),
    ]);
    expect(counts(events)).toEqual({ messages: 3, calls: 1, results: 1, media: 0 });
    expect(events.filter(e => e.kind === "message").map(e => e.phase)).toEqual(["unknown", "commentary", "final"]);
    expect(events.find(e => e.kind === "tool_result")).toMatchObject({ blocks: [ { kind: "text", text: "one" }, { kind: "text", text: "two" } ] });
  });
  it("replaces an event image mirror with the full model representation without adding a third attachment", async () => {
    const events = await project("codex", [
      wrapped("event_msg", { type: "item_completed", turn_id: "t", item: { type: "UserMessage", id: "u-event", content: [text("text", "prompt"), { type: "local_image", path: "/missing/image.png" }] } }),
      wrapped("response_item", { type: "message", id: "u-model", role: "user", content: [text("input_text", "prompt"), { type: "input_image", image_url: "data:image/png;base64,aW1hZ2Ux" }] }),
      wrapped("response_item", { type: "function_call", call_id: "c", name: "synthetic", arguments: "{}" }),
      wrapped("response_item", { type: "function_call_output", call_id: "c", output: [{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2Uy" }] }),
    ]);
    expect(counts(events)).toEqual({ messages: 1, calls: 1, results: 1, media: 2 });
    expect(events.filter(e => e.kind === "message")[1]).toMatchObject({ mode: "replace_mirror" });
  });
  it("includes event-only command activity with failure outcome", async () => {
    const events = await project("codex", [wrapped("event_msg", { type: "item_completed", item: {
      type: "CommandExecution", id: "exec", command: "synthetic", aggregated_output: "full result", exit_code: 1, status: "failed",
    } })]);
    expect(counts(events)).toEqual({ messages: 0, calls: 1, results: 1, media: 0 });
    expect(events.find(e => e.kind === "tool_result")).toMatchObject({ callId: "exec", outcome: "failed" });
  });
  it("does not collapse repeated human prompts in different explicit turns", async () => {
    const events = await project("codex", [
      wrapped("event_msg", { type: "item_completed", turn_id: "one", item: { type: "UserMessage", id: "u1", content: [text("text", "again")] } }),
      wrapped("turn_context", { turn_id: "two" }),
      wrapped("response_item", { type: "message", id: "u2", role: "user", content: [text("input_text", "again")] }),
    ]);
    expect(counts(events).messages).toBe(2);
  });
  it("keeps different image-only inputs when no shared identity or text proves a mirror", async () => {
    const events = await project("codex", [
      wrapped("event_msg", { type: "item_completed", item: { type: "UserMessage", id: "one", content: [{ type: "local_image", path: "/first.png" }] } }),
      wrapped("response_item", { type: "message", id: "two", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,c2Vjb25k" }] }),
    ]);
    expect(counts(events).messages).toBe(2);
  });
  it("uses each different-ID mirror pairing only once when identical prompts are legitimate repeats", async () => {
    const events = await project("codex", [
      ...[1, 2].flatMap(n => [
        wrapped("event_msg", { type: "item_completed", turn_id: `turn-${n}`, item: { type: "UserMessage", id: `event-${n}`, content: [text("text", "again")] } }),
        wrapped("response_item", { type: "message", id: `model-${n}`, role: "user", content: [text("input_text", "again"), text("input_text", "image context")] }),
      ]),
    ]);
    const messages = events.filter(e => e.kind === "message");
    expect(new Set(messages.map(e => e.messageKey)).size).toBe(2);
  });
  it("preserves repeated prompts across an assistant boundary when turn identity is absent", async () => {
    const events = await project("codex", [
      wrapped("event_msg", { type: "item_completed", item: { type: "UserMessage", id: "old", content: [text("text", "repeat")] } }),
      wrapped("response_item", { type: "message", role: "assistant", id: "answer", content: [text("output_text", "answer")] }),
      wrapped("response_item", { type: "message", role: "user", id: "new", content: [text("input_text", "repeat")] }),
    ]);
    expect(events.filter(e => e.kind === "message" && e.role === "user")).toHaveLength(2);
  });
  it("does not guess a different-ID mirror without recorded turn evidence", async () => {
    const events = await project("codex", [
      wrapped("event_msg", { type: "item_completed", item: { type: "UserMessage", id: "old", content: [text("text", "repeat")] } }),
      wrapped("response_item", { type: "message", role: "user", id: "new", content: [text("input_text", "repeat")] }),
    ]);
    expect(counts(events).messages).toBe(2);
  });
  it("keeps interleaved Claude prose and tools in exact block order", async () => {
    const events = await project("claude", [{ type: "assistant", sessionId: session, uuid: "record", message: { id: "response", content: [
      text("text", "before"), { type: "tool_use", id: "call", name: "synthetic", input: {} },
      text("text", "after"), { type: "thinking", thinking: "separate" }, text("text", "last"),
    ] } }]);
    expect(events.map(e => e.kind)).toEqual(["message", "tool_call", "message", "thinking", "message"]);
    expect(events.map(e => e.source.blockIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(counts(events).messages).toBe(1);
  });
  it("supports legacy unwrapped Codex records without fabricating per-message timestamps", async () => {
    const events = await project("codex", [
      { id: session, timestamp, instructions: null },
      { type: "message", id: null, role: "user", content: [text("input_text", "prompt")] },
      { type: "message", id: "a", role: "assistant", content: [text("output_text", "answer")] },
      { type: "function_call", call_id: "c", name: "synthetic", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "result" },
    ]);
    expect(counts(events)).toEqual({ messages: 2, calls: 1, results: 1, media: 0 });
    expect(events.filter(e => e.kind === "message").every(e => e.source.timestamp === undefined)).toBe(true);
  });
  it("distinguishes injected user-role instructions from human input", async () => {
    const events = await project("codex", [
      wrapped("response_item", { type: "message", role: "user", content: [text("input_text", "# AGENTS.md instructions for /synthetic\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n<environment_context>context</environment_context>")] }),
      wrapped("response_item", { type: "message", role: "user", content: [text("input_text", "Please write a test.")] }),
    ]);
    expect(counts(events).messages).toBe(1);
    expect(events.filter(e => e.kind === "context")).toHaveLength(1);
  });
  it("keeps legitimate repeated prompts and all distinct results sharing a call ID", async () => {
    const events = await project("codex", [
      ...["u1", "u2"].map(id => wrapped("response_item", { type: "message", id, role: "user", content: [text("input_text", "again")] })),
      ...Array.from({ length: 37 }, (_, n) => wrapped("response_item", { type: "function_call_output", call_id: "c", output: `result ${n}` })),
    ]);
    expect(counts(events).messages).toBe(2);
    expect(counts(events).results).toBe(37);
  });
  it("keeps Codex compaction replacement history and inter-agent content out of new human messages", async () => {
    const events = await project("codex", [
      wrapped("session_meta", { id: session, parent_thread_id: "parent", forked_from_id: "parent", subagent_history_start_ordinal: 9,
        source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: "child" } } } }),
      wrapped("compacted", { message: "summary", replacement_history: [{ type: "message", role: "user", content: [text("input_text", "inherited")] }] }),
      wrapped("response_item", { type: "agent_message", author: "child", recipient: "parent", content: [text("input_text", "agent reply"), { type: "encrypted_content", encrypted_content: "opaque" }] }),
    ]);
    expect(counts(events).messages).toBe(0);
    expect(events.filter(e => e.kind === "compaction")).toHaveLength(1);
    expect(events.filter(e => e.kind === "inter_agent")).toHaveLength(1);
  });
  it("groups all Claude assistant fragments while keeping thinking and tools distinct", async () => {
    const meta = { sessionId: session, timestamp };
    const events = await project("claude", [
      { ...meta, type: "assistant", uuid: "a1", parentUuid: "context", message: { id: "m", content: [{ type: "thinking", thinking: "thought", signature: "opaque" }] } },
      { ...meta, type: "assistant", uuid: "a2", parentUuid: "a1", message: { id: "m", content: [text("text", "reply")] } },
      { ...meta, type: "assistant", uuid: "a3", parentUuid: "a2", message: { id: "m", content: [{ type: "tool_use", id: "c", name: "synthetic", input: {} }] } },
      { ...meta, type: "user", uuid: "r", parentUuid: "a3", sourceToolAssistantUUID: "a3", message: { content: [{ type: "tool_result", tool_use_id: "c", content: "result", is_error: false }] } },
    ]);
    expect(counts(events)).toEqual({ messages: 1, calls: 1, results: 1, media: 0 });
    expect(events.filter(e => e.kind === "thinking")).toHaveLength(1);
    expect(events.filter(e => e.kind === "message").every(e => e.role === "assistant")).toBe(true);
  });
  it.each([["image", "image/png", "iVBORw0KGgo="], ["document", "application/pdf", "JVBERi0xLjQ="]])("finds nested Claude tool %s bytes", async (type, mime, data) => {
    const events = await project("claude", [
      { type: "assistant", sessionId: session, uuid: "a", message: { id: "m", content: [{ type: "tool_use", id: "c", name: "synthetic", input: {} }] } },
      { type: "user", sessionId: session, uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "c", content: [{ type, source: { type: "base64", media_type: mime, data } }] }] } },
    ]);
    expect(counts(events)).toEqual({ messages: 0, calls: 1, results: 1, media: 1 });
    expect(events.find(e => e.kind === "tool_result")).toMatchObject({ blocks: [{ kind: "media", encoding: "base64", mediaType: mime, data }] });
  });
  it("preserves Linux Claude compaction boundary and summary without inventing a new user turn", async () => {
    const events = await project("claude", [
      { type: "system", subtype: "compact_boundary", sessionId: session, uuid: "boundary", content: "Context compacted", compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 50 } },
      { type: "user", sessionId: session, uuid: "summary", isCompactSummary: true, message: { content: "retained summary" } },
    ]);
    expect(counts(events).messages).toBe(0);
    expect(events.filter(e => e.kind === "compaction").map(e => e.blocks)).toEqual([
      [{ kind: "text", text: "Context compacted" }], [{ kind: "text", text: "retained summary" }],
    ]);
  });
  it("retains interruption and API-error markers separately from ordinary prose", async () => {
    const codex = await project("codex", [wrapped("event_msg", { type: "turn_aborted", turn_id: "t" })]);
    expect(codex).toContainEqual(expect.objectContaining({ kind: "notice", outcome: "interrupted" }));
    const claude = await project("claude", [{ type: "assistant", uuid: "failure", sessionId: session,
      isApiErrorMessage: true, error: "private upstream failure", message: { id: "m", content: [text("text", "private upstream failure")] } }]);
    expect(counts(claude).messages).toBe(0);
    expect(claude).toContainEqual(expect.objectContaining({ kind: "notice", outcome: "failed" }));
    expect(JSON.stringify(claude)).not.toContain("private upstream failure");
  });
  it("keeps Claude agent task input in a separate child history", async () => {
    const events = await project("claude", [
      { type: "user", sessionId: session, agentId: "child", isSidechain: true, uuid: "u", parentUuid: null, message: { content: "agent task" } },
      { type: "assistant", sessionId: session, agentId: "child", isSidechain: true, uuid: "a", parentUuid: "u", message: { id: "m", content: [text("text", "agent reply")] } },
    ]);
    expect(counts(events).messages).toBe(2);
    expect(events.filter(e => e.kind === "message").every(e => e.conversation.agentId === "child")).toBe(true);
    expect(events.find(e => e.kind === "message")).toMatchObject({ origin: "agent_task" });
  });
});
