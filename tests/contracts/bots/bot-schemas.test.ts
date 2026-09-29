import { describe, expect, it } from "vitest";
import {
  BotAuthorityViewSchema,
  BotGrantSchema,
  BotInteractionPayloadSchema,
  BotInteractionSchema,
  BotMemoryItemSchema,
  BotMemoryMutationRequestSchema,
  BotTaskSummarySchema,
  InstantiateBotRequestSchema,
  InstantiateBotResponseSchema,
  ResolveBotInteractionRequestSchema,
  ResolveBotInteractionResponseSchema,
  RevokeBotGrantResponseSchema,
} from "@matrix-os/contracts";

const now = "2026-09-27T12:00:00.000Z";
const question = {
  kind: "question",
  questions: [{ questionId: "competitor", header: "Competitor", question: "Which company should I watch first?" }],
};

describe("bot instantiation contracts", () => {
  it("accepts a recipe reference with a request id and an optional safe name", () => {
    const request = { clientRequestId: "req_create_bot_1", recipe: { recipeId: "competitor-watching", version: "2026-09-26" } };
    expect(InstantiateBotRequestSchema.parse(request)).toEqual(request);
    expect(InstantiateBotRequestSchema.parse({ ...request, name: "Research Rabbit" }).name).toBe("Research Rabbit");
  });

  it("rejects client-chosen identifiers, unknown keys, and unsafe names", () => {
    const base = { clientRequestId: "req_create_bot_1", recipe: { recipeId: "competitor-watching", version: "1" } };
    expect(InstantiateBotRequestSchema.safeParse({ ...base, agentId: "bot_chosenbyclient" }).success).toBe(false);
    expect(InstantiateBotRequestSchema.safeParse({ ...base, chatId: "chat_chosen" }).success).toBe(false);
    expect(InstantiateBotRequestSchema.safeParse({ ...base, name: "see /home/matrix/secret" }).success).toBe(false);
    expect(InstantiateBotRequestSchema.safeParse({ ...base, recipe: { recipeId: "../etc", version: "1" } }).success).toBe(false);
    expect(InstantiateBotRequestSchema.safeParse({ ...base, clientRequestId: "not-a-request-id" }).success).toBe(false);
  });

  it("returns the created bot, its direct chat, and whether the request was replayed", () => {
    const response = {
      agent: { id: "bot_research1", name: "Research Rabbit", avatarSeed: "a1b2c3d4e5f60718", revision: 1, status: "active" },
      chatId: "chat_research",
      operation: "created",
    };
    expect(InstantiateBotResponseSchema.parse(response)).toEqual(response);
    expect(InstantiateBotResponseSchema.safeParse({ ...response, operation: "updated" }).success).toBe(false);
    expect(InstantiateBotResponseSchema.safeParse({ ...response, agent: { ...response.agent, avatarSeed: "XYZ" } }).success).toBe(false);
  });
});

