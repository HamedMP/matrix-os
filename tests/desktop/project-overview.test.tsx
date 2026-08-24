// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import ProjectOverview from "../../desktop/src/renderer/src/features/project/ProjectOverview";
import { useProjectWorkspaces } from "../../desktop/src/renderer/src/stores/project-workspaces";

function thread(index: number): AgentThreadSummary {
  return {
    id: `thread-${index}`,
    providerId: "codex",
    title: `Session ${index}`,
    status: "completed",
    attention: "none",
    projectId: "matrix-os",
    createdAt: new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 7, 20, 0, index)).toISOString(),
  };
}

function summaryWithThreads(items: AgentThreadSummary[]): RuntimeSummary {
  return {
    capabilities: [],
    providers: [{ id: "codex", kind: "codex", displayName: "Codex" }],
    activeThreads: { items, hasMore: false, limit: 50 },
    attentionThreads: { items: [], hasMore: false, limit: 50 },
  } as RuntimeSummary;
}

describe("ProjectOverview", () => {
  beforeEach(() => {
    useProjectWorkspaces.setState({ entries: {}, runtimeScope: null });
  });

  afterEach(cleanup);

  it("shows application-owned copy instead of a raw workspace error", () => {
    useProjectWorkspaces.setState({
      entries: {
        "matrix-os": {
          status: "error",
          workspace: null,
          error: "postgres failed at /home/matrix with sk-secret",
          fetchedAt: 0,
        },
      },
    });

    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={null}
        active={false}
        viewSwitch={null}
      />,
    );

    expect(screen.getByText("Project sessions are unavailable.")).toBeTruthy();
    expect(screen.queryByText(/postgres failed/)).toBeNull();
  });

  it("bounds the rendered recent-session collection", () => {
    render(
      <ProjectOverview
        projectId="matrix-os"
        projectLabel="Matrix OS"
        summary={summaryWithThreads(Array.from({ length: 120 }, (_, index) => thread(index)))}
        active={false}
        viewSwitch={null}
      />,
    );

    expect(screen.getAllByRole("button", { name: /Open session/ })).toHaveLength(100);
    expect(screen.getByRole("button", { name: "Open session Session 119" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open session Session 0" })).toBeNull();
  });
});
