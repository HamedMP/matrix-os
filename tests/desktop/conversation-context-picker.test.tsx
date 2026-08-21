// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConversationContextPicker from "../../desktop/src/renderer/src/features/chat/ConversationContextPicker";
import { useBoard } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

const readyContext = {
  projectId: "matrix-os",
  projectName: "Matrix OS",
  projectKind: "github" as const,
  repositoryLabel: "FinnaAI/matrix-os",
  status: "ready" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ConversationContextPicker", () => {
  beforeEach(() => {
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    useConnection.setState({ api: { get: vi.fn() } as never });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists active projects with safe kind and repository labels", async () => {
    const onSelect = vi.fn();
    useBoard.setState({
      projects: [
        {
          slug: "matrix-os",
          name: "Matrix OS",
          kind: "github",
          localPath: "/private/matrix-os",
          githubBacked: true,
          github: { owner: "FinnaAI", repo: "matrix-os" },
        },
        {
          slug: "notes",
          name: "Client Notes",
          kind: "folder",
          localPath: "/private/client-notes",
        },
      ],
    });

    render(<ConversationContextPicker context={null} onSelect={onSelect} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));

    const github = screen.getByRole("option", {
      name: "Matrix OS, GitHub, FinnaAI/matrix-os",
    });
    expect(github).toBeTruthy();
    expect(screen.getByRole("option", { name: "Client Notes, Folder" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("/private/");
    fireEvent.click(github);
    expect(onSelect).toHaveBeenCalledWith("matrix-os");
  });

  it("renders loading, empty, project-list error, and runtime-unavailable states", async () => {
    const pending = deferred<boolean>();
    const loadProjects = vi.fn(() => pending.promise);
    useBoard.setState({ loadProjects, projects: [] });
    const view = render(
      <ConversationContextPicker context={null} onSelect={vi.fn()} onRemove={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    expect(screen.getByText("Loading projects…")).toBeTruthy();

    pending.resolve(true);
    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(useUi.getState().createProjectOpen).toBe(true);

    view.unmount();
    useUi.setState({ createProjectOpen: false });
    useBoard.setState({ loadProjects: vi.fn(async () => false), projects: [] });
    render(<ConversationContextPicker context={null} onSelect={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    expect(await screen.findByText("Projects unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry projects" })).toBeTruthy();

    cleanup();
    useConnection.setState({ api: null });
    render(<ConversationContextPicker context={null} onSelect={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
    expect(screen.getByText("Project context is unavailable while disconnected.")).toBeTruthy();
  });

  it("shows selected and stale context, supports removal, and disables changes during a run", () => {
    const onRemove = vi.fn();
    useBoard.setState({ projects: [{ slug: "matrix-os", name: "Matrix OS", kind: "github" }] });
    const view = render(
      <ConversationContextPicker context={readyContext} onSelect={vi.fn()} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Project Matrix OS" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove project context" }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    view.rerender(
      <ConversationContextPicker
        context={{ ...readyContext, status: "unavailable" }}
        onSelect={vi.fn()}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByRole("button", { name: "Project Matrix OS, unavailable" })).toBeTruthy();

    view.rerender(
      <ConversationContextPicker context={readyContext} onSelect={vi.fn()} onRemove={onRemove} disabled />,
    );
    expect(screen.getByRole("button", { name: "Project Matrix OS" }).hasAttribute("disabled")).toBe(true);
  });

  it("opens with the keyboard, traverses options, and restores focus on Escape", async () => {
    const onSelect = vi.fn();
    useBoard.setState({
      projects: [
        { slug: "alpha", name: "Alpha", kind: "scratch" },
        { slug: "beta", name: "Beta", kind: "folder" },
      ],
    });
    render(<ConversationContextPicker context={null} onSelect={onSelect} onRemove={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Add to project" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = await screen.findAllByRole("option");
    await waitFor(() => expect(document.activeElement).toBe(options[0]));
    fireEvent.keyDown(options[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("beta");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox", { name: "Choose project context" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Choose project context" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
