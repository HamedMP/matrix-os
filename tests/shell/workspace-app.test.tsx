// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceApp } from "../../shell/src/components/workspace/WorkspaceApp.js";

describe("WorkspaceApp", () => {
  beforeEach(() => {
    let createdWorktree: { id: string; currentBranch: string; dirtyState: string; pr?: number | { number: number } } | undefined;
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
      if (url.includes("/api/projects/repo/worktrees") && init?.method === "POST") {
        createdWorktree = { id: "wt_new123", currentBranch: "feature/mat-5", dirtyState: "clean", pr: { number: 88 } };
        return json({ worktree: createdWorktree });
      }
      if (url.includes("/api/projects/repo/worktrees")) {
        return json({
          worktrees: [
            { id: "wt_abc123", currentBranch: "feature/workspace", dirtyState: "dirty", pr: 77 },
            ...(createdWorktree ? [createdWorktree] : []),
          ],
        });
      }
      if (url.includes("/api/reviews")) {
        return json({ reviews: [{ id: "rev_abc123", status: "reviewing", round: 2 }] });
      }
      if (url.includes("/api/projects/repo/previews")) {
        return json({ previews: [{ id: "prev_abc123", label: "Local app", url: "http://localhost:3000", lastStatus: "ok" }] });
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary());
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
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { kind?: string } : {};
        return json({
          session: {
            id: body.kind === "agent" ? "sess_agent123" : "sess_duplicate",
            status: "starting",
          },
        });
      }
      if (url.includes("/api/sessions")) {
        return json({ sessions: [{
          id: "sess_abc123",
          status: "running",
          projectSlug: "repo",
          taskId: "task_0",
          worktreeId: "wt_abc123def456",
          pr: 77,
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
    delete document.documentElement.dataset.matrixSelfHosted;
  });

  it("renders project/task cockpit panels with bounded task virtualization and IDE links", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("Repo").length).toBeGreaterThan(0));

    expect(screen.getByTestId("workspace-shell").getAttribute("data-project-count")).toBe("120");
    expect(screen.getByText("1,000 tasks")).toBeTruthy();
    expect(screen.getByText("Task 0")).toBeTruthy();
    expect(screen.queryByText("Task 999")).toBeNull();
    expect(screen.getAllByText("feature/workspace").length).toBeGreaterThan(0);
    expect(screen.getByText(/Round 2/)).toBeTruthy();
    expect(screen.getByText("Local app").closest("a")?.getAttribute("href")).toBe("http://localhost:3000");
    expect(screen.getByText("Open IDE").getAttribute("href")).toContain("code.matrix-os.com");
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/terminal/sessions"), expect.anything());
  });

  it("renders validated coding-agent previews without launching local origins directly", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [{ slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } }] });
      }
      if (url.includes("/api/projects/repo/previews")) {
        return json({ previews: [] });
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary({
          previewSessions: {
            items: [
              {
                id: "prev_https",
                projectId: "repo",
                label: "Published preview",
                status: "running",
                origin: "https://preview.matrix-os.com",
                updatedAt: "2026-07-07T16:00:00.000Z",
              },
              {
                id: "prev_local",
                projectId: "repo",
                label: "Local dev server",
                status: "running",
                origin: "http://127.0.0.1:3000",
                updatedAt: "2026-07-07T16:01:00.000Z",
              },
              {
                id: "prev_other_project",
                projectId: "other-repo",
                label: "Other project preview",
                status: "running",
                origin: "https://other.matrix-os.com",
                updatedAt: "2026-07-07T16:02:00.000Z",
              },
            ],
            hasMore: false,
            limit: 50,
          },
        }));
      }
      if (url.includes("/api/projects/") || url.includes("/api/sessions") || url.includes("/api/reviews") || url.includes("/api/workspace/events")) {
        return json({ tasks: [], sessions: [], reviews: [], worktrees: [], previews: [], events: [] });
      }
      return json({});
    }));

    render(<WorkspaceApp initialProjectSlug="repo" />);

    expect(await screen.findByText("Published preview")).toBeTruthy();
    expect(screen.getByText("Local dev server")).toBeTruthy();
    expect(screen.getByText("https://preview.matrix-os.com")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:3000")).toBeTruthy();
    expect(screen.queryByText("Other project preview")).toBeNull();
    expect(screen.getByText("Published preview").closest("a")?.getAttribute("href")).toBe("https://preview.matrix-os.com");
    expect(screen.getByText("Local dev server").closest("a")).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/coding-agents/summary?projectId=repo"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("drops invalid coding-agent preview summaries without blocking the Workspace panel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [{ slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } }] });
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary({
          previewSessions: {
            items: [
              {
                id: "../secret",
                label: "/home/matrix/private",
                status: "running",
                origin: "https://preview.matrix-os.com/private",
              },
            ],
            hasMore: false,
            limit: 50,
          },
        }));
      }
      if (url.includes("/api/projects/") || url.includes("/api/sessions") || url.includes("/api/reviews") || url.includes("/api/workspace/events")) {
        return json({ tasks: [], sessions: [], reviews: [], worktrees: [], previews: [], events: [] });
      }
      return json({});
    }));

    render(<WorkspaceApp initialProjectSlug="repo" />);

    expect((await screen.findAllByText("Repo")).length).toBeGreaterThan(0);
    await waitFor(() => expect(warn).toHaveBeenCalledWith("Coding agent workspace summary unavailable"));
    expect(screen.queryByText("/home/matrix/private")).toBeNull();
    expect(screen.queryByText("https://preview.matrix-os.com")).toBeNull();
  });

  it("renders current-project coding-agent thread summaries from the runtime summary only", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [{ slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } }] });
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary({
          activeThreads: {
            items: [
              {
                id: "thread_active",
                providerId: "codex",
                title: "Implement checkout flow",
                status: "running",
                attention: "none",
                projectId: "repo",
                terminalSessionId: "matrix-agent",
                createdAt: "2026-07-07T16:00:00.000Z",
                updatedAt: "2026-07-07T16:03:00.000Z",
              },
              {
                id: "thread_duplicate",
                providerId: "codex",
                title: "Active duplicate survives",
                status: "running",
                attention: "none",
                projectId: "repo",
                createdAt: "2026-07-07T16:00:00.000Z",
                updatedAt: "2026-07-07T16:05:00.000Z",
              },
              {
                id: "thread_other_project",
                providerId: "claude",
                title: "Other project run",
                status: "running",
                attention: "none",
                projectId: "other-repo",
                createdAt: "2026-07-07T16:00:00.000Z",
                updatedAt: "2026-07-07T16:02:00.000Z",
              },
            ],
            hasMore: false,
            limit: 50,
          },
          attentionThreads: {
            items: [
              {
                id: "thread_duplicate",
                providerId: "codex",
                title: "Unscoped duplicate",
                status: "waiting_for_approval",
                attention: "approval_required",
                createdAt: "2026-07-07T16:00:00.000Z",
                updatedAt: "2026-07-07T16:06:00.000Z",
              },
              {
                id: "thread_attention",
                providerId: "codex",
                title: "Needs approval",
                status: "waiting_for_approval",
                attention: "approval_required",
                projectId: "repo",
                createdAt: "2026-07-07T16:00:00.000Z",
                updatedAt: "2026-07-07T16:04:00.000Z",
              },
            ],
            hasMore: false,
            limit: 50,
          },
        }));
      }
      if (url.includes("/api/projects/") || url.includes("/api/sessions") || url.includes("/api/reviews") || url.includes("/api/workspace/events")) {
        return json({ tasks: [], sessions: [], reviews: [], worktrees: [], previews: [], events: [] });
      }
      return json({});
    }));

    render(<WorkspaceApp initialProjectSlug="repo" />);

    expect(await screen.findByText("Coding Agents")).toBeTruthy();
    expect(screen.getByText("Needs approval")).toBeTruthy();
    expect(screen.getByText("approval required")).toBeTruthy();
    expect(screen.getByText("Implement checkout flow")).toBeTruthy();
    expect(screen.getByText("Active duplicate survives")).toBeTruthy();
    expect(screen.queryByText("Unscoped duplicate")).toBeNull();
    expect(screen.getAllByText("running · codex").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Terminal matrix-agent")).toBeTruthy();
    expect(screen.queryByText("Other project run")).toBeNull();
  });

  it("clears coding-agent preview rows when a project switch load fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [
          { slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } },
          { slug: "repo-2", name: "Project 2", github: { owner: "owner", repo: "repo-2" } },
        ] });
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary({
          previewSessions: {
            items: [
              {
                id: "prev_repo",
                projectId: "repo",
                label: "Repo preview",
                status: "running",
                origin: "https://repo-preview.matrix-os.com",
                updatedAt: "2026-07-07T16:00:00.000Z",
              },
            ],
            hasMore: false,
            limit: 50,
          },
        }));
      }
      if (url.includes("/api/projects/repo-2/tasks")) {
        return new Response(JSON.stringify({ error: "failed" }), { status: 500 });
      }
      if (url.includes("/api/projects/") || url.includes("/api/sessions") || url.includes("/api/reviews") || url.includes("/api/workspace/events")) {
        return json({ tasks: [], sessions: [], reviews: [], worktrees: [], previews: [], events: [] });
      }
      return json({});
    }));

    render(<WorkspaceApp initialProjectSlug="repo" />);

    expect(await screen.findByText("Repo preview")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Project 2"));
    });

    expect(await screen.findByText("Workspace request failed")).toBeTruthy();
    expect(screen.queryByText("Repo preview")).toBeNull();
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
    const duplicateCall = vi.mocked(global.fetch).mock.calls.find(
      ([url, init]) => /\/api\/sessions$/.test(String(url)) && init?.method === "POST",
    );
    expect(duplicateCall).toBeDefined();
    expect(JSON.parse(String(duplicateCall?.[1]?.body))).toMatchObject({
      kind: "agent",
      agent: "codex",
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      taskId: "task_0",
      pr: 77,
    });

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

  it("points IDE links at same-origin code-server in self-host mode", async () => {
    document.documentElement.dataset.matrixSelfHosted = "1";

    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("Repo").length).toBeGreaterThan(0));

    const ideLink = screen.getByText("Open IDE").closest("a");
    expect(ideLink?.getAttribute("href")).toBe(
      "/code/?folder=%2Fhome%2Fmatrixos%2Fhome%2Fprojects%2Frepo",
    );
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

  it("creates a branch worktree and starts a coding agent from Workspace", async () => {
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("Repo").length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feature/mat-5" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create worktree/i }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects/repo/worktrees"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "feature/mat-5" }),
      }),
    );
    await waitFor(() => expect((screen.getByLabelText("Agent worktree") as HTMLSelectElement).value).toBe("wt_new123"));

    fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "Implement MAT-5" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start agent/i }));
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "agent",
          agent: "codex",
          projectSlug: "repo",
          worktreeId: "wt_new123",
          pr: 88,
          prompt: "Implement MAT-5",
          runtimePreference: "zellij",
        }),
      }),
    );
    expect(await screen.findByText("Started sess_agent123")).toBeTruthy();
  });

  it("opens existing worktree pull requests through the Canvas PR workspace entry", async () => {
    const openPrCanvas = vi.fn();
    window.addEventListener("matrix:open-pr-canvas", openPrCanvas);

    try {
      render(<WorkspaceApp initialProjectSlug="repo" />);

      await waitFor(() => expect(screen.getAllByText("feature/workspace").length).toBeGreaterThan(0));

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Open PR workspace for PR 77" }));
      });

      expect(openPrCanvas).toHaveBeenCalledTimes(1);
      expect(openPrCanvas.mock.calls[0]?.[0]).toMatchObject({
        detail: {
          title: "PR 77 Workspace",
          scopeRef: {
            projectSlug: "repo",
            worktreeId: "wt_abc123",
            pullRequestNumber: 77,
          },
        },
      });
      expect(global.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/coding-agents/source-control"),
        expect.anything(),
      );
    } finally {
      window.removeEventListener("matrix:open-pr-canvas", openPrCanvas);
    }
  });

  it("clears pending project action spinners when switching projects", async () => {
    let resolveSession: (response: Response) => void = () => {};
    const pendingSession = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [
          { slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } },
          { slug: "repo-2", name: "Project 2", github: { owner: "owner", repo: "repo-2" } },
        ] });
      }
      if (url.includes("/api/projects/repo/worktrees")) {
        return json({ worktrees: [{ id: "wt_abc123", currentBranch: "feature/workspace", dirtyState: "clean" }] });
      }
      if (url.includes("/api/projects/repo-2/worktrees")) {
        return json({ worktrees: [{ id: "wt_two", currentBranch: "feature/two", dirtyState: "clean" }] });
      }
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return await pendingSession;
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary());
      }
      if (url.includes("/api/projects/") || url.includes("/api/sessions") || url.includes("/api/reviews") || url.includes("/api/workspace/events")) {
        return json({ tasks: [], sessions: [], reviews: [], previews: [], events: [] });
      }
      return json({});
    }));
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("feature/workspace").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "Implement MAT-5" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start agent/i }));
    });
    expect(screen.getByRole("button", { name: /starting/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Project 2"));
    });

    await waitFor(() => expect(screen.getAllByText("feature/two").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /start agent/i })).toBeTruthy();
    resolveSession(json({ session: { id: "sess_agent123", status: "starting" } }));
    await act(async () => {
      await pendingSession;
    });
    expect(screen.queryByText("Started sess_agent123")).toBeNull();
    expect(screen.queryByText("feature/workspace")).toBeNull();
    expect(screen.getAllByText("feature/two").length).toBeGreaterThan(0);
  });

  it("ignores stale worktree creation responses after switching projects", async () => {
    let resolveWorktree: (response: Response) => void = () => {};
    const pendingWorktree = new Promise<Response>((resolve) => {
      resolveWorktree = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [
          { slug: "repo", name: "Repo", github: { owner: "owner", repo: "repo" } },
          { slug: "repo-2", name: "Project 2", github: { owner: "owner", repo: "repo-2" } },
        ] });
      }
      if (url.includes("/api/projects/repo/worktrees") && init?.method === "POST") {
        return await pendingWorktree;
      }
      if (url.includes("/api/projects/repo/worktrees")) {
        return json({ worktrees: [{ id: "wt_abc123", currentBranch: "feature/workspace", dirtyState: "clean" }] });
      }
      if (url.includes("/api/projects/repo-2/worktrees")) {
        return json({ worktrees: [{ id: "wt_two", currentBranch: "feature/two", dirtyState: "clean" }] });
      }
      if (url.includes("/api/coding-agents/summary")) {
        return json(codingAgentRuntimeSummary());
      }
      if (url.includes("/api/projects/") || url.includes("/api/sessions") || url.includes("/api/reviews") || url.includes("/api/workspace/events")) {
        return json({ tasks: [], sessions: [], reviews: [], previews: [], events: [] });
      }
      return json({});
    }));
    render(<WorkspaceApp initialProjectSlug="repo" />);

    await waitFor(() => expect(screen.getAllByText("feature/workspace").length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feature/new" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create worktree/i }));
    });
    expect(screen.getByRole("button", { name: /creating/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Project 2"));
    });

    await waitFor(() => expect(screen.getAllByText("feature/two").length).toBeGreaterThan(0));
    resolveWorktree(json({ worktree: { id: "wt_new", currentBranch: "feature/new", dirtyState: "clean" } }));
    await act(async () => {
      await pendingWorktree;
    });

    expect(screen.queryByText("Created wt_new")).toBeNull();
    expect(screen.queryByText("feature/new")).toBeNull();
    expect(screen.getAllByText("feature/two").length).toBeGreaterThan(0);
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

function codingAgentRuntimeSummary(overrides: Record<string, unknown> = {}) {
  return {
    runtime: {
      id: "rt_browser",
      label: "Browser runtime",
      status: "available",
      channel: "dev",
      ownerHandle: "owner",
    },
    capabilities: [
      { id: "codingAgentsRuntimeSummary", enabled: true },
      { id: "codingAgentsPreview", enabled: true },
    ],
    providers: [],
    projects: { items: [], hasMore: false, limit: 50 },
    activeThreads: { items: [], hasMore: false, limit: 50 },
    attentionThreads: { items: [], hasMore: false, limit: 50 },
    terminalSessions: { items: [], hasMore: false, limit: 50 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 100 },
    limits: {
      maxPromptBytes: 65536,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 65536,
      maxListItems: 50,
    },
    serverTime: "2026-07-07T16:00:00.000Z",
    ...overrides,
  };
}

function json(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
