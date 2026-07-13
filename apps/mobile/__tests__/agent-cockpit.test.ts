import type { AgentThreadSummary, ProjectSummary, RuntimeSummary } from "@matrix-os/contracts";
import { buildAgentCockpit, formatRelativeAge } from "../lib/agent-cockpit";

function thread(overrides: Partial<AgentThreadSummary>): AgentThreadSummary {
  return {
    id: "thread_default",
    providerId: "codex",
    title: "Default run",
    status: "running",
    attention: "none",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:01:00.000Z",
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: "matrix-os",
    label: "Matrix OS",
    status: "available",
    taskCount: 0,
    threadCount: 0,
    attentionCount: 0,
    ...overrides,
  };
}

function summaryLists(
  activeThreads: AgentThreadSummary[],
  attentionThreads: AgentThreadSummary[],
  projects: ProjectSummary[] = [],
): Pick<RuntimeSummary, "activeThreads" | "attentionThreads" | "projects"> {
  return {
    activeThreads: { items: activeThreads, hasMore: false, limit: 20 },
    attentionThreads: { items: attentionThreads, hasMore: false, limit: 20 },
    projects: { items: projects, hasMore: false, limit: 50 },
  };
}

describe("buildAgentCockpit", () => {
  it("deduplicates gateway attention threads and removes them from working", () => {
    const approval = thread({
      id: "thread_approval",
      title: "Approve deployment",
      status: "waiting_for_approval",
      attention: "approval_required",
    });
    const working = thread({ id: "thread_working", title: "Build mobile cockpit" });

    const model = buildAgentCockpit(summaryLists([approval, working], [approval]));

    expect(model.needsAttention.map((item) => item.id)).toEqual(["thread_approval"]);
    expect(model.working.map((item) => item.id)).toEqual(["thread_working"]);
  });

  it("prioritizes approvals, input requests, and failures before recency", () => {
    const model = buildAgentCockpit(summaryLists([], [
      thread({ id: "thread_failed", attention: "failed", status: "failed", updatedAt: "2026-07-06T00:12:00.000Z" }),
      thread({ id: "thread_input", attention: "input_required", status: "waiting_for_input", updatedAt: "2026-07-06T00:11:00.000Z" }),
      thread({ id: "thread_approval", attention: "approval_required", status: "waiting_for_approval", updatedAt: "2026-07-06T00:10:00.000Z" }),
    ]));

    expect(model.needsAttention.map((item) => item.id)).toEqual([
      "thread_approval",
      "thread_input",
      "thread_failed",
    ]);
  });

  it("projects every valid attention state without dropping completed work", () => {
    const model = buildAgentCockpit(summaryLists([
      thread({ id: "thread_none", attention: "none", status: "running" }),
      thread({ id: "thread_approval", attention: "approval_required", status: "waiting_for_approval" }),
      thread({ id: "thread_input", attention: "input_required", status: "waiting_for_input" }),
      thread({ id: "thread_failed", attention: "failed", status: "failed" }),
      thread({ id: "thread_completed", attention: "completed", status: "completed" }),
    ], []));

    expect(model.needsAttention.map((item) => item.id)).toEqual([
      "thread_approval",
      "thread_input",
      "thread_failed",
    ]);
    expect(model.working.map((item) => item.id)).toEqual(["thread_none"]);
    expect(model.recent.map((item) => item.id)).toEqual(["thread_completed"]);
  });

  it("preserves every recoverable stale and terminal thread from the bounded summary", () => {
    const terminalStatuses = ["completed", "aborted", "stale", "archived"] as const;
    const terminalThreads = terminalStatuses.map((status, index) => thread({
      id: `thread_${status}`,
      title: `${status} run`,
      status,
      attention: status === "completed" ? "completed" : "none",
      updatedAt: `2026-07-06T00:0${index + 1}:00.000Z`,
    }));
    const overflow = Array.from({ length: 4 }, (_, index) => thread({
      id: `thread_old_${index}`,
      status: "completed",
      attention: "completed",
      updatedAt: `2026-07-05T00:0${index}:00.000Z`,
    }));

    const model = buildAgentCockpit(summaryLists([...terminalThreads, ...overflow], []));

    expect(model.recent).toHaveLength(8);
    expect(model.recent.map((item) => item.id)).toEqual([
      "thread_archived",
      "thread_stale",
      "thread_aborted",
      "thread_completed",
      "thread_old_3",
      "thread_old_2",
      "thread_old_1",
      "thread_old_0",
    ]);
  });

  describe("project groups", () => {
    it("groups non-attention threads by project with labels from the summary", () => {
      const model = buildAgentCockpit(summaryLists(
        [
          thread({ id: "thread_a", projectId: "matrix-os", updatedAt: "2026-07-06T00:05:00.000Z" }),
          thread({ id: "thread_b", projectId: "my-app", status: "completed", attention: "completed", updatedAt: "2026-07-06T00:03:00.000Z" }),
        ],
        [],
        [
          project({ id: "matrix-os", label: "Matrix OS" }),
          project({ id: "my-app", label: "My App" }),
        ],
      ));

      expect(model.projects.map((group) => group.label)).toEqual(["Matrix OS", "My App"]);
      expect(model.projects[0].threads.map((item) => item.id)).toEqual(["thread_a"]);
      expect(model.projects[1].threads.map((item) => item.id)).toEqual(["thread_b"]);
    });

    it("groups threads without a project under No project, ordered by activity", () => {
      const model = buildAgentCockpit(summaryLists(
        [
          thread({ id: "thread_orphan", updatedAt: "2026-07-06T00:09:00.000Z" }),
          thread({ id: "thread_bound", projectId: "matrix-os", updatedAt: "2026-07-06T00:01:00.000Z" }),
        ],
        [],
        [project({ id: "matrix-os", label: "Matrix OS" })],
      ));

      expect(model.projects.map((group) => group.projectId)).toEqual([null, "matrix-os"]);
      expect(model.projects[0].label).toBe("No project");
      expect(model.projects[0].threads.map((item) => item.id)).toEqual(["thread_orphan"]);
    });

    it("keeps known projects visible even when they have no threads", () => {
      const model = buildAgentCockpit(summaryLists(
        [thread({ id: "thread_a", projectId: "matrix-os" })],
        [],
        [
          project({ id: "matrix-os", label: "Matrix OS" }),
          project({ id: "empty-b", label: "Beta" }),
          project({ id: "empty-a", label: "Alpha" }),
        ],
      ));

      expect(model.projects.map((group) => group.label)).toEqual(["Matrix OS", "Alpha", "Beta"]);
      expect(model.projects[1].threads).toEqual([]);
      expect(model.projects[2].threads).toEqual([]);
    });

    it("excludes attention threads from group lists but counts them per project", () => {
      const approval = thread({
        id: "thread_approval",
        projectId: "matrix-os",
        status: "waiting_for_approval",
        attention: "approval_required",
      });
      const model = buildAgentCockpit(summaryLists(
        [approval, thread({ id: "thread_running", projectId: "matrix-os" })],
        [approval],
        [project({ id: "matrix-os", label: "Matrix OS" })],
      ));

      const group = model.projects.find((entry) => entry.projectId === "matrix-os");
      expect(group?.threads.map((item) => item.id)).toEqual(["thread_running"]);
      expect(group?.attentionCount).toBe(1);
      expect(group?.workingCount).toBe(1);
    });

    it("orders working threads before finished ones inside a group", () => {
      const model = buildAgentCockpit(summaryLists(
        [
          thread({ id: "thread_done", projectId: "matrix-os", status: "completed", attention: "completed", updatedAt: "2026-07-06T00:09:00.000Z" }),
          thread({ id: "thread_running", projectId: "matrix-os", updatedAt: "2026-07-06T00:01:00.000Z" }),
        ],
        [],
        [project({ id: "matrix-os", label: "Matrix OS" })],
      ));

      expect(model.projects[0].threads.map((item) => item.id)).toEqual(["thread_running", "thread_done"]);
    });

    it("labels threads bound to unknown projects without dropping them", () => {
      const model = buildAgentCockpit(summaryLists(
        [thread({ id: "thread_ghost", projectId: "deleted-project" })],
        [],
        [],
      ));

      expect(model.projects).toHaveLength(1);
      expect(model.projects[0].label).toBe("deleted-project");
      expect(model.projects[0].threads.map((item) => item.id)).toEqual(["thread_ghost"]);
    });
  });
});

describe("formatRelativeAge", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");

  it("formats ages from seconds to days", () => {
    expect(formatRelativeAge("2026-07-13T11:59:40.000Z", now)).toBe("now");
    expect(formatRelativeAge("2026-07-13T11:12:00.000Z", now)).toBe("48m");
    expect(formatRelativeAge("2026-07-13T05:00:00.000Z", now)).toBe("7h");
    expect(formatRelativeAge("2026-07-09T12:00:00.000Z", now)).toBe("4d");
  });

  it("returns empty for invalid or future timestamps", () => {
    expect(formatRelativeAge("not-a-date", now)).toBe("");
    expect(formatRelativeAge("2026-07-14T12:00:00.000Z", now)).toBe("now");
  });
});
