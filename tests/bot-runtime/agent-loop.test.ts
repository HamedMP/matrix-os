import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { BotEvent, BotRunCommand, BotToolRequest, BotToolResult } from "@matrix-os/contracts";
import { BotBrokerError, type BotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { runBotTurn, type BotTurnControl } from "../../packages/bot-runtime/src/loop.js";

function scripted(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const handle = fauxProvider({ models: [{ id: "faux-bot", input: ["text", "image"], contextWindow: 128_000, maxTokens: 4_096 }] });
  handle.setResponses(responses);
  return { handle, route: { provider: handle.provider, model: handle.getModel() } };
}

function memoryBroker(options: {
  messages?: Record<string, unknown>[];
  load?: () => Promise<{ revision: number; messages: Record<string, unknown>[] }>;
  tool?: (request: BotToolRequest) => Promise<BotToolResult>;
  event?: (event: BotEvent) => Promise<void>;
  save?: () => Promise<{ revision: number }>;
} = {}) {
  const events: BotEvent[] = [];
  const tools: BotToolRequest[] = [];
  const saves: Array<{ baseRevision: number; messages: Record<string, unknown>[] }> = [];
  const broker: BotBrokerClient = {
    loadSession: vi.fn(async () => (options.load ? options.load() : { revision: 3, messages: options.messages ?? [] })),
    saveSession: vi.fn(async (session) => {
      saves.push(session);
      return options.save ? options.save() : { revision: 4 };
    }),
    tool: vi.fn(async (request) => {
      tools.push(request);
      return options.tool ? options.tool(request) : { ok: true, content: [{ type: "text", text: "ok" }] };
    }),
    event: vi.fn(async (event) => {
      events.push(event);
      if (options.event) await options.event(event);
    }),
  };
  return { broker, events, tools, saves };
}

function command(overrides: Partial<BotRunCommand> = {}): BotRunCommand {
  return {
    version: 1,
    kind: "bot.run",
    runId: "run_turn1",
    route: { api: "anthropic-messages", modelId: "faux-bot", input: ["text", "image"], contextWindow: 128_000, maxOutputTokens: 4_096 },
    systemPrompt: "You are Research Rabbit.",
    capabilities: ["artifact.write", "artifact.read", "interaction.create", "integration.inventory"],
    limits: { maxToolActions: 60 },
    turn: { kind: "prompt", text: "Write the Acme brief." },
    ...overrides,
  };
}

const run = (input: {
  command?: BotRunCommand;
  broker: BotBrokerClient;
  route: ReturnType<typeof scripted>["route"];
  signal?: AbortSignal;
  onControl?: (control: BotTurnControl) => void;
  onAgent?: Parameters<typeof runBotTurn>[0]["onAgent"];
}) => runBotTurn({
  command: input.command ?? command(), broker: input.broker, bridgeOrigin: "http://127.0.0.1:41000", route: input.route,
  signal: input.signal, now: () => 1_000, onControl: input.onControl, onAgent: input.onAgent,
});

describe("bot agent loop", () => {
  it("runs a tool through the broker, forwards ordered events, and saves the session at its base revision", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("write_artifact", { path: "briefs/acme.md", content: "# Acme", mimeType: "text/markdown" }, { id: "call_write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Saved the brief.")),
    ]);
    const { broker, events, tools, saves } = memoryBroker();

    const outcome = await run({ broker, route });

    expect(outcome).toEqual({ runId: "run_turn1", status: "completed", sessionRevision: 4, toolActions: 1 });
    expect(tools).toEqual([{ toolCallId: "call_write", capability: "artifact.write", args: { relPath: "briefs/acme.md", content: "# Acme", mimeType: "text/markdown" } }]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
    expect(events.filter((event) => event.event.type === "tool_progress").map((event) => event.event))
      .toEqual([
        { type: "tool_progress", toolCallId: "call_write", capability: "artifact.write", phase: "started" },
        { type: "tool_progress", toolCallId: "call_write", capability: "artifact.write", phase: "completed" },
      ]);
    expect(events.flatMap((event) => event.event.type === "assistant_delta" ? [event.event.text] : []).join("")).toBe("Saved the brief.");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.baseRevision).toBe(3);
    expect(saves[0]!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
  });

  it("ends the turn waiting for the person after a blocking question", async () => {
    const { handle, route } = scripted([
      fauxAssistantMessage(fauxToolCall("ask_person", { header: "Competitor", question: "Which company?", options: ["Acme", "Globex"], blocking: true }, { id: "call_ask" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("This must not be generated.")),
    ]);
    const { broker, tools } = memoryBroker();

    const outcome = await run({ broker, route });

    expect(outcome.status).toBe("waiting_person");
    expect(tools[0]).toMatchObject({ capability: "interaction.create", args: { blocking: true, payload: { kind: "question" } } });
    expect(handle.getPendingResponseCount()).toBe(1);
  });

  it("blocks tool calls past the action budget and reports the block", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "a.md" }, { id: "call_1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "b.md" }, { id: "call_2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const { broker, tools } = memoryBroker();

    const outcome = await run({ broker, route, command: command({ limits: { maxToolActions: 1 } }) });

    expect(outcome).toMatchObject({ status: "blocked", blockedReason: "budget_exhausted", toolActions: 1 });
    expect(tools).toHaveLength(1);
  });

  it("turns broker refusals into model guidance without internal detail", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("integration_inventory", {}, { id: "call_inv" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("I need access first.")),
    ]);
    const { broker, saves } = memoryBroker({ tool: async () => { throw new BotBrokerError("not_granted"); } });

    const outcome = await run({ broker, route });

    expect(outcome.status).toBe("completed");
    const toolResult = saves[0]!.messages.find((message) => message.role === "toolResult")!;
    expect(JSON.stringify(toolResult)).toContain("This bot does not have access for that yet.");
    expect(JSON.stringify(toolResult)).not.toContain("BotBrokerError");
  });

  it("rebuilds the system prompt from this run instead of the stored session", async () => {
    const { route } = scripted([fauxAssistantMessage(fauxText("Hello again."))]);
    const { broker, saves } = memoryBroker({ messages: [
      { role: "system", content: "OLD PROMPT", timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ] });

    await run({ broker, route });

    expect(JSON.stringify(saves[0]!.messages)).not.toContain("OLD PROMPT");
    expect(JSON.stringify(saves[0]!.messages[0])).toContain("You are Research Rabbit.");
  });

  it("reports an uncertain run when cancelled during a tool call and a clean cancel otherwise", async () => {
    const controller = new AbortController();
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "a.md" }, { id: "call_1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("unreachable")),
    ]);
    // The broker is still working when the run is cancelled, so the effect is unknown.
    const { broker } = memoryBroker({ tool: async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, content: [{ type: "text", text: "late" }] };
    } });
    await expect(run({ broker, route, signal: controller.signal })).resolves.toMatchObject({ status: "uncertain" });

    const early = new AbortController();
    early.abort();
    const second = scripted([fauxAssistantMessage(fauxText("unreachable"))]);
    await expect(run({ broker: memoryBroker().broker, route: second.route, signal: early.signal })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("fails the run when events cannot be delivered or the session cannot be saved", async () => {
    const eventRoute = scripted([fauxAssistantMessage(fauxText("hello"))]).route;
    const failingEvents = memoryBroker({ event: async () => { throw new BotBrokerError("stale_generation"); } });
    await expect(run({ broker: failingEvents.broker, route: eventRoute })).resolves.toMatchObject({ status: "failed", failureCode: "stale_generation" });

    const saveRoute = scripted([fauxAssistantMessage(fauxText("hello"))]).route;
    const failingSave = memoryBroker({ save: async () => { throw new BotBrokerError("unavailable"); } });
    await expect(run({ broker: failingSave.broker, route: saveRoute })).resolves.toEqual({
      runId: "run_turn1", status: "failed", failureCode: "unavailable", sessionRevision: 3, toolActions: 0,
    });
  });

  it("returns a failed outcome without a revision when the session cannot be loaded", async () => {
    const { route } = scripted([fauxAssistantMessage(fauxText("unreachable"))]);
    const down = memoryBroker({ load: async () => { throw new BotBrokerError("timeout"); } });
    await expect(run({ broker: down.broker, route })).resolves.toEqual({ runId: "run_turn1", status: "failed", failureCode: "timeout", toolActions: 0 });
    const corrupt = memoryBroker({ load: async () => ({ revision: 2, messages: [{ role: "tool", content: "x", timestamp: 1 }] }) });
    await expect(run({ broker: corrupt.broker, route })).resolves.toEqual({ runId: "run_turn1", status: "failed", failureCode: "unavailable", toolActions: 0 });
    expect(corrupt.saves).toEqual([]);
  });

  it("keeps an uncertain status when the transcript cannot be saved afterwards", async () => {
    const controller = new AbortController();
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("read_artifact", { path: "a.md" }, { id: "call_1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("unreachable")),
    ]);
    const { broker } = memoryBroker({
      tool: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, content: [{ type: "text", text: "late" }] };
      },
      save: async () => { throw new BotBrokerError("unavailable"); },
    });
    await expect(run({ broker, route, signal: controller.signal })).resolves.toEqual({
      runId: "run_turn1", status: "uncertain", failureCode: "unavailable", sessionRevision: 3, toolActions: 1,
    });
  });

  it("saves an image turn with a placeholder instead of the image bytes", async () => {
    const { route } = scripted([fauxAssistantMessage(fauxText("A red square."))]);
    const { broker, saves } = memoryBroker();
    const image = { mimeType: "image/png" as const, data: "A".repeat(2_000_000) };
    const outcome = await run({ broker, route, command: command({ turn: { kind: "prompt", text: "What is this?", images: [image] } }) });
    expect(outcome).toMatchObject({ status: "completed", sessionRevision: 4 });
    expect(JSON.stringify(saves[0]!.messages)).not.toContain("AAAA");
    expect(JSON.stringify(saves[0]!.messages)).toContain("not kept in saved history");
  });

  it("answers a steer that arrives as the agent finishes and refuses steers once the turn closes", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxText("First answer.")),
      fauxAssistantMessage(fauxText("Shorter answer.")),
    ]);
    let control!: BotTurnControl;
    let steeredAtEnd = false;
    let lateSteer: boolean | undefined;
    const { broker, saves } = memoryBroker({ save: async () => { lateSteer = control.steer("too late"); return { revision: 4 }; } });
    const outcome = await run({
      broker, route,
      onControl: (value) => { control = value; },
      onAgent: (agent) => agent.subscribe((event) => {
        if (event.type === "agent_end" && !steeredAtEnd) {
          steeredAtEnd = true;
          expect(control.steer("make it shorter")).toBe(true);
        }
      }),
    });
    expect(outcome.status).toBe("completed");
    expect(lateSteer).toBe(false);
    const saved = JSON.stringify(saves[0]!.messages);
    expect(saved).toContain("make it shorter");
    expect(saved).toContain("Shorter answer.");
    expect(saved).not.toContain("too late");
    expect(saved.split("make it shorter")).toHaveLength(2);
  });

  it("saves an accepted steer as a person message when the turn stops before answering it", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("ask_person", { header: "Company", question: "Which one?", blocking: true }, { id: "call_ask" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("unreachable")),
    ]);
    let control!: BotTurnControl;
    const { broker, saves } = memoryBroker({ tool: async () => {
      expect(control.steer("Acme, please")).toBe(true);
      return { ok: true, content: [{ type: "text", text: "asked" }] };
    } });
    const outcome = await run({ broker, route, onControl: (value) => { control = value; } });
    expect(outcome.status).toBe("waiting_person");
    expect(saves[0]!.messages.at(-1)).toMatchObject({ role: "user", content: "Acme, please" });
  });

  it("advertises the broker's argument rules and names fields the broker would still refuse", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxToolCall("remember", { kind: "fact", content: "Acme uses Stripe", sourceUrl: "http://acme.test/pricing" }, { id: "call_mem" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("integration_call", { service: "gmail", action: "send..draft", connectionId: "conn_1", params: {} }, { id: "call_int" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("ok")),
    ]);
    const { broker, tools, saves } = memoryBroker();
    await run({ broker, route, command: command({ capabilities: ["memory.propose", "integration.call"] }) });
    expect(tools).toEqual([]);
    const results = saves[0]!.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message));
    // The advertised schema already rejects a non-HTTPS source.
    expect(results[0]).toContain("sourceUrl");
    // Rules the tool schema cannot express are checked locally with a field-only hint.
    expect(results[1]).toContain("Fix: action.");
  });

  it("summarizes earlier turns instead of dropping them when a short session is too large to save", async () => {
    const { route } = scripted([
      fauxAssistantMessage(fauxText("Here is the fourth answer.")),
      fauxAssistantMessage(fauxText("Earlier: the person asked for three long Acme reports and prefers tables.")),
    ]);
    const history = [1, 2, 3].flatMap((turn) => [
      { role: "user", content: `Report ${turn}, please.`, timestamp: turn * 10 },
      // Just under the load cap, so the new turn pushes it past the storage target.
      { ...fauxAssistantMessage(fauxText("r".repeat(166 * 1024))), timestamp: turn * 10 + 1 },
    ]);
    const { broker, saves } = memoryBroker({ messages: history as unknown as Record<string, unknown>[] });

    const outcome = await run({ broker, route, command: command({ capabilities: [], turn: { kind: "prompt", text: "And a fourth?" } }) });

    expect(outcome).toMatchObject({ status: "completed", sessionRevision: 4 });
    const saved = JSON.stringify(saves[0]!.messages);
    expect(saved).toContain("prefers tables");
    expect(saved).toContain("And a fourth?");
    expect(saved).not.toContain("removed to fit saved history");
    expect(saved.length).toBeLessThan(512 * 1024);
  });

  it("still saves the turn when the optional summary call fails or the run was cancelled", async () => {
    const history = [1, 2, 3].flatMap((turn) => [
      { role: "user", content: `Report ${turn}, please.`, timestamp: turn * 10 },
      { ...fauxAssistantMessage(fauxText("r".repeat(166 * 1024))), timestamp: turn * 10 + 1 },
    ]) as unknown as Record<string, unknown>[];

    const failing = scripted([
      fauxAssistantMessage(fauxText("Here is the fourth answer.")),
      fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "provider overloaded" }),
    ]);
    const saved = memoryBroker({ messages: history });
    const outcome = await run({ broker: saved.broker, route: failing.route, command: command({ capabilities: [], turn: { kind: "prompt", text: "And a fourth?" } }) });
    expect(outcome).toMatchObject({ status: "completed", sessionRevision: 4 });
    expect(JSON.stringify(saved.saves[0]!.messages)).toContain("And a fourth?");

    const cancelled = scripted([fauxAssistantMessage(fauxText("summary that must not be requested"))]);
    const early = new AbortController();
    early.abort();
    const cancelledBroker = memoryBroker({ messages: history });
    await expect(run({ broker: cancelledBroker.broker, route: cancelled.route, signal: early.signal }))
      .resolves.toEqual({ runId: "run_turn1", status: "cancelled", sessionRevision: 3, toolActions: 0 });
    // A run cancelled before it starts makes no model call and saves nothing.
    expect(cancelled.handle.getPendingResponseCount()).toBe(1);
    expect(cancelledBroker.saves).toEqual([]);
  });
});
