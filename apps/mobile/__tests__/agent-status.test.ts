import type { BotInteraction, BotTaskSummary } from "@matrix-os/contracts";

import {
  AGENT_STATUS_IDLE,
  AGENT_STATUS_LOADING,
  AGENT_STATUS_UNAVAILABLE,
  agentLastActivityAt,
  agentNeedsUser,
  agentStatus,
  countWaitingAgents,
  latestAgentTask,
  readAgentStatuses,
  type AgentStatusReads,
} from "@/lib/agent-status";

const now = "2026-10-08T09:00:00.000Z";

function task(overrides: Partial<BotTaskSummary> = {}): BotTaskSummary {
  return {
    taskId: "task_aaaaaaaa",
    chatId: "chat_inbox",
    agentId: "bot_inbox001",
    status: "running",
    revision: 1,
    updatedAt: "2026-10-08T08:00:00.000Z",
    ...overrides,
  };
}

function interaction(overrides: Partial<BotInteraction> = {}): BotInteraction {
  return {
    interactionId: "in_aaaaaaaa",
    chatId: "chat_inbox",
    agentId: "bot_inbox001",
    taskId: "task_aaaaaaaa",
    kind: "approval",
    blocking: true,
    status: "pending",
    expiresAt: "2026-10-08T10:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

describe("agentStatus", () => {
  it("is idle with no open tasks and nothing pending", () => {
    expect(agentStatus([], [], now)).toEqual({ state: "idle", label: "No open tasks" });
    expect(agentStatus([], [], now)).toBe(AGENT_STATUS_IDLE);
  });

  it.each([
    ["approval", "Approval requested"],
    ["question", "Question"],
    ["account_choice", "Choose an account"],
    ["connect_request", "Connect a service"],
  ] as const)("needs the person while a %s is pending, whatever the tasks say", (kind, label) => {
    expect(agentStatus([task({ status: "running" })], [interaction({ kind })], now)).toEqual({ state: "attention", label });
  });

  it("ignores a pending interaction that has expired", () => {
    const expired = interaction({ expiresAt: "2026-10-08T08:59:59.000Z" });

    expect(agentStatus([], [expired], now)).toBe(AGENT_STATUS_IDLE);
    expect(agentStatus([task()], [expired], now)).toEqual({ state: "working", label: "Working" });
  });

  it("ignores an interaction expiring at this very moment", () => {
    expect(agentStatus([], [interaction({ expiresAt: now })], now)).toBe(AGENT_STATUS_IDLE);
  });

  it.each(["resolved", "expired", "cancelled"] as const)("ignores a %s interaction", (status) => {
    expect(agentStatus([], [interaction({ status })], now)).toBe(AGENT_STATUS_IDLE);
  });

  it("uses the first interaction that is still pending", () => {
    const interactions = [
      interaction({ interactionId: "in_resolved1", status: "resolved", kind: "question" }),
      interaction({ interactionId: "in_expired01", expiresAt: "2026-10-08T08:00:00.000Z", kind: "connect_request" }),
      interaction({ interactionId: "in_pending01", kind: "account_choice" }),
      interaction({ interactionId: "in_pending02", kind: "approval" }),
    ];

    expect(agentStatus([], interactions, now)).toEqual({ state: "attention", label: "Choose an account" });
  });

  it.each([
    ["running", "working", "Working"],
    ["waiting_person", "attention", "Waiting for your answer"],
    ["blocked", "attention", "Needs attention"],
    ["failed", "attention", "Could not finish"],
    ["completed", "completed", "Completed"],
    ["queued", "idle", "Queued"],
    ["waiting_capacity", "idle", "Waiting for capacity"],
    ["cancelled", "idle", "Cancelled"],
  ] as const)("maps a %s task to %s", (status, state, label) => {
    expect(agentStatus([task({ status })], [], now)).toEqual({ state, label });
  });

  it("names why a task is blocked when the server says", () => {
    expect(agentStatus([task({ status: "blocked", blockedReason: "funds_unavailable" })], [], now))
      .toEqual({ state: "attention", label: "Funds unavailable" });
  });

  it("goes by the most recently updated task", () => {
    const tasks = [
      task({ taskId: "task_older001", status: "failed", updatedAt: "2026-10-08T07:00:00.000Z" }),
      task({ taskId: "task_newer001", status: "running", updatedAt: "2026-10-08T08:30:00.000Z" }),
      task({ taskId: "task_middle01", status: "completed", updatedAt: "2026-10-08T08:00:00.000Z" }),
    ];

    expect(agentStatus(tasks, [], now)).toEqual({ state: "working", label: "Working" });
  });
});

describe("latestAgentTask", () => {
  it("has no latest task in an empty list", () => {
    expect(latestAgentTask([])).toBeUndefined();
    expect(agentLastActivityAt([])).toBeNull();
  });

  it("compares timestamps as times, with or without milliseconds", () => {
    const tasks = [
      task({ taskId: "task_withms01", updatedAt: "2026-10-08T08:00:00.500Z" }),
      task({ taskId: "task_withoutms", updatedAt: "2026-10-08T08:00:01Z" }),
    ];

    expect(latestAgentTask(tasks)?.taskId).toBe("task_withoutms");
    expect(agentLastActivityAt(tasks)).toBe("2026-10-08T08:00:01Z");
  });

  it("breaks a tie on the update time by the higher task id, in either order", () => {
    const first = task({ taskId: "task_aaaaaaaa" });
    const second = task({ taskId: "task_bbbbbbbb" });

    expect(latestAgentTask([first, second])?.taskId).toBe("task_bbbbbbbb");
    expect(latestAgentTask([second, first])?.taskId).toBe("task_bbbbbbbb");
  });
});

describe("who needs the person", () => {
  it("counts only agents whose status asks for the person", () => {
    const statuses = [
      { state: "attention", label: "Approval requested" },
      { state: "working", label: "Working" },
      { state: "attention", label: "Could not finish" },
      AGENT_STATUS_IDLE,
      AGENT_STATUS_LOADING,
      AGENT_STATUS_UNAVAILABLE,
      { state: "completed", label: "Completed" },
    ] as const;

    expect(statuses.map(agentNeedsUser)).toEqual([true, false, true, false, false, false, false]);
    expect(countWaitingAgents(statuses)).toBe(2);
    expect(countWaitingAgents([])).toBe(0);
  });
});

describe("readAgentStatuses", () => {
  const template = (id: string) => ({ id, recipeRef: { recipeId: "inbox-triage", version: "v1" } });
  const custom = (id: string) => ({ id });
  const clock = () => now;

  function reads(overrides: Partial<AgentStatusReads> = {}): jest.Mocked<AgentStatusReads> {
    return {
      directChat: jest.fn(async (agentId: string) => `chat_${agentId.slice(4)}`),
      tasks: jest.fn(async () => []),
      interactions: jest.fn(async () => []),
      ...overrides,
    } as jest.Mocked<AgentStatusReads>;
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("derives each template agent's status from its chat's tasks and interactions", async () => {
    const source = reads({
      tasks: jest.fn(async (chatId: string) => chatId === "chat_working1"
        ? [task({ chatId, agentId: "bot_working1", updatedAt: "2026-10-08T08:45:00.000Z" })]
        : []),
      interactions: jest.fn(async (chatId: string) => chatId === "chat_waiting1"
        ? [interaction({ chatId, agentId: "bot_waiting1", kind: "question" })]
        : []),
    });

    const statuses = await readAgentStatuses(
      [template("bot_working1"), template("bot_waiting1"), template("bot_resting1")],
      source,
      { now: clock },
    );

    expect(statuses).toEqual({
      bot_working1: { state: "working", label: "Working", chatId: "chat_working1", lastActivityAt: "2026-10-08T08:45:00.000Z" },
      bot_waiting1: { state: "attention", label: "Question", chatId: "chat_waiting1", lastActivityAt: null },
      bot_resting1: { state: "idle", label: "No open tasks", chatId: "chat_resting1", lastActivityAt: null },
    });
  });

  it("marks an agent that is not from a template unavailable without reading anything", async () => {
    const source = reads();

    const statuses = await readAgentStatuses([custom("bot_custom01")], source, { now: clock });

    expect(statuses).toEqual({
      bot_custom01: { state: "unavailable", label: "Status unavailable", chatId: null, lastActivityAt: null },
    });
    expect(source.directChat).not.toHaveBeenCalled();
  });

  it("is idle for a template agent that has no chat yet, without reading tasks", async () => {
    const source = reads({ directChat: jest.fn(async () => null) });

    const statuses = await readAgentStatuses([template("bot_nochat01")], source, { now: clock });

    expect(statuses.bot_nochat01).toEqual({ state: "idle", label: "No open tasks", chatId: null, lastActivityAt: null });
    expect(source.tasks).not.toHaveBeenCalled();
    expect(source.interactions).not.toHaveBeenCalled();
  });

  it.each(["directChat", "tasks", "interactions"] as const)(
    "marks an agent unavailable when its %s read fails, and still answers for the others",
    async (failing) => {
      const healthy = reads();
      const fail = async (): Promise<never> => {
        throw new Error("offline");
      };
      const source: AgentStatusReads = {
        directChat: (agentId) => failing === "directChat" && agentId === "bot_broken01" ? fail() : healthy.directChat(agentId),
        tasks: (chatId) => failing === "tasks" && chatId === "chat_broken01" ? fail() : healthy.tasks(chatId),
        interactions: (chatId) => failing === "interactions" && chatId === "chat_broken01"
          ? fail() : healthy.interactions(chatId),
      };

      const statuses = await readAgentStatuses([template("bot_broken01"), template("bot_healthy1")], source, { now: clock });

      expect(statuses.bot_broken01).toEqual({
        state: "unavailable", label: "Status unavailable", chatId: null, lastActivityAt: null,
      });
      expect(statuses.bot_healthy1!.state).toBe("idle");
    },
  );

  it("ignores tasks and interactions that belong to another agent or chat", async () => {
    const source = reads({
      tasks: jest.fn(async () => [task({ chatId: "chat_inbox001", agentId: "bot_someone1", status: "failed" })]),
      interactions: jest.fn(async () => [interaction({ chatId: "chat_elsewhere", agentId: "bot_inbox001" })]),
    });

    const statuses = await readAgentStatuses([template("bot_inbox001")], source, { now: clock });

    expect(statuses.bot_inbox001).toMatchObject({ state: "idle", lastActivityAt: null });
  });

  it("never has more than four reads in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async <T,>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return value;
    };
    const source: AgentStatusReads = {
      directChat: (agentId) => slow(`chat_${agentId.slice(4)}`),
      tasks: () => slow([]),
      interactions: () => slow([]),
    };
    const agents = Array.from({ length: 12 }, (_unused, index) => template(`bot_agent${String(index).padStart(3, "0")}`));

    const statuses = await readAgentStatuses(agents, source, { now: clock });

    expect(Object.keys(statuses)).toHaveLength(12);
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
  });

  it("answers only for the first hundred agents and marks the rest unavailable", async () => {
    const source = reads({ directChat: jest.fn(async () => null) });
    const agents = Array.from({ length: 102 }, (_unused, index) => template(`bot_agent${String(index).padStart(3, "0")}`));

    const statuses = await readAgentStatuses(agents, source, { now: clock });

    expect(source.directChat).toHaveBeenCalledTimes(100);
    expect(statuses.bot_agent099!.state).toBe("idle");
    expect(statuses.bot_agent100!.state).toBe("unavailable");
    expect(statuses.bot_agent101!.state).toBe("unavailable");
  });

  it("stops starting reads once it is told to stop", async () => {
    const controller = new AbortController();
    const source = reads({
      directChat: jest.fn(async (agentId: string) => {
        controller.abort();
        return `chat_${agentId.slice(4)}`;
      }),
    });
    const agents = Array.from({ length: 8 }, (_unused, index) => template(`bot_agent${String(index).padStart(3, "0")}`));

    await expect(readAgentStatuses(agents, source, { now: clock, signal: controller.signal })).rejects.toThrow();

    expect(source.directChat.mock.calls.length).toBeLessThanOrEqual(4);
    expect(source.tasks).not.toHaveBeenCalled();
  });
});
