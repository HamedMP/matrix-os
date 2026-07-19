import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import {
  countLabel,
  runtimeCapabilityEnabled,
  taskThreads,
} from "../components/agents/agent-project-utils";

const taskThread = {
  id: "thread_one",
  providerId: "codex",
  title: "First task conversation",
  status: "running",
  attention: "none",
  projectId: "matrix-os",
  taskId: "task_one",
  createdAt: "2026-07-10T13:00:00.000Z",
  updatedAt: "2026-07-10T13:30:00.000Z",
} satisfies AgentThreadSummary;

describe("agent project presentation helpers", () => {
  it("formats bounded aggregate counts consistently", () => {
    expect(countLabel(1, "conversation")).toBe("1 conversation");
    expect(countLabel(2, "conversation")).toBe("2 conversations");
  });

  it("selects task conversations from the gateway projection", () => {
    const projection = {
      taskThreads: {
        items: [
          taskThread,
          { ...taskThread, id: "thread_two", taskId: "task_two" },
        ],
        hasMore: false,
        limit: 100,
      },
    } satisfies Pick<ProjectAgentWorkspace, "taskThreads">;

    expect(taskThreads(projection, "task_one")).toEqual([taskThread]);
  });

  it("checks only typed runtime capability identifiers", () => {
    const projection = {
      capabilities: [{ id: "codingAgentsKanbanView", enabled: true }],
    } satisfies Pick<RuntimeSummary, "capabilities">;

    expect(runtimeCapabilityEnabled(projection, "codingAgentsKanbanView")).toBe(true);
    expect(runtimeCapabilityEnabled(projection, "codingAgentsConversationView")).toBe(false);
  });
});
