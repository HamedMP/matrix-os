// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateTaskDialog from "../../desktop/src/renderer/src/features/board/CreateTaskDialog";
import { useBoard, type Card } from "../../desktop/src/renderer/src/stores/board";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { useUi } from "../../desktop/src/renderer/src/stores/ui";

function makeCard(id: string): Card {
  return {
    id,
    projectSlug: "project",
    title: "Task",
    description: "",
    status: "todo",
    priority: "normal",
    order: 0,
    parentTaskId: null,
    linkedSessionId: null,
    linkedWorktreeId: null,
    previewIds: [],
    tags: [],
    updatedAt: null,
    revision: null,
  };
}

describe("CreateTaskDialog", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: { post: vi.fn() } as never,
    });
    useBoard.setState({
      activeProjectSlug: "project",
      projects: [{ slug: "project", name: "Project" }],
      cardsByProject: {},
      firstLoadPending: false,
      refreshing: false,
      error: null,
    });
    useUi.setState({
      view: { kind: "board" },
      createTaskOpen: false,
      composerOpen: false,
      paletteOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not navigate after Escape closes an in-flight create-and-open submit", async () => {
    let resolveCreate!: (card: Card) => void;
    const createTask = vi.fn(
      () => new Promise<Card>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const navigate = vi.fn();
    useBoard.setState({ createTask });
    useUi.setState({ navigate });

    function Harness() {
      const [open, setOpen] = useState(true);
      return <CreateTaskDialog open={open} onClose={() => setOpen(false)} />;
    }

    render(<Harness />);

    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Ship desktop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create + open" }));
    await waitFor(() => {
      expect(createTask).toHaveBeenCalledOnce();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await act(async () => {
      resolveCreate(makeCard("task-1"));
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not navigate after backdrop closes an in-flight create-and-open submit", async () => {
    let resolveCreate!: (card: Card) => void;
    const createTask = vi.fn(
      () => new Promise<Card>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const navigate = vi.fn();
    useBoard.setState({ createTask });
    useUi.setState({ navigate });

    function Harness() {
      const [open, setOpen] = useState(true);
      return <CreateTaskDialog open={open} onClose={() => setOpen(false)} />;
    }

    render(<Harness />);

    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Ship desktop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create + open" }));
    await waitFor(() => {
      expect(createTask).toHaveBeenCalledOnce();
    });

    const backdrop =
      document.querySelector<HTMLElement>('div[data-state="open"].fixed.inset-0') ??
      screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
    fireEvent.mouseDown(backdrop!);
    fireEvent.click(backdrop!);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await act(async () => {
      resolveCreate(makeCard("task-1"));
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("restores the dialog when task creation throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const createTask = vi.fn().mockRejectedValue(new Error("offline"));
    useBoard.setState({ createTask });

    render(<CreateTaskDialog open={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Task title"), {
      target: { value: "Ship desktop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't create the task. Please try again.")).toBeTruthy();
    });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
    expect(console.warn).toHaveBeenCalledWith("[create-task] failed to submit task:", "offline");
  });
});
