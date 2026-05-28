import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { ProjectViews } from "../../src/cli/tui/views/ProjectViews.js";
import { ReviewTaskViews } from "../../src/cli/tui/views/ReviewTaskViews.js";
import { WorkspaceDataViews } from "../../src/cli/tui/views/WorkspaceDataViews.js";

describe("workspace cockpit views", () => {
  it("renders projects, worktrees, reviews, tasks, previews, events, and data actions", () => {
    expect(renderToString(<ProjectViews projects={[{ slug: "repo", name: "Repo" }]} worktrees={[{ id: "wt_1", projectSlug: "repo", branch: "main" }]} noColor />)).toContain("Repo");
    expect(renderToString(<ReviewTaskViews reviews={[{ id: "rev_1", status: "running" }]} tasks={[{ id: "task_1", title: "Fix auth", status: "todo" }]} noColor />)).toContain("Fix auth");
    const data = renderToString(<WorkspaceDataViews previews={[{ id: "prev_1", label: "Local", url: "http://localhost:3000" }]} events={[{ id: "evt_1", type: "task.created" }]} noColor />);
    expect(data).toContain("Local");
    expect(data).toContain("Export workspace");
    expect(data).toContain("Delete workspace data");
  });
});
