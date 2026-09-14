import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useCodingAgentWorkspace } from "@desktop/renderer/src/stores/coding-agent-workspace";
import { useProjectLifecycle } from "@desktop/renderer/src/stores/project-lifecycle";
import { useProjectView } from "@desktop/renderer/src/stores/project-view";
import { useProjectWorkspaces } from "@desktop/renderer/src/stores/project-workspaces";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function project(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `proj_${slug}`,
    slug,
    name: slug === "repo" ? "Repo" : "Other",
    kind: "scratch",
    localPath: `/home/matrix/home/projects/${slug}/repo`,
    addedAt: "2026-08-06T10:00:00.000Z",
    updatedAt: "2026-08-06T10:00:00.000Z",
    ownerScope: { type: "user", id: "user_123" },
    ...overrides,
  };
}

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get: vi.fn(async (path: string) => path.includes("visibility=archived")
      ? { projects: [] }
      : { projects: [project("other")] }),
    post: vi.fn(async () => ({ ok: true })),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
    putText: vi.fn(),
    ...overrides,
  } as ApiClient;
}

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
  useProjectLifecycle.setState(useProjectLifecycle.getInitialState(), true);
  useTabs.setState({ tabs: [], activeTabId: null });
  useProjectWorkspaces.setState({
    entries: {
      repo: { status: "ready", workspace: null, error: null, fetchedAt: 1 },
    },
    runtimeScope: "scope",
  });
  useProjectView.setState({
    entries: { repo: { view: "chats", selectedThreadId: "thread_1", touchedAt: 1 } },
    runtimeScope: "scope",
  });
  useCodingAgentWorkspace.setState({ refresh: vi.fn(async () => undefined) });
  useBoard.setState({
    projects: [
      { slug: "repo", name: "Repo", kind: "scratch" },
      { slug: "other", name: "Other", kind: "scratch" },
    ],
    activeProjectSlug: "repo",
    cardsByProject: { repo: [], other: [] },
  });
  useTabs.getState().openTab({ kind: "home", title: "Home", closable: false });
  useTabs.getState().openTab({ kind: "project", projectSlug: "repo", title: "Repo" });
});

