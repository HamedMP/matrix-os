import { describe, expect, it } from "vitest";
import { buildTuiDashboardModel, renderTuiDashboard } from "../../bin/tui/dashboard.js";

describe("TUI dashboard", () => {
  it("builds a keyboard-oriented dashboard model for projects, tasks, sessions, and reviews", () => {
    const model = buildTuiDashboardModel({
      projects: [{ slug: "repo", name: "Repo" }],
      tasks: [{ id: "task_abc123", title: "Fix auth", status: "running", priority: "high" }],
      sessions: [{ id: "sess_abc123", status: "running", projectSlug: "repo", taskId: "task_abc123" }],
      reviews: [{ id: "rev_abc123", status: "reviewing", projectSlug: "repo", round: 2 }],
    });

    expect(model.sections.map((section) => section.title)).toEqual(["Projects", "Tasks", "Sessions", "Reviews"]);
    expect(model.actions).toEqual(expect.arrayContaining(["attach", "observe", "open-worktree", "review-next"]));
    expect(renderTuiDashboard(model)).toContain("Repo");
    expect(renderTuiDashboard(model)).toContain("sess_abc123");
  });
});
