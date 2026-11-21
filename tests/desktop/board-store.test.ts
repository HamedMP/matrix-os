import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useBoard } from "@desktop/renderer/src/stores/board";

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue({ tasks: [], nextCursor: null }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
});

describe("createProject", () => {
  it("keeps the gateway-owned folder and optional GitHub capability", async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({
        projects: [
          { slug: "folder", name: "Folder", kind: "folder", localPath: "/home/matrix/home/workspaces/folder" },
          { slug: "repo", name: "Repo", kind: "github", localPath: "/home/matrix/home/projects/repo/repo", defaultBranch: "main", github: { owner: "o", repo: "r" } },
        ],
      }),
    });

    await useBoard.getState().loadProjects(api);

    expect(useBoard.getState().projects).toEqual([
      { slug: "folder", name: "Folder", kind: "folder", localPath: "/home/matrix/home/workspaces/folder", githubBacked: false },
      {
        slug: "repo",
        name: "Repo",
        kind: "github",
        localPath: "/home/matrix/home/projects/repo/repo",
        githubBacked: true,
        github: { owner: "o", repo: "r" },
        repository: "o/r",
        defaultBranch: "main",
      },
    ]);
  });

  it("POSTs a scratch project and refreshes the list", async () => {
    const post = vi.fn().mockResolvedValue({ project: { slug: "my-app", name: "My App" } });
    const get = vi.fn().mockResolvedValue({ projects: [{ slug: "my-app", name: "My App" }] });
    const api = makeApi({ post, get });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });
    expect(post).toHaveBeenCalledWith("/api/projects", {
      name: "My App",
      mode: "scratch",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }, { timeoutMs: 30_000 });
    expect(project).toEqual({ slug: "my-app", name: "My App", kind: "scratch" });
    expect(useBoard.getState().projects).toEqual([{ slug: "my-app", name: "My App", kind: "scratch" }]);
  });

  it("persists the optional project goal with project creation", async () => {
    const post = vi.fn().mockResolvedValue({
      project: { slug: "portfolio", name: "Portfolio", description: "Build my portfolio" },
    });
    const get = vi.fn().mockResolvedValue({ projects: [] });
    const api = makeApi({ post, get });

    await useBoard.getState().createProject(api, {
      name: "Portfolio",
      description: "Build my portfolio",
      mode: "scratch",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ description: "Build my portfolio" }),
      { timeoutMs: 30_000 },
    );
  });

  it("recovers a timed-out project create with one idempotent retry", async () => {
    const createdResponse = { project: { slug: "my-app", name: "My App" } };
    const post = vi.fn()
      .mockRejectedValueOnce(new AppError("timeout"))
      .mockResolvedValueOnce(createdResponse);
    const get = vi.fn().mockResolvedValue({ projects: [createdResponse.project] });
    const api = makeApi({ post, get });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toEqual({ slug: "my-app", name: "My App", kind: "scratch" });
    expect(post).toHaveBeenCalledTimes(2);
    const firstBody = post.mock.calls[0]?.[1];
    const retryBody = post.mock.calls[1]?.[1];
    expect(firstBody).toMatchObject({
      name: "My App",
      mode: "scratch",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    });
    expect(retryBody).toEqual(firstBody);
    expect(post.mock.calls[0]?.[2]).toEqual({ timeoutMs: 30_000 });
    expect(post.mock.calls[1]?.[2]).toEqual({ timeoutMs: 310_000 });
    expect(useBoard.getState().error).toBeNull();
  });

  it("sends the url for a github project", async () => {
    const post = vi.fn().mockResolvedValue({ project: { slug: "repo", name: "repo" } });
    const api = makeApi({ post, get: vi.fn().mockResolvedValue({ projects: [] }) });
    await useBoard.getState().createProject(api, { name: "repo", mode: "github", url: "https://github.com/o/repo" });
    expect(post).toHaveBeenCalledWith("/api/projects", {
      name: "repo",
      mode: "github",
      url: "https://github.com/o/repo",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }, { timeoutMs: 30_000 });
  });

  it("connects a project to an existing computer folder", async () => {
    const post = vi.fn().mockResolvedValue({
      project: { slug: "app", name: "App", localPath: "/home/matrix/home/workspaces/app" },
    });
    const api = makeApi({ post, get: vi.fn().mockResolvedValue({ projects: [] }) });

    await useBoard.getState().createProject(api, {
      name: "App",
      mode: "folder",
      path: "workspaces/app",
    });

    expect(post).toHaveBeenCalledWith("/api/projects", {
      name: "App",
      mode: "folder",
      path: "workspaces/app",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }, { timeoutMs: 30_000 });
  });

  it("preserves the refresh error when creation succeeds but the project list reload fails", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ project: { slug: "my-app", name: "My App" } }),
      get: vi.fn().mockRejectedValue(new AppError("offline")),
    });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toEqual({ slug: "my-app", name: "My App", kind: "scratch" });
    expect(useBoard.getState().error).toBe("offline");
  });

  it("refreshes projects even when a successful create response is malformed", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ project: { name: "Missing slug" } }),
      get: vi.fn().mockResolvedValue({ projects: [{ slug: "my-app", name: "My App" }] }),
    });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/api/workspace/projects");
    expect(useBoard.getState().projects).toEqual([{ slug: "my-app", name: "My App", kind: "scratch" }]);
    expect(useBoard.getState().error).toBe("server");
  });

  it("returns null and sets an error category on failure", async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new AppError("server")) });
    const project = await useBoard.getState().createProject(api, { name: "x", mode: "scratch" });
    expect(project).toBeNull();
    expect(useBoard.getState().error).toBe("server");
  });
});

describe("loadProjects", () => {
  it("loads the project list from /api/workspace/projects", async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({
        projects: [
          { id: "p1", slug: "proj", name: "Proj", localPath: "/x", addedAt: "", updatedAt: "", ownerScope: { type: "user", id: "u" } },
        ],
        nextCursor: null,
      }),
    });
    await useBoard.getState().loadProjects(api);
    expect(api.get).toHaveBeenCalledWith("/api/workspace/projects");
    expect(useBoard.getState().projects).toEqual([{
      id: "p1",
      slug: "proj",
      name: "Proj",
      kind: "scratch",
      localPath: "/x",
      githubBacked: false,
    }]);
    expect(useBoard.getState().error).toBeNull();
  });

  it("maps failures to an error category, never raw messages", async () => {
    const api = makeApi({
      get: vi.fn().mockRejectedValue(new AppError("offline")),
    });
    await useBoard.getState().loadProjects(api);
    expect(useBoard.getState().error).toBe("offline");
    expect(useBoard.getState().projects).toEqual([]);
  });
});

describe("selectProject", () => {
  it("records the active project without reading its tasks", () => {
    useBoard.getState().selectProject("proj");
    expect(useBoard.getState().activeProjectSlug).toBe("proj");
    expect(Object.keys(useBoard.getState())).not.toContain("cardsByProject");
  });
});