describe("project lifecycle store", () => {
  it("loads the archived projection separately from active sidebar projects", async () => {
    const client = api({
      get: vi.fn(async () => ({
        projects: [project("repo", { archivedAt: "2026-08-06T13:00:00.000Z" })],
      })),
    });

    await useProjectLifecycle.getState().loadArchivedProjects(client);

    expect(client.get).toHaveBeenCalledWith("/api/workspace/projects?visibility=archived");
    expect(useProjectLifecycle.getState().archivedProjects).toMatchObject([
      { slug: "repo", kind: "scratch", archivedAt: "2026-08-06T13:00:00.000Z" },
    ]);
  });

  it("does not treat active projects from an older gateway as archived", async () => {
    const client = api({
      get: vi.fn(async () => ({ projects: [project("repo")] })),
    });

    await useProjectLifecycle.getState().loadArchivedProjects(client);

    expect(useProjectLifecycle.getState().archivedProjects).toEqual([]);
  });

  it("keeps project UI state intact until archive succeeds", async () => {
    const pending = deferred<unknown>();
    const client = api({ post: vi.fn(() => pending.promise) });

    const action = useProjectLifecycle.getState().archiveProject(client, "repo");
    expect(useBoard.getState().projects.map((item) => item.slug)).toContain("repo");
    expect(useTabs.getState().tabs.some((tab) => tab.projectSlug === "repo")).toBe(true);

    pending.resolve({ ok: true, action: "archive", project: project("repo", { archivedAt: "2026-08-06T13:00:00.000Z" }) });
    await expect(action).resolves.toBe(true);

    expect(useBoard.getState().projects.map((item) => item.slug)).toEqual(["other"]);
    expect(useTabs.getState().tabs.some((tab) => tab.projectSlug === "repo")).toBe(false);
    expect(useProjectWorkspaces.getState().entries.repo).toBeUndefined();
    expect(useProjectView.getState().entries.repo).toBeUndefined();
  });

  it("preserves project UI state and shows allowlisted copy when the server rejects the action", async () => {
    const client = api({
      post: vi.fn(async () => {
        throw new AppError("server", { detail: "project_active" });
      }),
    });

    await expect(useProjectLifecycle.getState().deleteProject(client, "repo", "Repo")).resolves.toBe(false);

    expect(useBoard.getState().projects.map((item) => item.slug)).toContain("repo");
    expect(useTabs.getState().tabs.some((tab) => tab.projectSlug === "repo")).toBe(true);
    expect(useProjectLifecycle.getState().error).toBe("Stop active project work before continuing.");
  });

  it("explains when an installed update is not the bundle serving project actions", async () => {
    const client = api({
      get: vi.fn(async () => ({
        version: "v2026.08.19-1002",
        runningVersion: "v2026.08.18-997",
      })),
      post: vi.fn(async () => {
        throw new AppError("notFound");
      }),
    });

    await expect(useProjectLifecycle.getState().archiveProject(client, "repo")).resolves.toBe(false);

    expect(useProjectLifecycle.getState().error).toBe(
      "This computer has not finished applying its update. Restart Matrix services, then try again.",
    );
    expect(client.get).toHaveBeenCalledWith("/api/system/info");
  });

  it("does not claim an update is missing when installed and running versions match", async () => {
    const client = api({
      get: vi.fn(async () => ({
        version: "v2026.08.19-1002",
        runningVersion: "v2026.08.19-1002",
      })),
      post: vi.fn(async () => {
        throw new AppError("notFound");
      }),
    });

    await expect(useProjectLifecycle.getState().archiveProject(client, "repo")).resolves.toBe(false);

    expect(useProjectLifecycle.getState().error).toBe(
      "Project management is unavailable on this computer. Restart Matrix services and try again.",
    );
  });

  it("preserves structured not-found errors without probing system identity", async () => {
    const client = api({
      post: vi.fn(async () => {
        throw new AppError("notFound", { detail: "not_found" });
      }),
    });

    await expect(useProjectLifecycle.getState().archiveProject(client, "repo")).resolves.toBe(false);

    expect(useProjectLifecycle.getState().error).toBe("That item could not be found.");
    expect(client.get).not.toHaveBeenCalledWith("/api/system/info");
  });

  it("falls back to safe restart guidance when runtime identity cannot be inspected", async () => {
    const client = api({
      get: vi.fn(async () => {
        throw new AppError("offline");
      }),
      post: vi.fn(async () => {
        throw new AppError("notFound");
      }),
    });

    await expect(useProjectLifecycle.getState().archiveProject(client, "repo")).resolves.toBe(false);

    expect(useProjectLifecycle.getState().error).toBe(
      "Project management is unavailable on this computer. Restart Matrix services and try again.",
    );
  });

  it("does not apply a stale diagnostic after the active runtime changes", async () => {
    const systemInfo = deferred<unknown>();
    const client = api({
      get: vi.fn(() => systemInfo.promise),
      post: vi.fn(async () => {
        throw new AppError("notFound");
      }),
    });

    const action = useProjectLifecycle.getState().archiveProject(client, "repo");
    await vi.waitFor(() => expect(client.get).toHaveBeenCalledWith("/api/system/info"));
    advanceRuntimeGeneration();
    useProjectLifecycle.setState(useProjectLifecycle.getInitialState(), true);
    systemInfo.resolve({
      version: "v2026.08.19-1002",
      runningVersion: "v2026.08.18-997",
    });

    await expect(action).resolves.toBe(false);
    expect(useProjectLifecycle.getState().error).toBeNull();
  });

  it("sends exact typed confirmation when permanently deleting a project", async () => {
    const post = vi.fn(async () => ({ ok: true, action: "delete", projectSlug: "repo" }));
    const client = api({ post });

    await expect(useProjectLifecycle.getState().deleteProject(client, "repo", "Repo")).resolves.toBe(true);

    expect(post).toHaveBeenCalledWith("/api/projects/repo/actions", {
      type: "delete",
      confirmation: "Repo",
    });
  });

  it("keeps a safe reconciliation error when the mutation succeeds but project refresh fails", async () => {
    const client = api({
      get: vi.fn(async () => { throw new AppError("offline"); }),
    });

    await expect(useProjectLifecycle.getState().archiveProject(client, "repo")).resolves.toBe(true);

    expect(useProjectLifecycle.getState()).toMatchObject({
      pendingProjectSlug: null,
      error: "Project updated, but project lists could not be refreshed. Try again.",
    });
  });
});
