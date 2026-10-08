// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkRailSearchDialog } from "@desktop/renderer/src/features/work/WorkRailSearchDialog";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
const api = vi.hoisted(() => ({ get: vi.fn(), release: vi.fn() }));
vi.mock("@desktop/renderer/src/lib/collaboration", () => ({ createDesktopCollaborationApi: () => api, releaseDesktopCollaborationApi: api.release }));
beforeEach(() => {
  useConnection.setState({ ...useConnection.getInitialState(), userId: "actor_me", platformHost: "https://platform.test" }, true);
  useTabs.setState(useTabs.getInitialState(), true);
  api.get.mockResolvedValue({ items: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const project = { id: "project_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };
const projectScopeId = "10000000-0000-4000-8000-000000000101";
const acceptedProject = (withOverview: boolean) => ({
  scopeId: projectScopeId,
  runtimeId: "vps:11111111-1111-4111-8111-111111111111",
  ownerId: "actor_owner",
  kind: "project",
  authorityGeneration: 1,
  status: "accepted",
  resource: {
    scope: {
      id: projectScopeId, ownerId: "actor_owner", kind: "project", resourceId: "project_shared",
      membershipMode: "direct", lifecycle: "shared", revision: "1", authEpoch: "1",
      authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false,
        observeTerminal: false, controlTerminal: false, stopTerminal: false },
    },
    project: { id: "project_shared", scopeId: projectScopeId, status: "active", resources: [] },
    ...(withOverview ? { overview: { projectId: "project_shared", scopeId: projectScopeId,
      name: "Rail project", status: "active", chats: [] } } : {}),
  },
});
describe("Work search discovery", () => {
  it("hides shared discovery after a complete listing confirms no organizations", () => {
    useConnection.setState({ organizationId: null, organizationStatus: "none" });

    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);

    expect(screen.queryByRole("tab", { name: "Shared" })).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("does not restore stale shared results while renewed membership is revalidated", async () => {
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member" });
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" });

    act(() => useConnection.setState({ organizationId: null, organizationStatus: "none" }));
    expect(screen.queryByRole("tab", { name: "Shared" })).toBeNull();

    api.get.mockImplementation(() => new Promise(() => {}));
    act(() => useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member" }));

    expect(screen.queryByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading shared items…");
  });

  it("keeps loaded shared results while search is temporarily closed", async () => {
    useConnection.setState({ organizationId: "org_matrix", organizationStatus: "member" });
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    const props = { records: [], projects: [], status: "ready" as const, onClose: vi.fn(), onSelect: vi.fn() };
    const view = render(<WorkRailSearchDialog open {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" });

    view.rerender(<WorkRailSearchDialog open={false} {...props} />);
    api.get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<WorkRailSearchDialog open {...props} />);

    expect(screen.getByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" })).toBeTruthy();
  });

  it("filters standalone existing Projects and opens their center without creating a Chat", () => {
    const onSelectProject = vi.fn();
    render(<WorkRailSearchDialog open records={[]} projects={[project]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onSelectProject={onSelectProject} />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(screen.getByRole("option", { name: "Alpha, Project" }));
    expect(onSelectProject).toHaveBeenCalledWith(project);
  });
  it("reads only authorized existing shared discovery and delegates invitation review to the shared tab", async () => {
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    const onOpenShared = vi.fn();
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onOpenShared={onOpenShared} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    fireEvent.click(await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" }));
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/inbox");
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/shared");
    expect(onOpenShared).toHaveBeenCalledOnce();
    expect(useTabs.getState().tabs).toEqual([]);
  });
  it("keeps accepted shared projects out of search because the Projects rail owns them", async () => {
    api.get.mockResolvedValue({ items: [acceptedProject(true)] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onOpenShared={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));

    expect(await screen.findByText("No shared items found.")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });
  it("keeps an accepted project discoverable when the Projects rail has no overview", async () => {
    api.get.mockResolvedValue({ items: [acceptedProject(false)] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onOpenShared={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));

    expect(await screen.findByRole("option", { name: "Shared project, Shared · Shared project" })).toBeTruthy();
  });
  it("clears the prior actor's discovery before a new actor lookup completes", async () => {
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" });
    api.get.mockImplementation(() => new Promise(() => {}));
    act(() => useConnection.setState({ userId: "another_actor" }));
    expect(screen.queryByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading shared items…");
    expect(api.release).toHaveBeenCalled();
  });
  it("shows a safe shared read failure", async () => {
    api.get.mockRejectedValue(new Error("private server path"));
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Shared items could not be loaded. Try again.");
    expect(screen.queryByText("private server path")).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
