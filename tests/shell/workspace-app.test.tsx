// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceApp } from "../../shell/src/components/workspace/WorkspaceApp.js";

describe("WorkspaceApp", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: Array.from({ length: 120 }, (_, index) => ({
          slug: index === 0 ? "repo" : `repo-${index}`,
          name: index === 0 ? "Repo" : `Project ${index}`,
          github: { owner: "owner", repo: index === 0 ? "repo" : `repo-${index}` },
        })) });
      }
      if (url.endsWith("/api/projects") && init?.method === "POST") {
        return json({
          project: {
            slug: "new-repo",
            name: "new-repo",
            localPath: "/home/matrixos/home/projects/new-repo/repo",
            github: { owner: "owner", repo: "new-repo" },
          },
        });
      }
      if (url.includes("/api/projects/repo/tasks")) {
        return json({ tasks: Array.from({ length: 1000 }, (_, index) => ({
          id: `task_${index}`,
          title: `Task ${index}`,
          status: index % 2 === 0 ? "running" : "todo",
          priority: index % 5 === 0 ? "high" : "normal",
          order: index,
        })) });
      }
      if (url.includes("/api/projects/repo/worktrees")) {
        return json({ worktrees: [{ id: "wt_abc123", currentBranch: "feature/workspace", dirtyState: "dirty" }] });
      }
      if (url.includes("/api/reviews")) {
        return json({ reviews: [{ id: "rev_abc123", status: "reviewing", round: 2 }] });
      }
      if (url.includes("/api/projects/repo/previews")) {
        return json({ previews: [{ id: "prev_abc123", label: "Local app", url: "http://localhost:3000", lastStatus: "ok" }] });
      }
      if (url.includes("/api/workspace/events")) {
        return json({ events: [{ id: "evt_abc123", type: "task.updated", createdAt: "2026-04-26T00:00:00.000Z" }] });
      }
      if (url.includes("/api/sessions/sess_abc123/observe") && init?.method === "POST") {
        return json({ terminalSessionId: "term_abc123" });
      }
      if (url.includes("/api/sessions/sess_abc123/takeover") && init?.method === "POST") {
        return json({ terminalSessionId: "term_owner_abc123" });
      }
      if (url.includes("/api/sessions/sess_abc123") && init?.method === "DELETE") {
        return json({ session: { id: "sess_abc123", status: "exited" } });
      }
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return json({ session: { id: "sess_duplicate", status: "starting" } });
      }
      if (url.includes("/api/sessions")) {
        return json({ sessions: [{
          id: "sess_abc123",
          status: "running",
          projectSlug: "repo",
          taskId: "task_0",
          agent: "codex",
          runtime: { status: "running" },
          nativeAttachCommand: ["zellij", "attach", "matrix-sess_abc123"],
        }] });
      }
      return json({});
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders project/task cockpit panels with bounded task virtualization and IDE links", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("Repo").length).toBeGreaterThan(0));

    expect(screen.getByTestId("workspace-shell").getAttribute("data-project-count")).toBe("120");
    expect(screen.getByText("1,000 tasks")).toBeTruthy();
    expect(screen.getByText("Task 0")).toBeTruthy();
    expect(screen.queryByText("Task 999")).toBeNull();
    expect(screen.getByText("feature/workspace")).toBeTruthy();
    expect(screen.getByText(/Round 2/)).toBeTruthy();
    expect(screen.getByText("Local app").closest("a")?.getAttribute("href")).toBe("http://localhost:3000");
    expect(screen.getByText("Open IDE").getAttribute("href")).toContain("code.matrix-os.com");
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/terminal/sessions"), expect.anything());
  });

  it("converges from workspace events and controls running sessions through /api/sessions", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getByText("task.updated")).toBeTruthy());
    expect(screen.getByText("zellij attach matrix-sess_abc123")).toBeTruthy();
    expect(screen.getByText("running health")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search sessions"), { target: { value: "task_0" } });
    expect(screen.getByText("sess_abc123")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /attach sess_abc123/i }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/sess_abc123/observe"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("Attached term_abc123")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /take over sess_abc123/i }));
    });
    expect(await screen.findByText("Attached term_owner_abc123")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /duplicate sess_abc123/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions"),
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /kill sess_abc123/i }));
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/sess_abc123"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("anchors browser IDE file persistence and mobile/desktop workspace layouts", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("Repo").length).toBeGreaterThan(0));

    const ideLink = screen.getByText("Open IDE").closest("a");
    expect(ideLink?.getAttribute("data-folder")).toBe("/home/matrixos/home/projects/repo");
    expect(ideLink?.getAttribute("href")).toContain(encodeURIComponent("/home/matrixos/home/projects/repo"));

    expect(screen.getByTestId("workspace-layout").className).toContain("grid-cols-1");
    expect(screen.getByTestId("workspace-layout").className).toContain("lg:grid-cols-[240px_1fr_320px]");
    expect(screen.getByTestId("workspace-task-grid").className).toContain("grid-cols-1");
    expect(screen.getByTestId("workspace-task-grid").className).toContain("md:grid-cols-2");
    expect(screen.getByTestId("workspace-task-grid").className).toContain("xl:grid-cols-3");
  });

  it("creates a project from the Workspace sidebar", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("Repo").length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("GitHub repository URL"), { target: { value: "github.com/owner/new-repo" } });
    fireEvent.change(screen.getByLabelText("Project slug"), { target: { value: "new-repo" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add/i }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: "github.com/owner/new-repo", slug: "new-repo" }),
      }),
    );
  });

  it("shows an actionable empty state when no managed projects exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [] });
      }
      return json({});
    }));

    render(<WorkspaceApp />);

    expect(await screen.findByTestId("workspace-empty")).toBeTruthy();
    expect(screen.getByLabelText("GitHub repository URL")).toBeTruthy();
    expect(screen.getByText("No projects yet")).toBeTruthy();
  });
});

function json(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
