import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { useArchiveProject, useCreateProject, useRenameProject } from "../lib/queries/use-project-mutations";
import { useProjects } from "../lib/queries/use-projects";
import { ProjectRequestError } from "../lib/requests/projects";
import { mobileQueryKeys } from "../lib/requests/query-keys";

const mockFetchActiveComputer = jest.fn();
const mockFetchProjects = jest.fn();
const mockCreateProject = jest.fn();
const mockRenameProject = jest.fn();
const mockArchiveProject = jest.fn();
let mockSession: { isSignedIn: boolean; userId: string | null; token: string | null };

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: mockSession.isSignedIn,
    userId: mockSession.userId,
    getToken: async () => mockSession.token,
  }),
}));
jest.mock("@/lib/storage", () => ({ HOSTED_GATEWAY_URL: "https://app.matrix-os.com" }));
jest.mock("@/lib/requests", () => ({
  mobileQueryKeys: jest.requireActual("@/lib/requests/query-keys").mobileQueryKeys,
  ProjectRequestError: jest.requireActual("@/lib/requests/projects").ProjectRequestError,
  fetchActiveComputer: (...args: unknown[]) => mockFetchActiveComputer(...args),
  fetchProjects: (...args: unknown[]) => mockFetchProjects(...args),
  createProject: (...args: unknown[]) => mockCreateProject(...args),
  renameProject: (...args: unknown[]) => mockRenameProject(...args),
  archiveProject: (...args: unknown[]) => mockArchiveProject(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const notes = { id: "proj_notes", slug: "field-notes", name: "Field notes", kind: "scratch" };
const site = { id: "proj_site", slug: "site", name: "Site", kind: "github" };
const fresh = { id: "proj_fresh", slug: "trip", name: "Trip", kind: "scratch" };

// Query results are delivered through React's act() so that every state change
// they cause is flushed before the next assertion.
notifyManager.setNotifyFunction((notify) => {
  act(notify);
});

const mounted: (() => void)[] = [];

function createClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function renderProjects() {
  const { wrapper } = createClient();
  const rendered = renderHook(() => ({
    list: useProjects(),
    create: useCreateProject(),
    rename: useRenameProject(),
    archive: useArchiveProject(),
  }), { wrapper });
  mounted.push(rendered.unmount);
  return rendered;
}

/** The mutations alone, as on a screen that does not itself show the list. */
async function renderMutationsOnly() {
  const { client, wrapper } = createClient();
  const rendered = renderHook(() => ({ create: useCreateProject(), archive: useArchiveProject() }), { wrapper });
  mounted.push(rendered.unmount);
  await waitFor(() => expect(client.getQueryData(mobileQueryKeys.activeComputer("user_a"))).toBeTruthy());
  return { ...rendered, client };
}

const names = (result: { current: { list: { projects: { name: string }[] } } }) =>
  result.current.list.projects.map((project) => project.name);

describe("project mutations", () => {
  // What the server would list right now; every request below moves it.
  let serverProjects: typeof notes[];

  beforeEach(() => {
    jest.resetAllMocks();
    mockSession = { isSignedIn: true, userId: "user_a", token: "session-token" };
    serverProjects = [notes, site];
    mockFetchActiveComputer.mockResolvedValue({ handle: "alice", runtimeSlot: "primary", gatewayPath: "/vm/alice" });
    mockFetchProjects.mockImplementation(async () => serverProjects);
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!();
  });

  describe("useCreateProject", () => {
    it("adds the project to the top of the list only once the server has confirmed it", async () => {
      let confirm!: (value: unknown) => void;
      mockCreateProject.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));

      let request!: Promise<unknown>;
      act(() => { request = result.current.create.mutateAsync({ name: "Trip" }); });
      await waitFor(() => expect(result.current.create.isPending).toBe(true));
      expect(names(result)).toEqual(["Field notes", "Site"]);

      await act(async () => {
        serverProjects = [fresh, notes, site];
        confirm(fresh);
        await expect(request).resolves.toEqual(fresh);
      });

      await waitFor(() => expect(names(result)).toEqual(["Trip", "Field notes", "Site"]));
      expect(mockCreateProject).toHaveBeenCalledWith("session-token", gatewayUrl, { name: "Trip" });
    });

    it("shows the new project before the list has been read again", async () => {
      mockCreateProject.mockResolvedValue(fresh);
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));
      // The re-read after the request never answers in this test.
      mockFetchProjects.mockReturnValue(new Promise(() => {}));

      await act(async () => {
        await result.current.create.mutateAsync({ name: "Trip" });
      });

      await waitFor(() => expect(names(result)).toEqual(["Trip", "Field notes", "Site"]));
      await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(2));
    });

    it("passes a taken name on as its reason and leaves the list as the server has it", async () => {
      mockCreateProject.mockRejectedValue(new ProjectRequestError("name_taken"));
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));

      await act(async () => {
        await expect(result.current.create.mutateAsync({ name: "Site" })).rejects.toMatchObject({ reason: "name_taken" });
      });

      await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(2));
      expect(names(result)).toEqual(["Field notes", "Site"]);
      await waitFor(() => expect(result.current.create.error).toMatchObject({ reason: "name_taken" }));
    });

    it("does not let a list read that was already in flight undo a confirmed project", async () => {
      let answerEarlierRead!: (value: unknown) => void;
      mockFetchProjects
        .mockResolvedValueOnce([notes, site])
        .mockReturnValueOnce(new Promise((resolve) => { answerEarlierRead = resolve; }));
      mockCreateProject.mockImplementation(async () => {
        serverProjects = [fresh, notes, site];
        return fresh;
      });
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));
      act(() => { void result.current.list.refetch(); });
      await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(2));

      await act(async () => {
        await result.current.create.mutateAsync({ name: "Trip" });
      });
      await act(async () => {
        answerEarlierRead([notes, site]);
      });

      await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(names(result)).toEqual(["Trip", "Field notes", "Site"]));
    });

    it("does not let an earlier list read replace the confirmed list while no screen is showing it", async () => {
      // With nothing showing the list, nothing reads it again after the request,
      // so an older read still in flight would otherwise have the last word.
      mockCreateProject.mockResolvedValue(fresh);
      const { result, client } = await renderMutationsOnly();
      const projectsKey = mobileQueryKeys.projects("user_a", "alice:primary");
      client.setQueryData(projectsKey, [notes, site]);
      let answerEarlierRead!: (value: unknown) => void;
      const earlierRead = client.fetchQuery({
        queryKey: projectsKey,
        queryFn: () => new Promise((resolve) => { answerEarlierRead = resolve; }),
      });
      earlierRead.catch(() => {});
      await waitFor(() => expect(client.isFetching({ queryKey: projectsKey })).toBe(1));

      await act(async () => {
        await result.current.create.mutateAsync({ name: "Trip" });
      });
      await act(async () => {
        answerEarlierRead([notes, site]);
      });

      expect(client.getQueryData(projectsKey)).toEqual([fresh, notes, site]);
      // Still due a fresh read the next time a screen shows the list.
      expect(client.getQueryState(projectsKey)?.isInvalidated).toBe(true);
    });

    it("leaves a list that was never loaded for its first read to fill", async () => {
      mockCreateProject.mockResolvedValue(fresh);
      const { result, client } = await renderMutationsOnly();

      await act(async () => {
        await result.current.create.mutateAsync({ name: "Trip" });
      });

      expect(client.getQueryData(mobileQueryKeys.projects("user_a", "alice:primary"))).toBeUndefined();
    });

    it("does not call the server when the session has no token", async () => {
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));
      mockSession.token = null;

      await act(async () => {
        await expect(result.current.create.mutateAsync({ name: "Trip" })).rejects.toMatchObject({ reason: "unavailable" });
      });

      expect(mockCreateProject).not.toHaveBeenCalled();
    });
  });

  describe("useRenameProject", () => {
    it("shows the new name, moved to the top as the server orders it, once confirmed", async () => {
      const renamed = { ...site, name: "Website" };
      let confirm!: (value: unknown) => void;
      mockRenameProject.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));

      let request!: Promise<unknown>;
      act(() => { request = result.current.rename.mutateAsync({ slug: "site", name: "Website" }); });
      await waitFor(() => expect(result.current.rename.isPending).toBe(true));
      expect(names(result)).toEqual(["Field notes", "Site"]);

      await act(async () => {
        serverProjects = [renamed, notes];
        confirm(renamed);
        await request;
      });

      await waitFor(() => expect(names(result)).toEqual(["Website", "Field notes"]));
      expect(mockRenameProject).toHaveBeenCalledWith("session-token", gatewayUrl, "site", "Website");
    });

    it("keeps the old name when the server refuses, and reads the list again", async () => {
      mockRenameProject.mockRejectedValue(new ProjectRequestError("not_found"));
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));
      serverProjects = [notes];

      await act(async () => {
        await expect(result.current.rename.mutateAsync({ slug: "site", name: "Website" }))
          .rejects.toMatchObject({ reason: "not_found" });
      });

      // The project had been removed elsewhere; the re-read is what shows that.
      await waitFor(() => expect(names(result)).toEqual(["Field notes"]));
    });
  });

  describe("useArchiveProject", () => {
    it("removes the project from the list only once the server has archived it", async () => {
      let confirm!: (value: unknown) => void;
      mockArchiveProject.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));

      let request!: Promise<unknown>;
      act(() => { request = result.current.archive.mutateAsync("site"); });
      await waitFor(() => expect(result.current.archive.isPending).toBe(true));
      expect(names(result)).toEqual(["Field notes", "Site"]);

      await act(async () => {
        serverProjects = [notes];
        confirm({ ...site, archivedAt: "2026-10-08T10:00:00.000Z" });
        await request;
      });

      await waitFor(() => expect(names(result)).toEqual(["Field notes"]));
      expect(mockArchiveProject).toHaveBeenCalledWith("session-token", gatewayUrl, "site");
    });

    it("keeps the project and says why when work is still running in it", async () => {
      mockArchiveProject.mockRejectedValue(new ProjectRequestError("project_active"));
      const { result } = renderProjects();
      await waitFor(() => expect(names(result)).toEqual(["Field notes", "Site"]));

      await act(async () => {
        await expect(result.current.archive.mutateAsync("site")).rejects.toMatchObject({ reason: "project_active" });
      });

      await waitFor(() => expect(mockFetchProjects).toHaveBeenCalledTimes(2));
      expect(names(result)).toEqual(["Field notes", "Site"]);
      await waitFor(() => expect(result.current.archive.error).toMatchObject({ reason: "project_active" }));
    });
  });
});
