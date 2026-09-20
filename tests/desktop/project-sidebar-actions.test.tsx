// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { WorkRailProjectGroup } from "@desktop/renderer/src/features/work/work-rail/WorkRailProjectGroup";
import { buildWorkRailModel } from "@desktop/renderer/src/features/work/work-rail-model";
import { useBoard, parseProject } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";

vi.mock("@desktop/renderer/src/features/panels/InspectorFilesPanel", () => ({
  InspectorFilesPanel: ({ scope }: { scope: { projectId: string } }) => <div data-testid="files-scope">{scope.projectId}</div>,
}));
import { useProjectActions } from "@desktop/renderer/src/features/work/work-rail/use-project-actions";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";

const alpha = { id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const, description: "Old notes" };
function setup(patch = vi.fn().mockResolvedValue({ project: { ...alpha, name: "Renamed", pinned: true } })) {
  useConnection.setState({ api: { patch } as never });
  useBoard.setState({ projects: [alpha] });
  const onDeleteProject = vi.fn();
  const onNewChat = vi.fn();
  render(<WorkRailProjectGroup group={{ id: alpha.id, slug: alpha.slug, name: alpha.name, project: alpha, chats: [] }}
    expanded={false} pinning={{}} onToggle={vi.fn()} onNewChat={onNewChat} onDeleteProject={onDeleteProject}
    onSelectChat={vi.fn()} renamingChatId={null} renamePending={false} onRenameChat={vi.fn()}
    onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPinChat={vi.fn()} onDeleteChat={vi.fn()} />);
  return { patch, onDeleteProject, onNewChat };
}
function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Actions for Alpha" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}
afterEach(() => { cleanup(); useConnection.setState({ api: null }); vi.restoreAllMocks(); });
describe("project sidebar actions", () => {
  it("replaces inline delete with ellipsis while preserving New Chat", () => {
    const { onNewChat } = setup();
    expect(screen.queryByRole("button", { name: "Delete Alpha project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Alpha" }));
    expect(onNewChat).toHaveBeenCalledWith(alpha);
  });
  it("exposes the same actions by ellipsis and right click", () => {
    setup(); openMenu();
    const expected = ["Pin", "Edit", "Open in Files", "Delete project"];
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(expected);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(expected);
  });
  it("opens existing deletion confirmation only from the menu", () => {
    const { onDeleteProject } = setup(); openMenu();
    expect(onDeleteProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project" }));
    expect(onDeleteProject).toHaveBeenCalledWith(alpha);
  });
  it("persists pin and projects the response into the catalog", async () => {
    const { patch } = setup(); openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(useBoard.getState().projects[0].pinned).toBe(true));
    expect(patch).toHaveBeenCalledWith("/api/projects/alpha", { pinned: true });
  });
  it("edits display information through the metadata route", async () => {
    const { patch } = setup(); openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Renamed" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/api/projects/alpha", { name: "Renamed", description: "New notes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("returns keyboard focus to project actions after closing Edit", async () => {
    setup(); openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for Alpha" })));
  });
  it("keeps failed edit drafts and displays only a generic error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setup(vi.fn().mockRejectedValue(new Error("secret database path"))); openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Keep draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("could not be updated"));
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Keep draft");
    expect(screen.queryByText(/secret database/)).toBeNull();
  });
  it("opens Files using project scope rather than localPath", () => {
    setup(); openMenu(); fireEvent.click(screen.getByRole("menuitem", { name: "Open in Files" }));
    expect(screen.getByTestId("files-scope").textContent).toBe("alpha");
  });
  it("parses pinned state and stably orders pinned projects first", () => {
    const pinned = { ...alpha, id: "proj_beta", slug: "beta", name: "Beta", pinned: true };
    expect(parseProject(pinned)?.pinned).toBe(true);
    expect(buildWorkRailModel([], [alpha, pinned, { ...alpha, slug: "gamma" }]).projects.map(p => p.slug)).toEqual(["beta", "alpha", "gamma"]);
  });
  it("ignores pending results after switching runtime and resets dialogs", async () => {
    let resolve!: (value: unknown) => void;
    const patch = vi.fn(() => new Promise(value => { resolve = value; }));
    useConnection.setState({ api: { patch } as never });
    useBoard.setState({ projects: [alpha] });
    const { result } = renderHook(() => useProjectActions(alpha));
    act(() => { result.current.setDialog("edit"); void result.current.update({ pinned: true }); });
    act(() => { advanceRuntimeGeneration(); useConnection.setState({ api: { patch: vi.fn() } as never }); });
    await act(async () => { resolve({ project: { ...alpha, pinned: true } }); });
    expect(useBoard.getState().projects[0].pinned).toBeUndefined();
    expect(result.current.dialog).toBeNull();
    expect(result.current.pending).toBe(false);
  });
  it("does not overwrite metadata with a catalog load started before a successful patch", async () => {
    let resolve!: (value: unknown) => void;
    const get = vi.fn(() => new Promise(value => { resolve = value; }));
    useBoard.setState({ projects: [alpha] });
    const loading = useBoard.getState().loadProjects({ get } as never);
    useBoard.getState().applyProjectMetadata({ ...alpha, pinned: true, name: "Fresh" });
    resolve({ projects: [alpha] });
    await loading;
    expect(useBoard.getState().projects[0]).toMatchObject({ pinned: true, name: "Fresh" });
    expect(useBoard.getState().projectsStatus).toBe("ready");
  });
  it("blocks duplicate metadata submissions while a patch is pending", async () => {
    let resolve!: (value: unknown) => void;
    const patch = vi.fn(() => new Promise(value => { resolve = value; }));
    useConnection.setState({ api: { patch } as never });
    useBoard.setState({ projects: [alpha] });
    const { result } = renderHook(() => useProjectActions(alpha));
    act(() => { void result.current.update({ pinned: true }); void result.current.update({ pinned: true }); });
    expect(patch).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ project: { ...alpha, pinned: true } }); });
  });

});
