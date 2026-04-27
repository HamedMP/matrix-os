import { describe, expect, it } from "vitest";
import { buildTuiDashboardModel, renderTuiDashboard } from "../../bin/tui/dashboard.js";
import { renderInkDashboardToString } from "../../bin/tui/app.js";

describe("TUI dashboard", () => {
  it("builds a keyboard-oriented dashboard model for projects, tasks, sessions, and reviews", () => {
    const model = buildTuiDashboardModel({
      projects: [{ slug: "repo", name: "Repo" }],
      pullRequests: [{ number: 42, title: "Fix login", headRef: "fix-login" }],
      worktrees: [{ id: "wt_abc123def456", currentBranch: "feature/workspace", dirtyState: "dirty" }],
      tasks: [{ id: "task_abc123", title: "Fix auth", status: "running", priority: "high" }],
      sessions: [{ id: "sess_abc123", status: "running", projectSlug: "repo", taskId: "task_abc123", nativeAttachCommand: ["zellij", "attach", "matrix-sess_abc123"] }],
      reviews: [{ id: "rev_abc123", status: "reviewing", projectSlug: "repo", round: 2 }],
    });

    expect(model.sections.map((section) => section.title)).toEqual(["Projects", "Pull Requests", "Worktrees", "Tasks", "Sessions", "Reviews"]);
    expect(model.actions).toEqual(expect.arrayContaining(["attach", "observe", "takeover", "native-terminal", "open-worktree", "review-next"]));
    expect(renderTuiDashboard(model)).toContain("Repo");
    expect(renderTuiDashboard(model)).toContain("sess_abc123");
    expect(renderTuiDashboard(model)).toContain("zellij attach matrix-sess_abc123");
  });

  it("renders the Ink dashboard shell with keyboard help", () => {
    const model = buildTuiDashboardModel({
      projects: [{ slug: "repo", name: "Repo" }],
      pullRequests: [{ number: 42, title: "Fix login", headRef: "fix-login" }],
      worktrees: [{ id: "wt_abc123def456", currentBranch: "feature/workspace", dirtyState: "dirty" }],
      tasks: [{ id: "task_abc123", title: "Fix auth", status: "running", priority: "high" }],
      sessions: [{ id: "sess_abc123", status: "running", projectSlug: "repo", taskId: "task_abc123" }],
      reviews: [{ id: "rev_abc123", status: "reviewing", projectSlug: "repo", round: 2 }],
    });

    const rendered = renderInkDashboardToString({ model });

    expect(rendered).toContain("Matrix OS Workspace");
    expect(rendered).toContain("j/k");
    expect(rendered).toContain("Pull Requests");
  });
});
