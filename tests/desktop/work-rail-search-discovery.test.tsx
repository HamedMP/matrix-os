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
describe("Work search discovery", () => {
  it("filters standalone existing Projects and opens their center without creating a Chat", () => {
    const onSelectProject = vi.fn();
    render(<WorkRailSearchDialog open records={[]} projects={[project]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} onSelectProject={onSelectProject} />);
    fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
    fireEvent.click(screen.getByRole("option", { name: "Alpha, Project" }));
    expect(onSelectProject).toHaveBeenCalledWith(project);
  });
  it("reads only authorized existing shared discovery and delegates invitation review to the shared tab", async () => {
    api.get.mockResolvedValue({ items: [{ scopeId: "10000000-0000-4000-8000-000000000001", runtimeId: "vps:11111111-1111-4111-8111-111111111111", ownerId: "actor_owner", kind: "chat", authorityGeneration: 1, status: "invited", invitationId: "20000000-0000-4000-8000-000000000001" }] });
    render(<WorkRailSearchDialog open records={[]} projects={[]} status="ready" onClose={vi.fn()} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Shared" }));
    fireEvent.click(await screen.findByRole("option", { name: "Shared chat invitation, Invitation · Shared chat" }));
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/inbox");
    expect(api.get).toHaveBeenCalledWith("/api/collaboration/shared");
    expect(useTabs.getState().tabs.find(tab => tab.kind === "shared")).toBeTruthy();
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
