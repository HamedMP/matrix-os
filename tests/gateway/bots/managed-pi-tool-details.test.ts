import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { BotEventSchema, CanonicalChatRunActivitySchema, canonicalChatToolActivities, type BotEvent } from "@matrix-os/contracts";
import { createEventProjector } from "../../../packages/bot-runtime/src/events.js";
import { mapBotEvent } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { openToolOutput, openToolPreview } from "../../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
import { createOwnerToolOutputProjection } from "../../../packages/gateway/src/chat/owner-tool-output.js";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat.js";

const key = Buffer.alloc(32, 21);
const command = "printf managed-proof\nprintf next-line";
const args = { serverId: "12345678-1234-4234-8234-123456789abc", tool: "run_command", arguments: { command, cwd: "projects/demo", timeout: 10, token: "NEVER_SHOW_CREDENTIAL" } };
const result = (text: string) => ({ content: [{ type: "text", text }], details: { thinking: "NEVER_SHOW_REASONING" } });
async function project(events: AgentEvent[], signal?: AbortSignal) {
  const sent: BotEvent[] = []; let now = 0;
  const projector = createEventProjector({ send: async event => { sent.push(BotEventSchema.parse(event)); },
    capabilityForTool: name => name === "mcp_call" ? "mcp.call" : undefined, now: () => now, signal });
  for (const event of events) { now += 300; await projector(event); }
  await projector.drain(); projector.close();
  return sent;
}
const start = (input: Record<string, unknown> = args): AgentEvent => ({ type: "tool_execution_start", toolCallId: "call_1", toolName: "mcp_call", args: input });
const update = (text: string): AgentEvent => ({ type: "tool_execution_update", toolCallId: "call_1", toolName: "mcp_call", args, partialResult: result(text) });
const end = (text: string, isError = false): AgentEvent => ({ type: "tool_execution_end", toolCallId: "call_1", toolName: "mcp_call", result: result(text), isError });

