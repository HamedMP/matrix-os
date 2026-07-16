import { describe, expect, it } from "vitest";
import {
  AgentThreadEventSchema,
  AgentThreadListFilterSchema,
  AdoptAgentThreadRequestSchema,
  AdoptAgentThreadResponseSchema,
  AgentTurnLifecycleEventSchema,
  AgentTurnIdSchema,
  CreateAgentTurnErrorSchema,
  CreateAgentTurnRequestSchema,
  CreateAgentTurnResponseSchema,
  ProjectAgentWorkspaceSchema,
  ProjectSummarySchema,
  RuntimeCapabilityIdSchema,
  RuntimeSummarySchema,
  TaskAgentSummarySchema,
} from "../../packages/contracts/src/index.js";

const now = "2026-07-06T12:00:00.000Z";

function task(index: number) {
  return {
    id: `task_auth_${index}`,
    projectId: "matrix-os",
    title: `Authentication task ${index}`,
    status: "todo" as const,
    priority: "normal" as const,
    order: index,
    threadCount: 1,
    activeThreadCount: 0,
    attentionCount: 0,
  };
}

function thread(index: number, taskId?: string) {
  return {
    id: `thread_auth_${index}`,
    providerId: "codex",
    title: `Authentication chat ${index}`,
    status: "completed" as const,
    attention: "none" as const,
    projectId: "matrix-os",
    ...(taskId ? { taskId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function workspaceFixture() {
  return {
    project: {
      id: "matrix-os",
      label: "Matrix OS",
      status: "available" as const,
      taskCount: 1,
      threadCount: 2,
      attentionCount: 0,
    },
    tasks: { items: [task(0)], hasMore: false, limit: 100 },
    projectThreads: { items: [thread(0)], hasMore: false, limit: 100 },
    taskThreads: { items: [thread(1, "task_auth_0")], hasMore: false, limit: 100 },
    updatedAt: now,
  };
}

describe("coding agent project conversation contracts", () => {
  it("CT-001 parses bounded project summary counts", () => {
    expect(ProjectSummarySchema.parse({
      id: "matrix-os",
      label: "Matrix OS",
      status: "available",
      taskCount: 12,
      threadCount: 18,
      attentionCount: 2,
      updatedAt: now,
    })).toMatchObject({ taskCount: 12, threadCount: 18, attentionCount: 2 });

    for (const taskCount of [-1, 1_000_001]) {
      expect(() => ProjectSummarySchema.parse({
        id: "matrix-os",
        label: "Matrix OS",
        status: "available",
        taskCount,
        threadCount: 0,
        attentionCount: 0,
      })).toThrow();
    }
  });

  it("CT-002 validates canonical task summaries and bounded thread aggregates", () => {
    expect(TaskAgentSummarySchema.parse({
      id: "task_auth",
      projectId: "matrix-os",
      title: "Harden authentication",
      status: "running",
      priority: "urgent",
      order: 2,
      threadCount: 3,
      activeThreadCount: 1,
      attentionCount: 1,
      latestThreadAt: now,
      revision: 7,
    })).toMatchObject({ status: "running", priority: "urgent", threadCount: 3 });

    for (const invalid of [
      { status: "in_progress" },
      { priority: "critical" },
      { title: "/home/matrix/private" },
      { threadCount: -1 },
      { activeThreadCount: 1_000_001 },
    ]) {
      expect(() => TaskAgentSummarySchema.parse({ ...task(0), ...invalid })).toThrow();
    }
  });

  it("CT-003 validates independently bounded project workspace lists", () => {
    const workspace = workspaceFixture();
    expect(ProjectAgentWorkspaceSchema.parse(workspace).taskThreads.items[0]?.taskId).toBe("task_auth_0");

    for (const listName of ["tasks", "projectThreads", "taskThreads"] as const) {
      const itemFactory = listName === "tasks"
        ? task
        : (index: number) => thread(index, listName === "taskThreads" ? "task_auth_0" : undefined);
      expect(() => ProjectAgentWorkspaceSchema.parse({
        ...workspace,
        [listName]: {
          items: Array.from({ length: 101 }, (_, index) => itemFactory(index)),
          hasMore: true,
          limit: 100,
        },
      })).toThrow();
    }
    expect(() => ProjectAgentWorkspaceSchema.parse({
      ...workspace,
      projectThreads: { items: [{ ...thread(0), taskId: "task_auth_0" }], hasMore: false, limit: 100 },
    })).toThrow();
    expect(() => ProjectAgentWorkspaceSchema.parse({
      ...workspace,
      taskThreads: {
        items: [{ ...thread(1, "task_auth_0"), transcript: ["private"] }],
        hasMore: false,
        limit: 100,
      },
    })).toThrow();
  });

  it("CT-004 requires explicit bounded project or legacy-unassigned thread filters", () => {
    expect(AgentThreadListFilterSchema.parse({
      scope: "project",
      projectId: "matrix-os",
      limit: 25,
    })).toMatchObject({ scope: "project", projectId: "matrix-os", limit: 25 });
    expect(AgentThreadListFilterSchema.parse({
      scope: "project",
      projectId: "matrix-os",
      taskId: "task_auth",
      cursor: "cursor.next",
    })).toMatchObject({ projectId: "matrix-os", taskId: "task_auth", limit: 50 });
    expect(AgentThreadListFilterSchema.parse({ scope: "legacy_unassigned" })).toMatchObject({
      scope: "legacy_unassigned",
      limit: 50,
    });

    for (const invalid of [
      { scope: "project", taskId: "task_auth" },
      { scope: "project", projectId: "../matrix-os" },
      { scope: "legacy_unassigned", projectId: "matrix-os" },
      { scope: "project", projectId: "matrix-os", limit: 101 },
    ]) {
      expect(() => AgentThreadListFilterSchema.parse(invalid)).toThrow();
    }
  });

  it("CT-005 bounds same-thread turn messages, attachments, and idempotency keys", () => {
    expect(AgentTurnIdSchema.parse("turn_auth_fix_1")).toBe("turn_auth_fix_1");
    expect(CreateAgentTurnRequestSchema.parse({
      message: "Continue with the gateway fix.",
      attachments: [{
        id: "review:auth:12",
        kind: "structured_ref",
        label: "Authentication review",
        path: "packages/gateway/src/auth.ts",
      }],
      clientRequestId: "req_turn_auth_1",
    }).message).toBe("Continue with the gateway fix.");

    for (const invalid of [
      { message: "", clientRequestId: "req_turn_auth_1" },
      { message: "a".repeat(24_001), clientRequestId: "req_turn_auth_1" },
      { message: "Continue.", clientRequestId: "turn_auth_1" },
      {
        message: "Continue.",
        clientRequestId: "req_turn_auth_1",
        attachments: Array.from({ length: 9 }, (_, index) => ({
          id: `ref:${index}`,
          kind: "structured_ref",
          label: `Reference ${index}`,
        })),
      },
    ]) {
      expect(() => CreateAgentTurnRequestSchema.parse(invalid)).toThrow();
    }
  });

  it("CT-009 validates explicit legacy thread adoption contracts", () => {
    expect(AdoptAgentThreadRequestSchema.parse({
      projectId: "matrix-os",
      taskId: "task_auth_0",
      clientRequestId: "req_adopt_auth_1",
    })).toEqual({
      projectId: "matrix-os",
      taskId: "task_auth_0",
      clientRequestId: "req_adopt_auth_1",
    });
    expect(AdoptAgentThreadResponseSchema.parse({
      thread: thread(1, "task_auth_0"),
      status: "adopted",
    })).toMatchObject({
      thread: { projectId: "matrix-os", taskId: "task_auth_0" },
      status: "adopted",
    });

    for (const invalid of [
      { taskId: "task_auth_0", clientRequestId: "req_adopt_auth_1" },
      { projectId: "../matrix-os", clientRequestId: "req_adopt_auth_1" },
      { projectId: "matrix-os", taskId: "auth", clientRequestId: "req_adopt_auth_1" },
      { projectId: "matrix-os", clientRequestId: "turn_auth_1" },
      { projectId: "matrix-os", clientRequestId: "req_adopt_auth_1", extra: true },
    ]) {
      expect(() => AdoptAgentThreadRequestSchema.parse(invalid)).toThrow();
    }
  });

  it("CT-006 keeps turn responses, errors, and lifecycle events safe", () => {
    expect(CreateAgentTurnResponseSchema.parse({
      threadId: "thread_fix",
      turnId: "turn_fix_2",
      status: "accepted",
      acceptedAt: now,
    }).turnId).toBe("turn_fix_2");

    for (const code of ["thread_busy", "thread_not_found", "turn_unavailable"] as const) {
      expect(CreateAgentTurnErrorSchema.parse({
        code,
        safeMessage: "This conversation cannot accept a message right now. Refresh and try again.",
        retryable: code === "thread_busy",
        recoveryActions: ["retry"],
      }).code).toBe(code);
    }

    expect(AgentTurnLifecycleEventSchema.parse({
      type: "turn.accepted",
      eventId: "evt_turn_accepted",
      threadId: "thread_fix",
      occurredAt: now,
      turnId: "turn_fix_2",
      clientRequestId: "req_turn_fix_2",
      acceptedAt: now,
    }).type).toBe("turn.accepted");
    expect(AgentTurnLifecycleEventSchema.parse({
      type: "turn.status",
      eventId: "evt_turn_completed",
      threadId: "thread_fix",
      occurredAt: now,
      turnId: "turn_fix_2",
      status: "completed",
    }).type).toBe("turn.status");
    expect(AgentThreadEventSchema.parse({
      type: "turn.accepted",
      eventId: "evt_turn_replay",
      threadId: "thread_fix",
      occurredAt: now,
      turnId: "turn_fix_2",
      clientRequestId: "req_turn_fix_2",
      acceptedAt: now,
    }).type).toBe("turn.accepted");
    expect(AgentThreadEventSchema.parse({
      type: "user.message",
      eventId: "evt_user_message",
      threadId: "thread_fix",
      occurredAt: now,
      messageId: "msg_user_turn_2",
      text: "Continue with the gateway fix.",
      clientRequestId: "req_turn_fix_2",
      turnId: "turn_fix_2",
    })).toMatchObject({
      type: "user.message",
      text: "Continue with the gateway fix.",
      turnId: "turn_fix_2",
    });

    const unsafeValues = [
      {
        schema: CreateAgentTurnResponseSchema,
        value: {
          threadId: "thread_fix",
          turnId: "turn_fix_2",
          status: "accepted",
          acceptedAt: now,
          providerResumeIdentity: "resume_secret",
        },
      },
      {
        schema: CreateAgentTurnErrorSchema,
        value: { code: "provider_failed", safeMessage: "Provider failed.", retryable: false },
      },
      {
        schema: AgentTurnLifecycleEventSchema,
        value: {
          type: "turn.status",
          eventId: "evt_turn_completed",
          threadId: "thread_fix",
          occurredAt: now,
          turnId: "turn_fix_2",
          status: "completed",
          providerResumeIdentity: "resume_secret",
        },
      },
    ];
    for (const { schema, value } of unsafeValues) {
      expect(() => schema.parse(value)).toThrow();
    }
  });

  it("CT-007 advertises project workspace, same-thread turn, and dual-view capabilities", () => {
    const capabilityIds = [
      "codingAgentsProjectWorkspace",
      "codingAgentsSameThreadTurns",
      "codingAgentsConversationView",
      "codingAgentsKanbanView",
    ] as const;
    for (const id of capabilityIds) {
      expect(RuntimeCapabilityIdSchema.parse(id)).toBe(id);
    }
    expect(() => RuntimeCapabilityIdSchema.parse("codingAgentsProviderResumeIdentity")).toThrow();

    const summary = RuntimeSummarySchema.parse({
      runtime: { id: "rt_primary", label: "Primary Matrix computer", status: "available" },
      capabilities: capabilityIds.map((id, index) => ({ id, enabled: index < 2 })),
      providers: [],
      projects: { items: [], hasMore: false, limit: 20 },
      activeThreads: { items: [], hasMore: false, limit: 20 },
      terminalSessions: { items: [], hasMore: false, limit: 20 },
      recentActivity: { items: [], hasMore: false, limit: 20 },
      limits: {
        maxPromptBytes: 24_000,
        maxAttachmentCount: 8,
        maxTerminalInputBytes: 65_536,
        maxListItems: 50,
      },
      serverTime: now,
    });
    expect(summary.capabilities).toEqual([
      { id: "codingAgentsProjectWorkspace", enabled: true },
      { id: "codingAgentsSameThreadTurns", enabled: true },
      { id: "codingAgentsConversationView", enabled: false },
      { id: "codingAgentsKanbanView", enabled: false },
    ]);
  });
});
