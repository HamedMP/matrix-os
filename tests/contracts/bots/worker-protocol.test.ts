import { describe, expect, it } from "vitest";
import { BotBrokerRequestSchema, BotBrokerResponseSchema, BotRunOutcomeSchema, BotWorkerCommandSchema } from "@matrix-os/contracts";

const envelope = {
  version: 1, requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle: `runtime_${"b".repeat(32)}`,
  executionGeneration: "2", runId: "run_abc",
};
const run = {
  version: 1, kind: "bot.run", runId: "run_abc",
  route: { api: "openai-completions", modelId: "@cf/zai-org/glm-5.3-flash", input: ["text", "image"], contextWindow: 128_000, maxOutputTokens: 16_384 },
  systemPrompt: "You are Research Rabbit.", capabilities: ["artifact.write"], limits: { maxToolActions: 60 },
  turn: { kind: "prompt", text: "hello" },
};

describe("bot worker and broker envelopes", () => {
  it("accepts gateway-resolved routes and bounded run commands", () => {
    expect(BotWorkerCommandSchema.parse(run).kind).toBe("bot.run");
    expect(BotWorkerCommandSchema.safeParse({ ...run, route: { ...run.route, maxOutputTokens: 32_000 } }).success).toBe(false);
    expect(BotWorkerCommandSchema.safeParse({ ...run, route: { ...run.route, input: ["image"] } }).success).toBe(false);
    expect(BotWorkerCommandSchema.safeParse({ ...run, capabilities: ["artifact.write", "artifact.write"] }).success).toBe(false);
    expect(BotWorkerCommandSchema.safeParse({ ...run, limits: { maxToolActions: 61 } }).success).toBe(false);
    expect(BotWorkerCommandSchema.safeParse({ ...run, baseUrl: "https://api.example.com" }).success).toBe(false);
    expect(BotWorkerCommandSchema.parse({ version: 1, kind: "bot.cancel", runId: "run_abc" }).kind).toBe("bot.cancel");
  });

  it("frames bot broker actions with the workload identity and rejects unknown actions", () => {
    expect(BotBrokerRequestSchema.parse({ ...envelope, action: "bot.session.load" }).action).toBe("bot.session.load");
    expect(BotBrokerRequestSchema.parse({ ...envelope, action: "bot.event", event: { seq: 0, event: { type: "assistant_delta", text: "hi" } } }).action).toBe("bot.event");
    expect(BotBrokerRequestSchema.safeParse({ ...envelope, action: "egress.fetch" }).success).toBe(false);
    const session = (bytes: number) => ({ ...envelope, action: "bot.session.save", session: { baseRevision: 1, messages: [{ role: "user", content: "x".repeat(bytes), timestamp: 1 }] } });
    expect(BotBrokerRequestSchema.safeParse(session(400 * 1024)).success).toBe(true);
    expect(BotBrokerRequestSchema.safeParse(session(520 * 1024)).success).toBe(false);
    expect(BotBrokerRequestSchema.safeParse({ ...envelope, action: "bot.session.load", runtimeHandle: "runtime_x" }).success).toBe(false);
    expect(BotBrokerResponseSchema.safeParse({ version: 1, requestId: envelope.requestId, ok: false, code: "postgres_down" }).success).toBe(false);
  });

  it("reports outcomes with allowlisted statuses only", () => {
    expect(BotRunOutcomeSchema.parse({ runId: "run_abc", status: "waiting_person", sessionRevision: 2, toolActions: 1 }).status).toBe("waiting_person");
    expect(BotRunOutcomeSchema.safeParse({ runId: "run_abc", status: "paused", sessionRevision: 2, toolActions: 1 }).success).toBe(false);
    // A run whose session never loaded reports no revision.
    expect(BotRunOutcomeSchema.parse({ runId: "run_abc", status: "failed", failureCode: "unavailable", toolActions: 0 }).sessionRevision).toBeUndefined();
  });
});