describe("managed Pi display evidence", () => {
  it("unwraps broker-encoded MCP text without exposing internal fields and preserves the tool error status", async () => {
    const safeArgs = { ...args, arguments: { command } };
    const sent = await project([start(safeArgs), { type: "tool_execution_end", toolCallId: "call_1", toolName: "mcp_call", isError: false,
      result: { content: [{ type: "text", text: JSON.stringify({ content: [{ type: "text", text: "Command failed\nexit 2" }], isError: true,
        details: { thinking: "INTERNAL_REASONING" }, structuredContent: { body: "PRIVATE_BODY" } }) }] } }]);
    expect(sent.at(-1)?.event).toMatchObject({ phase: "failed", display: { output: "Command failed\nexit 2" } });
    expect(JSON.stringify(sent)).not.toMatch(/INTERNAL_REASONING|PRIVATE_BODY/);
  });

  it("announces that live tool sampling paused while retaining the last snapshot and final result", async () => {
    const sent = await project([start({ ...args, arguments: { command } }), update("one"), update("two"), update("three"), update("four"), end("final")]);
    expect(sent.some(item => item.event.type === "tool_progress" && item.event.display?.output?.includes("Live updates paused"))).toBe(true);
    expect(sent.at(-1)?.event).toMatchObject({ phase: "completed", display: { output: "final" } });
  });
  it("forwards selected input, live output and authoritative final text without raw objects or reasoning", async () => {
    const sent = await project([start({ ...args, arguments: { command, cwd: "projects/demo", timeout: 10 } }), update("working"), end("done")]);
    expect(sent.map(event => event.event)).toMatchObject([
      { type: "tool_progress", phase: "started", display: { name: "mcp_call", command, parameters: expect.stringContaining("cwd: projects/demo") } },
      { type: "tool_progress", phase: "updated", display: { output: "working" } },
      { type: "tool_progress", phase: "completed", display: { output: "done" } },
    ]);
    expect(JSON.stringify(sent)).not.toContain("NEVER_SHOW_REASONING");
    expect(JSON.stringify(sent)).not.toContain('"arguments"');
  });

  it("withholds sensitive context and binary/unknown results, distinguishes empty output and cancellation", async () => {
    const sensitive = await project([start(), end("NEVER_SHOW_CREDENTIAL")]);
    expect(JSON.stringify(sensitive)).not.toContain("NEVER_SHOW_CREDENTIAL");
    expect(sensitive.at(-1)?.event).toMatchObject({ display: { output: "Output withheld because it may contain private data." } });
    const empty = await project([start({ ...args, arguments: { command } }), end("")]);
    expect(empty.at(-1)?.event).toMatchObject({ display: { output: "No text result was returned." } });
    const controller = new AbortController(); controller.abort();
    const cancelled = await project([start(), end("stopped", true)], controller.signal);
    expect(cancelled.at(-1)?.event).toMatchObject({ phase: "cancelled" });
  });

  it("bounds snapshots and update count while retaining the terminal event", async () => {
    const sent = await project([start({ ...args, arguments: { command } }), ...Array.from({ length: 100 }, () => update("x".repeat(9000))), end("y".repeat(9000))]);
    expect(sent.length).toBeLessThanOrEqual(5);
    const final = sent.at(-1)!.event;
    expect(final).toMatchObject({ phase: "completed", display: { truncated: true } });
    expect((final as any).display.output.length).toBeLessThanOrEqual(3000);
  });

  it("seals managed command/parameters/output before canonical persistence and preserves one card through reload", async () => {
    const sent = await project([start({ ...args, arguments: { command, cwd: "projects/demo" } }), update("STALE_PARTIAL"), end("FINAL_OWNER_RESULT")]);
    const mapped = sent.flatMap(item => mapBotEvent(item.event, { toolOutputKey: key }));
    expect(mapped.filter(event => event.type === "agent.activity")).toHaveLength(3);
    expect(mapped.filter(event => event.type === "agent.activity").every(event => event.activityId === "call_1")).toBe(true);
    const initial = mapped.find(event => event.type === "agent.activity")! as any;
    expect(openToolPreview(key, "call_1", initial.protectedPreview)).toBe(command);
    expect(JSON.stringify(mapped)).not.toContain("FINAL_OWNER_RESULT");
    expect(JSON.stringify(mapped)).not.toContain("projects/demo");
    const output = mapped.filter(event => event.type === "tool.output").at(-1)! as any;
    expect(openToolOutput(key, "call_1", output.protectedOutput)).toContain("FINAL_OWNER_RESULT");

    const { snapshot } = createCanonicalChatFixture("completed"); const run = snapshot.runs[0]!;
    run.driverKind = "matrix_pi";
    const owner = snapshot.chat.ownerScope;
    const activities = mapped.map((event, index) => CanonicalChatRunActivitySchema.parse({ ...event,
      id: `activity_${index}`, chatId: snapshot.chat.id, runId: run.id, occurredAt: run.createdAt, sequence: index + 1 }));
    const stored = { record: { chat: snapshot.chat }, activities };
    const projection = createOwnerToolOutputProjection(key, [owner.ownerId]);
    const revealed = projection(owner, JSON.parse(JSON.stringify(stored)));
    const detail = { ...snapshot, record: revealed.record, activities: revealed.activities!, queuedTurns: [] };
    const shared = { ...stored, record: { chat: { ...snapshot.chat, collaboration: { mode: "shared" as const, membership: { role: "owner" as const, memberCount: 2 } } } } };
    expect(JSON.stringify(projection(owner, shared))).not.toContain("FINAL_OWNER_RESULT");
    expect(JSON.stringify(projection({ type: "personal", ownerId: "wrong" }, stored))).not.toContain("FINAL_OWNER_RESULT");
    const lists = [canonicalChatToolActivities(run, revealed.activities!)];
    for (const list of lists) {
      const cards = list.filter(activity => activity.label === "Run command");
      expect(cards).toHaveLength(1);
      expect(cards[0]?.detail).toContain("FINAL_OWNER_RESULT");
      expect(cards[0]?.detail).not.toContain("STALE_PARTIAL");
      expect(cards[0]?.detail).toContain("cwd: projects/demo");
      expect(cards[0]?.preview).toBe(command);
    }
  });

  it("accepts old progress and degrades new details without a key to coarse notices", async () => {
    expect(mapBotEvent({ type: "tool_progress", toolCallId: "old_call", capability: "artifact.read", phase: "completed" })).toEqual([
      { type: "tool.progress", toolCallId: "old_call", label: "Reading a file", status: "completed" },
    ]);
    const sent = await project([start({ ...args, arguments: { command } }), end("OPAQUE_OWNER_TEXT")]);
    const mapped = sent.flatMap(item => mapBotEvent(item.event));
    expect(JSON.stringify(mapped)).not.toContain("OPAQUE_OWNER_TEXT");
    expect(JSON.stringify(mapped)).not.toContain("protectedOutput");
  });
});

import { vi } from "vitest";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";

