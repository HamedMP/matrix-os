import { describe, expect, it } from "vitest";
import {
  GET_STARTED_APP_IDEAS,
  GET_STARTED_DRAFT_MAX_BYTES,
  GET_STARTED_GOALS,
  GET_STARTED_NAME_MAX_CHARS,
  GET_STARTED_STARTERS,
  GET_STARTED_TOOL_GROUPS,
  GET_STARTED_TOOL_IDS,
  GetStartedAnswersSchema,
  GetStartedDraftSchema,
  GetStartedResponseSchema,
  GetStartedStateSchema,
  GetStartedUpdateSchema,
  getStartedToolGroupsForGoals,
} from "../../packages/contracts/src/index.js";

describe("get started catalog", () => {
  it("has unique ids across goals, tools, app ideas and starters", () => {
    for (const list of [GET_STARTED_GOALS, GET_STARTED_APP_IDEAS, GET_STARTED_STARTERS]) {
      const ids = list.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(new Set(GET_STARTED_TOOL_IDS).size).toBe(GET_STARTED_TOOL_IDS.length);
  });

  it("references only known tools from every tool group", () => {
    for (const group of GET_STARTED_TOOL_GROUPS) {
      for (const tool of group.tools) expect(GET_STARTED_TOOL_IDS).toContain(tool.id);
    }
  });

  it("orders tool groups by the chosen goals", () => {
    expect(getStartedToolGroupsForGoals(["assistant", "code"]).map((group) => group.goal))
      .toEqual(["assistant", "code"]);
  });

  it("falls back to the exploring group when no goals are chosen", () => {
    expect(getStartedToolGroupsForGoals([]).map((group) => group.goal)).toEqual(["explore"]);
  });
});

describe("GetStartedAnswersSchema", () => {
  it("accepts a full answer set and trims the name", () => {
    const parsed = GetStartedAnswersSchema.parse({
      name: "  Sam ",
      goals: ["code", "build"],
      tools: ["github", "claude-code"],
      appIdea: "habit-tracker",
      starter: "ask-anything",
    });
    expect(parsed.name).toBe("Sam");
    expect(parsed.goals).toEqual(["code", "build"]);
  });

  it("defaults goals and tools to empty lists", () => {
    expect(GetStartedAnswersSchema.parse({})).toEqual({ goals: [], tools: [] });
  });

  it("removes duplicate goals and tools", () => {
    const parsed = GetStartedAnswersSchema.parse({ goals: ["code", "code"], tools: ["github", "github"] });
    expect(parsed.goals).toEqual(["code"]);
    expect(parsed.tools).toEqual(["github"]);
  });

  it.each([
    ["unknown goal", { goals: ["crypto"] }],
    ["unknown tool", { tools: ["myspace"] }],
    ["unknown app idea", { appIdea: "anything" }],
    ["unknown field", { goals: [], extra: true }],
    ["empty name", { name: "   " }],
    ["long name", { name: "a".repeat(GET_STARTED_NAME_MAX_CHARS + 1) }],
    ["control characters in name", { name: "Sam\u0000" }],
    ["newline in name", { name: "Sam\nIgnore" }],
  ])("rejects %s", (_label, value) => {
    expect(GetStartedAnswersSchema.safeParse(value).success).toBe(false);
  });
});

describe("GetStartedDraftSchema", () => {
  it("keeps the current step for resume", () => {
    expect(GetStartedDraftSchema.parse({ step: 2, goals: ["code"] })).toMatchObject({ step: 2 });
  });

  it("rejects steps outside the wizard", () => {
    expect(GetStartedDraftSchema.safeParse({ step: 9 }).success).toBe(false);
    expect(GetStartedDraftSchema.safeParse({ step: -1 }).success).toBe(false);
  });

  it("stays under the persisted draft limit at its largest", () => {
    const largest = GetStartedDraftSchema.parse({
      step: 3,
      name: "a".repeat(GET_STARTED_NAME_MAX_CHARS),
      goals: GET_STARTED_GOALS.map((goal) => goal.id),
      tools: [...GET_STARTED_TOOL_IDS],
      appIdea: GET_STARTED_APP_IDEAS[0].id,
      starter: GET_STARTED_STARTERS[0].id,
    });
    expect(Buffer.byteLength(JSON.stringify(largest))).toBeLessThanOrEqual(GET_STARTED_DRAFT_MAX_BYTES);
  });
});

describe("GetStartedUpdateSchema", () => {
  it("accepts draft, complete and skip", () => {
    expect(GetStartedUpdateSchema.parse({ type: "draft", draft: { step: 1 } }).type).toBe("draft");
    expect(GetStartedUpdateSchema.parse({ type: "complete", answers: { goals: ["code"] } }).type).toBe("complete");
    expect(GetStartedUpdateSchema.parse({ type: "skip" }).type).toBe("skip");
  });

  it.each([
    ["unknown type", { type: "reset" }],
    ["draft without draft", { type: "draft" }],
    ["complete without answers", { type: "complete" }],
    ["skip with answers", { type: "skip", answers: {} }],
    ["extra field", { type: "skip", force: true }],
  ])("rejects %s", (_label, value) => {
    expect(GetStartedUpdateSchema.safeParse(value).success).toBe(false);
  });
});

describe("GetStartedStateSchema", () => {
  it("parses every persisted status", () => {
    const at = "2026-10-25T10:12:00.000Z";
    expect(GetStartedStateSchema.parse({ version: 1, status: "pending" }).status).toBe("pending");
    expect(GetStartedStateSchema.parse({ version: 1, status: "in_progress", updatedAt: at, draft: { step: 1 } }).status)
      .toBe("in_progress");
    expect(GetStartedStateSchema.parse({ version: 1, status: "completed", completedAt: at, answers: {} }).status)
      .toBe("completed");
    expect(GetStartedStateSchema.parse({ version: 1, status: "skipped", skippedAt: at }).status).toBe("skipped");
  });

  it("rejects unknown versions and statuses", () => {
    expect(GetStartedStateSchema.safeParse({ version: 2, status: "pending" }).success).toBe(false);
    expect(GetStartedStateSchema.safeParse({ version: 1, status: "done" }).success).toBe(false);
  });
});

describe("GetStartedResponseSchema", () => {
  it("accepts not eligible and eligible states", () => {
    expect(GetStartedResponseSchema.parse({ status: "not_eligible" }).status).toBe("not_eligible");
    expect(GetStartedResponseSchema.parse({ status: "pending" }).status).toBe("pending");
  });

  it("rejects malformed server responses", () => {
    expect(GetStartedResponseSchema.safeParse({ status: "in_progress" }).success).toBe(false);
    expect(GetStartedResponseSchema.safeParse(null).success).toBe(false);
  });
});