describe("bot interaction contracts", () => {
  it("accepts each interaction payload kind within its bounds", () => {
    expect(BotInteractionPayloadSchema.parse(question).kind).toBe("question");
    expect(BotInteractionPayloadSchema.parse({
      kind: "account_choice",
      service: "gmail",
      options: [{ connectionId: "conn_1", label: "Work" }, { connectionId: "conn_2", label: "Personal" }],
    }).kind).toBe("account_choice");
    expect(BotInteractionPayloadSchema.parse({
      kind: "connect_request",
      service: "google_calendar",
      access: ["read"],
      benefit: "I can check when your next meeting is.",
      connectRequestId: "cr_abcdefgh",
    }).kind).toBe("connect_request");
    expect(BotInteractionPayloadSchema.parse({
      kind: "approval",
      tool: "gmail.send",
      argsDigest: "b".repeat(64),
      account: { service: "gmail", label: "Work" },
      audience: "direct",
      preview: "Send the brief to test@example.com",
      policyRevision: 3,
    }).kind).toBe("approval");
  });

  it("rejects empty account choices, duplicates, or free-text accounts", () => {
    const choice = { kind: "account_choice", service: "gmail", options: [{ connectionId: "conn_1", label: "Work" }] };
    expect(BotInteractionPayloadSchema.safeParse({ ...choice, options: [] }).success).toBe(false);
    expect(BotInteractionPayloadSchema.safeParse(choice).success).toBe(true);
    expect(BotInteractionPayloadSchema.safeParse({
      ...choice,
      options: [{ connectionId: "conn_1", label: "Work" }, { connectionId: "conn_1", label: "Also work" }],
    }).success).toBe(false);
    expect(BotInteractionPayloadSchema.safeParse({ ...choice, options: [{ label: "typed" }, { label: "typed 2" }] }).success).toBe(false);
  });

  it("rejects connect requests with duplicate or unknown access and over-long benefits", () => {
    const connect = { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read one email", connectRequestId: "cr_abcdefgh" };
    expect(BotInteractionPayloadSchema.safeParse({ ...connect, access: ["read", "read"] }).success).toBe(false);
    expect(BotInteractionPayloadSchema.safeParse({ ...connect, access: ["admin"] }).success).toBe(false);
    expect(BotInteractionPayloadSchema.safeParse({ ...connect, benefit: "x".repeat(281) }).success).toBe(false);
    expect(BotInteractionPayloadSchema.safeParse({ ...connect, service: "Gmail!" }).success).toBe(false);
  });

  it("describes an interaction for its responder without exposing unknown fields", () => {
    const interaction = {
      interactionId: "in_abcdefgh",
      chatId: "chat_research",
      agentId: "bot_research1",
      taskId: "task_abcdefgh",
      kind: "question",
      blocking: true,
      status: "pending",
      expiresAt: now,
      revision: 1,
      payload: question,
    };
    expect(BotInteractionSchema.parse(interaction)).toMatchObject(interaction);
    expect(BotInteractionSchema.safeParse({ ...interaction, responderActorId: "user_1" }).success).toBe(false);
    expect(BotInteractionSchema.safeParse({ ...interaction, payload: { ...question, kind: "approval" } }).success).toBe(false);
  });

  it("requires the resolution kind and revision, and bounds free text", () => {
    expect(ResolveBotInteractionRequestSchema.parse({ kind: "question", baseRevision: 1, answer: "Acme Corp" }).kind).toBe("question");
    expect(ResolveBotInteractionRequestSchema.parse({ kind: "question", baseRevision: 1, structuredAnswers: { competitor: ["Acme"] } }).kind).toBe("question");
    expect(ResolveBotInteractionRequestSchema.safeParse({ kind: "question", baseRevision: 1 }).success).toBe(false);
    expect(ResolveBotInteractionRequestSchema.parse({ kind: "account_choice", baseRevision: 2, connectionId: "conn_1" }).kind).toBe("account_choice");
    expect(ResolveBotInteractionRequestSchema.parse({ kind: "connect_request", baseRevision: 2, action: "start" }).kind).toBe("connect_request");
    expect(ResolveBotInteractionRequestSchema.safeParse({ kind: "connect_request", baseRevision: 2, action: "complete" }).success).toBe(false);
    expect(ResolveBotInteractionRequestSchema.parse({ kind: "approval", baseRevision: 2, decision: "deny" }).kind).toBe("approval");
    expect(ResolveBotInteractionRequestSchema.safeParse({ kind: "approval", decision: "approve" }).success).toBe(false);
    expect(ResolveBotInteractionRequestSchema.safeParse({ kind: "question", baseRevision: 1, answer: "x".repeat(32_001) }).success).toBe(false);
  });

  it("returns only an https connect URL", () => {
    const base = { interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } };
    expect(ResolveBotInteractionResponseSchema.parse(base)).toEqual(base);
    expect(ResolveBotInteractionResponseSchema.parse({ ...base, connectUrl: "https://connect.example.com/oauth?x=1" }).connectUrl)
      .toBe("https://connect.example.com/oauth?x=1");
    expect(ResolveBotInteractionResponseSchema.safeParse({ ...base, connectUrl: "http://connect.example.com" }).success).toBe(false);
    expect(ResolveBotInteractionResponseSchema.safeParse({ ...base, connectUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});

describe("bot grant, memory, task, and authority contracts", () => {
  const grant = {
    grantId: "gr_abcdefgh",
    service: "gmail",
    accountLabel: "Work",
    effects: ["read"],
    audience: "direct",
    expiresAt: null,
  };
  const memory = {
    itemId: "mem_abcdefgh",
    kind: "preference",
    scope: "bot",
    content: "Only enterprise deals, keep it short.",
    source: { messageId: "msg_correction", at: now },
    confirmed: true,
    revision: 1,
  };

  it("accepts grants with bounded effects and group audiences", () => {
    expect(BotGrantSchema.parse(grant)).toEqual(grant);
    expect(BotGrantSchema.parse({ ...grant, audience: "group:chat_team" }).audience).toBe("group:chat_team");
    expect(BotGrantSchema.safeParse({ ...grant, effects: [] }).success).toBe(false);
    expect(BotGrantSchema.safeParse({ ...grant, audience: "everyone" }).success).toBe(false);
    expect(BotGrantSchema.safeParse({ ...grant, connectionId: "external-account-id" }).success).toBe(false);
    expect(RevokeBotGrantResponseSchema.parse({ grantId: "gr_abcdefgh", revokedAt: now }).revokedAt).toBe(now);
  });

  it("bounds memory content to 4 KiB and requires a source time", () => {
    expect(BotMemoryItemSchema.parse(memory)).toEqual(memory);
    expect(BotMemoryItemSchema.parse({ ...memory, kind: "fact", scope: "chat:chat_research", confirmed: false }).confirmed).toBe(false);
    expect(BotMemoryItemSchema.safeParse({ ...memory, content: "é".repeat(2_049) }).success).toBe(false);
    expect(BotMemoryItemSchema.safeParse({ ...memory, source: {} }).success).toBe(false);
    expect(BotMemoryItemSchema.safeParse({ ...memory, source: { url: "file:///etc/passwd", at: now } }).success).toBe(false);
    expect(BotMemoryMutationRequestSchema.safeParse({ baseRevision: 0 }).success).toBe(false);
  });

  it("uses allowlisted task statuses and blocked reasons", () => {
    const task = { taskId: "task_abcdefgh", chatId: "chat_research", agentId: "bot_research1", status: "blocked", blockedReason: "grant_revoked", revision: 2, updatedAt: now };
    expect(BotTaskSummarySchema.parse(task)).toEqual(task);
    expect(BotTaskSummarySchema.safeParse({ ...task, status: "paused" }).success).toBe(false);
    expect(BotTaskSummarySchema.safeParse({ ...task, blockedReason: "postgres connection refused" }).success).toBe(false);
  });

  it("projects authority from server state with bounded lists", () => {
    const view = {
      agentId: "bot_research1",
      revision: 7,
      grants: [grant],
      connections: [{ service: "google_calendar", state: "not_connected" }],
      routines: [],
      pendingInteractions: [{ interactionId: "in_abcdefgh", kind: "connect_request", chatId: "chat_research", expiresAt: now }],
      memory: { items: [memory] },
    };
    expect(BotAuthorityViewSchema.parse(view)).toEqual(view);
    expect(BotAuthorityViewSchema.safeParse({ ...view, grants: Array.from({ length: 101 }, () => grant) }).success).toBe(false);
    expect(BotAuthorityViewSchema.safeParse({ ...view, connections: [{ service: "gmail", state: "unknown" }] }).success).toBe(false);
  });
});