it.each(["completed", "failed", "cancelled"] as const)("retains the managed tool's %s result after many live text updates", async status => {
  const snapshot = makeAiProviderSnapshot();
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: "owner_boundary", chatId: "chat_boundary", runId: "run_boundary",
    runtimeHandle: `runtime_${"b".repeat(32)}`, executionGeneration: "1", workspace: { kind: "chat_workspace" }, rootFingerprint: "b".repeat(64),
    ...resolveManagedPiRoute(snapshot, selection), capabilities: ["mcp.call"], requestClass: "interactive" };
  const controller = new AbortController();
  const toolController = new AbortController();
  if (status === "cancelled") toolController.abort();
  const partial = fauxAssistantMessage(fauxText(""));
  let workerEvents: BotEvent[] = [];
  const host = { client: { runBot: vi.fn(async (input: { command: { kind: string } }) => {
    if (input.command.kind !== "bot.run") return { ok: true, reply: { acknowledged: true } };
    const deltas: AgentEvent[] = Array.from({ length: 1998 }, () => ({ type: "message_update", message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial } }));
    workerEvents = await project([...deltas, start({ ...args, arguments: { command } }), end("BOUNDARY_FINAL", status === "failed")], toolController.signal);
    for (const event of workerEvents) await runtime.events.publish(binding, event);
    if (status === "cancelled") controller.abort();
    return { ok: true, reply: { runId: binding.runId, status, toolActions: 1 } };
  }) } } as unknown as ScopeRuntimeHost;
  const runtime = createManagedPiRuntime({ toolOutputKey: key, admission: { admit: async () => binding,
    release: async () => undefined, toolAuthority: async () => ({ permissionMode: "full_access" }), workspace: async () => "/owned/chat" },
    host, providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal, forgetRun: () => undefined, cancelInference: () => undefined });
  const events = [];
  for await (const event of runtime.adapter.start({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId,
    turnId: "cturn_boundary", runId: binding.runId, prompt: "show details", parts: [{ type: "text", text: "show details" }], selection,
    interactionMode: "default", permissionMode: "full_access", signal: controller.signal })) events.push(event);
  const outputs = events.filter(event => event.type === "tool.output");
  expect(outputs.at(-1)).toBeDefined();
  expect(openToolOutput(key, "call_1", outputs.at(-1)!.protectedOutput)).toContain("BOUNDARY_FINAL");
  expect(events.filter(event => event.type === "agent.activity").at(-1)).toMatchObject({ activityId: "call_1", status });
  expect(workerEvents.flatMap(frame => frame.event.type === "assistant_delta" ? [frame.event.text] : []).join("")).toBe("x".repeat(1998));
  expect(workerEvents.every((event, index) => event.seq === index)).toBe(true);
  expect(workerEvents.slice(-2)).toMatchObject([
    { seq: workerEvents.length - 2, event: { type: "tool_progress", phase: "started" } },
    { seq: workerEvents.length - 1, event: { type: "tool_progress", phase: status } },
  ]);
});

it.each(["failed", "cancelled", "completed"] as const)("closes an outstanding managed tool when the worker ends %s without a tool end", async status => {
  const snapshot = makeAiProviderSnapshot();
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: "owner_display", chatId: "chat_display", runId: "run_display",
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", workspace: { kind: "chat_workspace" }, rootFingerprint: "a".repeat(64),
    ...resolveManagedPiRoute(snapshot, selection), capabilities: ["mcp.call"], requestClass: "interactive" };
  const controller = new AbortController();
  const host = { client: { runBot: vi.fn(async (input: { command: { kind: string } }) => {
    if (input.command.kind !== "bot.run") return { ok: true, reply: { acknowledged: true } };
    const events = await project([start({ ...args, arguments: { command } }), update("partial before stop")]);
    for (const event of events) await runtime.events.publish(binding, event);
    if (status === "cancelled") controller.abort();
    return { ok: true, reply: { runId: binding.runId, status, toolActions: 1 } };
  }) } } as unknown as ScopeRuntimeHost;
  const runtime = createManagedPiRuntime({ toolOutputKey: key, admission: { admit: async () => binding,
    release: async () => undefined, toolAuthority: async () => ({ permissionMode: "full_access" }), workspace: async () => "/owned/chat" },
    host, providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal, forgetRun: () => undefined, cancelInference: () => undefined });
  const events = [];
  for await (const event of runtime.adapter.start({ owner: { type: "personal", ownerId: binding.ownerId }, chatId: binding.chatId,
    turnId: "cturn_display", runId: binding.runId, prompt: "show details", parts: [{ type: "text", text: "show details" }], selection,
    interactionMode: "default", permissionMode: "full_access", signal: controller.signal })) events.push(event);
  expect(events.filter(event => event.type === "agent.activity").at(-1)).toMatchObject({ activityId: "call_1", status: status === "completed" ? "running" : status });
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: status === "cancelled" ? "aborted" : status });
});

it.each(["/home/alice/project", "authorization"])("keeps safe output when an optional working directory needs filtering (%s)", async cwd => {
  const sent = await project([start({ ...args, arguments: { command: "printf proof", cwd } }), end("SAFE_FINAL_PROOF")]);
  const mapped = sent.flatMap(item => mapBotEvent(item.event, { toolOutputKey: key }));
  const output = mapped.filter(event => event.type === "tool.output").at(-1)!;
  expect(output.type).toBe("tool.output");
  if (output.type !== "tool.output") throw new Error("Expected output");
  const revealed = openToolOutput(key, "call_1", output.protectedOutput);
  expect(revealed).toContain("SAFE_FINAL_PROOF");
  expect(revealed).not.toContain("/home/alice/project");
});
