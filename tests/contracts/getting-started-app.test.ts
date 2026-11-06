import { describe, expect, it } from "vitest";
import {
  GETTING_STARTED_APP_AWARDABLE_TASK_IDS,
  GETTING_STARTED_APP_TASKS,
  GETTING_STARTED_APP_TASK_IDS,
  GettingStartedAppAwardRequestSchema,
  GettingStartedAppAwardResponseSchema,
  GettingStartedAppProgressSchema,
  deriveGettingStartedAppTasks,
  deriveGettingStartedSnapshot,
  gettingStartedAppKnownTaskIds,
  gettingStartedAppNextTask,
  gettingStartedAppTaskPoints,
  type GettingStartedResults,
} from "../../packages/contracts/src/index.js";

function fulfilled(value: unknown): PromiseFulfilledResult<unknown> {
  return { status: "fulfilled", value };
}

function rejected(): PromiseRejectedResult {
  return { status: "rejected", reason: new Error("down") };
}

function results(overrides: Partial<GettingStartedResults> = {}): GettingStartedResults {
  return {
    github: fulfilled({ authenticated: false }),
    integrations: fulfilled([]),
    agents: fulfilled({ agents: [] }),
    projects: fulfilled({ projects: [] }),
    chats: fulfilled({ items: [] }),
    billing: fulfilled({ access: { runtimeProxyAllowed: false } }),
    ...overrides,
  };
}

function statusOf(tasks: ReturnType<typeof deriveGettingStartedAppTasks>, id: string) {
  return tasks.find((task) => task.id === id)?.status;
}

describe("Getting started app task table", () => {
  it("has the ten Figma tasks in grid order with the hero first", () => {
    expect(GETTING_STARTED_APP_TASK_IDS).toEqual([
      "first-prompt",
      "build-app",
      "create-agent",
      "build-memory",
      "slack",
      "whatsapp",
      "github",
      "ai-provider",
      "mobile-app",
      "invite-friends",
    ]);
    expect(GETTING_STARTED_APP_TASKS.map((task) => task.group)).toEqual([
      "hero", "build", "build", "build", "connect", "connect", "connect", "connect", "further", "further",
    ]);
  });

  it("uses the Figma points and adds up to 240 for the awardable tasks", () => {
    expect(gettingStartedAppTaskPoints("first-prompt")).toBe(50);
    expect(gettingStartedAppTaskPoints("build-app")).toBe(30);
    expect(gettingStartedAppTaskPoints("slack")).toBe(20);
    expect(gettingStartedAppTaskPoints("invite-friends")).toBe(100);
    const awardable = GETTING_STARTED_APP_AWARDABLE_TASK_IDS.reduce(
      (sum, id) => sum + gettingStartedAppTaskPoints(id),
      0,
    );
    expect(awardable).toBe(240);
    expect(GETTING_STARTED_APP_AWARDABLE_TASK_IDS).not.toContain("invite-friends");
  });
});

