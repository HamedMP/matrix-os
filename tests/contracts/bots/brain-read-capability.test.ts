import { describe, expect, it } from "vitest";
import {
  BotRunSpecSchema,
  BotThreadListQuerySchema,
  BotToolRequestSchema,
  CreateBotThreadRequestSchema,
} from "@matrix-os/contracts";

const read = (args: Record<string, unknown>) => ({ toolCallId: "call_brain1", capability: "brain.read", args });
const spec = {
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
  systemPrompt: "You are Company Brain.", capabilities: ["brain.read"], limits: { maxToolActions: 6 },
  turn: { kind: "prompt", text: "What changed this week?" },
};

describe("brain read bot capability", () => {
  it("accepts the six read views with a bounded input and an optional project", () => {
    for (const tool of ["search", "why", "timeline", "claims", "brief", "conflicts"]) {
      expect(BotToolRequestSchema.safeParse(read({ tool, input: {} })).success).toBe(true);
    }
    expect(BotToolRequestSchema.parse(read({ tool: "search", project: "matrix-os", input: { query: "bot chats" } })))
      .toMatchObject({ capability: "brain.read", args: { project: "matrix-os" } });
    expect(BotToolRequestSchema.safeParse(read({ tool: "why", project: "proj_abc123", input: { path: "src/" } })).success).toBe(true);
  });

  it("refuses impact, unknown tools, extra fields, bad projects and inputs over 4 KiB", () => {
    expect(BotToolRequestSchema.safeParse(read({ tool: "impact", input: { head: "main" } })).success).toBe(false);
    expect(BotToolRequestSchema.safeParse(read({ tool: "write", input: {} })).success).toBe(false);
    expect(BotToolRequestSchema.safeParse(read({ tool: "search", input: {}, owner: "user_other" })).success).toBe(false);
    expect(BotToolRequestSchema.safeParse(read({ tool: "search", input: {}, project: "../etc" })).success).toBe(false);
    expect(BotToolRequestSchema.safeParse(read({ tool: "search", input: [] })).success).toBe(false);
    expect(BotToolRequestSchema.safeParse(read({ tool: "search", input: { query: "x".repeat(4_000) } })).success).toBe(true);
    expect(BotToolRequestSchema.safeParse(read({ tool: "search", input: { query: "x".repeat(4_100) } })).success).toBe(false);
  });
});

describe("bot run effort", () => {
  it("is optional and limited to low, medium and high", () => {
    expect(BotRunSpecSchema.parse(spec).limits).toEqual({ maxToolActions: 6 });
    expect(BotRunSpecSchema.parse({ ...spec, limits: { maxToolActions: 6, effort: "low" } }).limits.effort).toBe("low");
    expect(BotRunSpecSchema.safeParse({ ...spec, limits: { maxToolActions: 6, effort: "max" } }).success).toBe(false);
    expect(BotRunSpecSchema.safeParse({ ...spec, limits: { maxToolActions: 6, effort: "disabled" } }).success).toBe(false);
  });
});

describe("bot thread requests", () => {
  it("creates a thread for one project with an optional short title", () => {
    expect(CreateBotThreadRequestSchema.parse({ clientRequestId: "req_thread1", projectId: "proj_abc" })).toEqual({
      clientRequestId: "req_thread1", projectId: "proj_abc",
    });
    expect(CreateBotThreadRequestSchema.safeParse({ clientRequestId: "req_thread1", projectId: "proj_abc", title: "Why bot chats" }).success).toBe(true);
    expect(CreateBotThreadRequestSchema.safeParse({ clientRequestId: "req_thread1", projectId: "matrix-os" }).success).toBe(false);
    expect(CreateBotThreadRequestSchema.safeParse({ clientRequestId: "thread1", projectId: "proj_abc" }).success).toBe(false);
    expect(CreateBotThreadRequestSchema.safeParse({ clientRequestId: "req_thread1", projectId: "proj_abc", title: "x".repeat(121) }).success).toBe(false);
    expect(CreateBotThreadRequestSchema.safeParse({ clientRequestId: "req_thread1", projectId: "proj_abc", selection: {} }).success).toBe(false);
  });

  it("lists one project's threads in pages of up to 100", () => {
    expect(BotThreadListQuerySchema.parse({ projectId: "proj_abc" })).toEqual({ projectId: "proj_abc", limit: 50 });
    expect(BotThreadListQuerySchema.parse({ projectId: "proj_abc", limit: "100" }).limit).toBe(100);
    expect(BotThreadListQuerySchema.safeParse({ projectId: "proj_abc", limit: "101" }).success).toBe(false);
    expect(BotThreadListQuerySchema.safeParse({ limit: "10" }).success).toBe(false);
    expect(BotThreadListQuerySchema.safeParse({ projectId: "proj_abc", cursor: "not-a-cursor" }).success).toBe(false);
  });
});
