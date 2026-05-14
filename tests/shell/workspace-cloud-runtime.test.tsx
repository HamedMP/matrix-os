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

describe("WorkspaceApp cloud runtime", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [{ slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } }] });
      }
      if (url.includes("/api/projects/repo/tasks")) return json({ tasks: [] });
      if (url.includes("/api/reviews")) return json({ reviews: [] });
      if (url.includes("/api/projects/repo/worktrees")) {
        return json({ worktrees: [{ id: "wt_123", currentBranch: "feature/cloud", dirtyState: "clean" }] });
      }
      if (url.includes("/api/projects/repo/previews")) return json({ previews: [] });
      if (url.includes("/api/workspace/events")) return json({ events: [] });
      if (url.includes("/api/projects/repo/workflow")) {
        return json({
          workflow: {
            setupConfigured: true,
            liveConfigured: true,
            allowedPreviewPorts: [3000],
            codexRequired: true,
          },
          codex: { status: "valid" },
        });
      }
      if (url.includes("/api/sessions")) {
        return json({
          sessions: [{
            id: "sess_cloud",
            status: "running",
            agent: "codex",
            runtime: { status: "running" },
            cloudRuntime: { mode: "cloud", status: "running", type: "zellij" },
          }],
        });
      }
      return json({});
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows cloud-only runtime state for sessions and agent launch", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getByText("sess_cloud")).toBeTruthy());
    expect(screen.getByText("Cloud runtime")).toBeTruthy();
    expect(screen.getByText("Workflow setup")).toBeTruthy();
    expect(screen.getByText("valid")).toBeTruthy();
    expect(screen.getAllByText(/cloud only/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/local agent/i)).toBeNull();
  });
});