describe("deriveGettingStartedAppTasks", () => {
  it("marks tasks done from the same signals as the popover", () => {
    const tasks = deriveGettingStartedAppTasks(results({
      github: fulfilled({ authenticated: true }),
      integrations: fulfilled([{ id: "c1", service: "slack", status: "active" }]),
      agents: fulfilled({ agents: [{ agent: "codex", status: "available" }] }),
      chats: fulfilled({ items: [{ id: "chat_1" }] }),
    }));

    expect(statusOf(tasks, "first-prompt")).toBe("complete");
    expect(statusOf(tasks, "slack")).toBe("complete");
    expect(statusOf(tasks, "github")).toBe("complete");
    expect(statusOf(tasks, "ai-provider")).toBe("complete");
  });

  it("counts the owner's own ready key without Codex or Claude", () => {
    // Shape of GET /api/ai/provider-settings (ProviderAccessSourceSchema): readiness is nested.
    const ownKey = (state: string, fundingKind = "owner_api_key") => fulfilled({
      accessSources: [{ id: "anthropic-key", kind: "provider_account", fundingKind, readiness: { state, checkedAt: null, staleAfter: null } }],
    });
    expect(statusOf(deriveGettingStartedAppTasks(results({ providers: ownKey("ready") })), "ai-provider")).toBe("complete");
    expect(statusOf(deriveGettingStartedAppTasks(results({ providers: ownKey("ready", "owner_account") })), "ai-provider")).toBe("complete");
    expect(statusOf(deriveGettingStartedAppTasks(results({ providers: ownKey("ready", "owner_subscription") })), "ai-provider")).toBe("complete");
    expect(statusOf(deriveGettingStartedAppTasks(results({ providers: ownKey("auth_required") })), "ai-provider")).toBe("incomplete");
    expect(statusOf(deriveGettingStartedAppTasks(results({ providers: ownKey("ready", "matrix_included") })), "ai-provider")).toBe("incomplete");
  });

  it("still counts a signed-in agent when provider settings fail", () => {
    const tasks = deriveGettingStartedAppTasks(results({
      agents: fulfilled({ agents: [{ agent: "claude", status: "available" }] }),
      providers: { status: "rejected", reason: new Error("down") },
    }));
    expect(statusOf(tasks, "ai-provider")).toBe("complete");
  });

  it("agrees with the popover's GitHub step", () => {
    const input = results({
      github: rejected(),
      integrations: fulfilled({ connections: [{ id: "c2", service: "github", status: "connected" }] }),
    });
    const popoverGithub = deriveGettingStartedSnapshot(input).steps.find((step) => step.id === "github")?.status;
    expect(statusOf(deriveGettingStartedAppTasks(input), "github")).toBe(popoverGithub);
    expect(popoverGithub).toBe("complete");
  });

  it("leaves tasks incomplete when their signal says not yet", () => {
    const tasks = deriveGettingStartedAppTasks(results());
    expect(statusOf(tasks, "first-prompt")).toBe("incomplete");
    expect(statusOf(tasks, "slack")).toBe("incomplete");
    expect(statusOf(tasks, "github")).toBe("incomplete");
    expect(statusOf(tasks, "ai-provider")).toBe("incomplete");
  });

  it("shows unavailable instead of guessing when a status read fails", () => {
    const tasks = deriveGettingStartedAppTasks(results({ integrations: rejected(), chats: rejected(), agents: rejected() }));
    expect(statusOf(tasks, "slack")).toBe("unavailable");
    expect(statusOf(tasks, "first-prompt")).toBe("unavailable");
    expect(statusOf(tasks, "ai-provider")).toBe("unavailable");
  });

  it("shows unavailable for malformed status responses", () => {
    const tasks = deriveGettingStartedAppTasks(results({ chats: fulfilled({ items: "nope" }) }));
    expect(statusOf(tasks, "first-prompt")).toBe("unavailable");
  });

  it("keeps tasks without a reliable signal unavailable", () => {
    const tasks = deriveGettingStartedAppTasks(results({
      integrations: fulfilled([{ id: "c3", service: "whatsapp", status: "active" }]),
    }));
    for (const id of ["build-app", "create-agent", "build-memory", "whatsapp", "mobile-app", "invite-friends"]) {
      expect(statusOf(tasks, id)).toBe("unavailable");
    }
  });

  it("picks the first incomplete task in grid order as up next", () => {
    const tasks = deriveGettingStartedAppTasks(results({
      chats: fulfilled({ items: [{ id: "chat_1" }] }),
    }));
    expect(gettingStartedAppNextTask(tasks)?.id).toBe("slack");
    const allDone = tasks.map((task) => ({ ...task, status: "complete" as const }));
    expect(gettingStartedAppNextTask(allDone)).toBeNull();
  });
});

describe("Getting started app schemas", () => {
  it("accepts an award for an awardable task only", () => {
    expect(GettingStartedAppAwardRequestSchema.safeParse({ taskId: "slack", silent: false }).success).toBe(true);
    expect(GettingStartedAppAwardRequestSchema.safeParse({ taskId: "invite-friends", silent: false }).success).toBe(false);
    expect(GettingStartedAppAwardRequestSchema.safeParse({ taskId: "unknown", silent: false }).success).toBe(false);
  });

  it("never accepts points from the client", () => {
    expect(GettingStartedAppAwardRequestSchema.safeParse({ taskId: "slack", silent: false, points: 1000 }).success).toBe(false);
  });

  it("lets an older client read progress from a newer computer", () => {
    const newer = (taskId: string) => ({ taskId, points: 20, awardedAt: "2026-10-29T10:00:00.000Z", kind: "future-field" });
    const parsed = GettingStartedAppProgressSchema.safeParse({
      // More tasks than this build knows, with ids and fields it has never seen.
      awards: Array.from({ length: GETTING_STARTED_APP_TASK_IDS.length + 5 }, (_, index) => newer(`future-task-${index}`)),
      total: 340,
      streak: 3,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.total).toBe(340);
    expect(GettingStartedAppAwardResponseSchema.safeParse({ awarded: true, points: 20, total: 20, badge: "new" }).success).toBe(true);
    expect(gettingStartedAppKnownTaskIds([{ taskId: "slack" }, { taskId: "future-task-0" }])).toEqual(["slack"]);
  });

  it("still rejects malformed or oversized progress", () => {
    const award = (taskId: string) => ({ taskId, points: 20, awardedAt: "2026-10-29T10:00:00.000Z" });
    expect(GettingStartedAppProgressSchema.safeParse({ awards: [award("<script>")], total: 20 }).success).toBe(false);
    expect(GettingStartedAppProgressSchema.safeParse({ awards: [award("x".repeat(33))], total: 20 }).success).toBe(false);
    expect(GettingStartedAppProgressSchema.safeParse({ awards: Array.from({ length: 65 }, () => award("slack")), total: 20 }).success).toBe(false);
  });

  it("bounds the progress and award responses", () => {
    expect(GettingStartedAppProgressSchema.safeParse({
      awards: [{ taskId: "slack", points: 20, awardedAt: "2026-10-29T10:00:00.000Z" }],
      total: 20,
    }).success).toBe(true);
    expect(GettingStartedAppProgressSchema.safeParse({ awards: [], total: -1 }).success).toBe(false);
    expect(GettingStartedAppAwardResponseSchema.safeParse({ awarded: true, points: 20, total: 20 }).success).toBe(true);
  });
});
