// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceApp } from "../../shell/src/components/workspace/WorkspaceApp.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function ticket(index: number, sourceKind: "linear" | "matrix") {
  return {
    id: `ticket_${index}`,
    identifier: `${sourceKind === "linear" ? "LIN" : "MAT"}-${index}`,
    sourceKind,
    sourceId: `${sourceKind}_${index}`,
    title: `Ticket ${index}`,
    status: index % 3 === 0 ? "In Progress" : "Todo",
    priority: index % 5 === 0 ? "high" : "medium",
    syncStatus: sourceKind === "linear" ? "synced" : "local",
    revision: 1,
    labelIds: ["desktop"],
    assigneeIds: index % 2 === 0 ? ["hamed"] : [],
  };
}

describe("WorkspaceApp unified tickets", () => {
  beforeEach(() => {
    const tickets = Array.from({ length: 200 }, (_, index) => ticket(index + 1, index % 2 === 0 ? "linear" : "matrix"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [{ slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } }] });
      }
      if (url.includes("/api/projects/repo/tickets")) return json({ tickets, nextCursor: null });
      if (url.includes("/api/projects/repo/tasks")) return json({ tasks: [] });
      if (url.includes("/api/reviews")) return json({ reviews: [] });
      if (url.includes("/api/projects/repo/worktrees")) return json({ worktrees: [] });
      if (url.includes("/api/projects/repo/previews")) return json({ previews: [] });
      if (url.includes("/api/workspace/events")) return json({ events: [] });
      if (url.includes("/api/projects/repo/workflow")) return json({ workflow: {}, codex: { status: "valid" } });
      if (url.includes("/api/sessions")) return json({ sessions: [] });
      return json({});
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a unified Linear and Matrix ticket board at 200-ticket scale", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getByText("Unified tickets")).toBeTruthy());
    expect(screen.getByText("Showing 80 of 200 tickets")).toBeTruthy();
    expect(screen.getAllByText("Linear").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Matrix").length).toBeGreaterThan(0);
    expect(screen.getByText("LIN-1")).toBeTruthy();
    expect(screen.getByText("MAT-2")).toBeTruthy();
  });
});
