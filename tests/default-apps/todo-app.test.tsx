// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/todo/src/App";

type DbRow = Record<string, unknown>;

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function installMatrixDb(rows: DbRow[] = []) {
  const store = [...rows];
  const db = {
    find: vi.fn(async () => [...store]),
    findOne: vi.fn(async (_t: string, id: string) => store.find((r) => r.id === id) ?? null),
    insert: vi.fn(async (_t: string, data: DbRow) => {
      const id = `new-${store.length + 1}`;
      store.push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    }),
    update: vi.fn(async (_t: string, id: string, data: DbRow) => {
      const row = store.find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return { ok: true };
    }),
    delete: vi.fn(async (_t: string, id: string) => {
      const idx = store.findIndex((r) => r.id === id);
      if (idx >= 0) store.splice(idx, 1);
      return { ok: true };
    }),
    count: vi.fn(async () => store.length),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db;
}

describe("Todo app", () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      // jsdom lacks matchMedia; reduced-motion check needs it
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders tasks from the database", async () => {
    installMatrixDb([
      { id: "t1", title: "Write the spec", status: "open", priority: 1, due: null },
      { id: "t2", title: "Review PR", status: "open", priority: 0, due: null },
    ]);
    render(<App />);
    expect(await screen.findByText("Write the spec")).toBeTruthy();
    expect(screen.getByText("Review PR")).toBeTruthy();
  });

  it("loads tasks without a silent result ceiling", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Long-running task", status: "open", priority: 0, due: null },
    ]);
    render(<App />);

    expect(await screen.findByText("Long-running task")).toBeTruthy();
    expect(db.find).toHaveBeenCalledWith("tasks", { orderBy: { created_at: "desc" } });
  });

  it("shows an onboarding empty state when there are no tasks", async () => {
    installMatrixDb([]);
    render(<App />);
    expect(await screen.findByText(/your inbox is clear/i)).toBeTruthy();
  });

  it("adds a task to the inbox via Enter and persists with db.insert", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    const input = await screen.findByPlaceholderText(/add a task|new task|capture/i);
    fireEvent.change(input, { target: { value: "Buy groceries" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(db.insert).toHaveBeenCalledWith(
        "tasks",
        expect.objectContaining({ title: "Buy groceries", status: "open", priority: "0" }),
      );
    });
    // optimistic render
    expect(screen.getByText("Buy groceries")).toBeTruthy();
  });

  it("serializes priority updates as text for the bridge schema", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Prioritize", status: "open", priority: 0, due: null },
    ]);

    render(<App />);
    await screen.findByText("Prioritize");
    fireEvent.click(screen.getByRole("button", { name: /priority for prioritize/i }));

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { priority: "1" });
    });
  });

  it("adds tasks captured from Upcoming with a future due date", async () => {
    const db = installMatrixDb([]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /^upcoming/i }));
    const input = await screen.findByPlaceholderText(/add a task|new task|capture/i);
    fireEvent.change(input, { target: { value: "Plan launch" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.insert).toHaveBeenCalledWith(
        "tasks",
        expect.objectContaining({ title: "Plan launch", due: expect.any(String) }),
      );
    });
    expect(await screen.findByText("Plan launch")).toBeTruthy();
  });

  it("adds tasks captured from Today with a stable 9am due date", async () => {
    const today = new Date();
    const db = installMatrixDb([]);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /^today/i }));
    const input = await screen.findByPlaceholderText(/add a task|new task|capture/i);
    fireEvent.change(input, { target: { value: "Daily review" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.insert).toHaveBeenCalledWith(
        "tasks",
        expect.objectContaining({ title: "Daily review", due: expect.any(String) }),
      );
    });
    const payload = db.insert.mock.calls.find((call) => call[0] === "tasks")?.[1] as DbRow;
    const due = new Date(String(payload.due));
    expect(due.getFullYear()).toBe(today.getFullYear());
    expect(due.getMonth()).toBe(today.getMonth());
    expect(due.getDate()).toBe(today.getDate());
    expect(due.getHours()).toBe(9);
    expect(due.getMinutes()).toBe(0);
  });

  it("completing a task calls db.update with done status", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Finish report", status: "open", priority: 0, due: null },
    ]);
    render(<App />);
    await screen.findByText("Finish report");
    const checkbox = screen.getByRole("button", { name: /complete .*finish report/i });
    await act(async () => {
      fireEvent.click(checkbox);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith(
        "tasks",
        "t1",
        expect.objectContaining({ status: "done" }),
      );
    });
  });

  it("closes the inspector when completing a selected task with the check button", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Finish report", status: "open", priority: 0, due: null },
    ]);
    render(<App />);
    await screen.findByText("Finish report");
    fireEvent.click(screen.getByRole("listitem"));
    expect(screen.getByRole("dialog", { name: /details for finish report/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /complete .*finish report/i }));
    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { status: "done" });
    });

    expect(screen.queryByRole("dialog", { name: /details for finish report/i })).toBeNull();
  });

  it("does not roll back a completed task when the follow-up reload fails", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Finish report", status: "open", priority: 0, due: null },
    ]);

    render(<App />);
    await screen.findByText("Finish report");
    db.find.mockRejectedValueOnce(new Error("reload failed"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /complete .*finish report/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { status: "done" });
    });
    expect(
      db.update.mock.calls.some(
        (call) => call[0] === "tasks" && call[1] === "t1" && call[2]?.status === "open",
      ),
    ).toBe(false);
    expect(screen.queryByText("Finish report")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toBe("Tasks could not be loaded. They may be out of date.");
  });

  it("keeps update failure errors visible after reloading", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Prioritize", status: "open", priority: 0, due: null },
    ]);
    db.update.mockRejectedValueOnce(new Error("update failed"));

    render(<App />);
    await screen.findByText("Prioritize");
    fireEvent.click(screen.getByRole("button", { name: /priority for prioritize/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("Change could not be saved.");
  });

  it("rolls a recurring task back open when scheduling the next occurrence fails", async () => {
    const db = installMatrixDb([
      {
        id: "t1",
        title: "Standup",
        status: "open",
        priority: 0,
        due: "2026-06-01T09:00:00.000Z",
        recur: "daily",
      },
    ]);
    db.insert.mockRejectedValueOnce(new Error("insert failed"));

    render(<App />);
    await screen.findByText("Standup");
    const checkbox = screen.getByRole("button", { name: /complete .*standup/i });
    await act(async () => {
      fireEvent.click(checkbox);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { status: "open" });
    });
    expect(await screen.findByText("Standup")).toBeTruthy();
    expect(screen.getByRole("button", { name: /complete .*standup/i })).toBeTruthy();
    expect(screen.queryByText(/tomorrow/i)).toBeNull();
  });

  it("keeps complete failure errors visible after reloading", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Finish report", status: "open", priority: 0, due: null },
    ]);
    db.update.mockRejectedValueOnce(new Error("complete failed"));

    render(<App />);
    await screen.findByText("Finish report");
    fireEvent.click(screen.getByRole("button", { name: /complete .*finish report/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("Could not complete task.");
  });

  it("requires a due date before completing a repeating task", async () => {
    const db = installMatrixDb([
      {
        id: "t1",
        title: "Standup",
        status: "open",
        priority: 0,
        due: null,
        recur: "daily",
      },
    ]);

    render(<App />);
    await screen.findByText("Standup");
    fireEvent.click(screen.getByRole("listitem"));

    const repeat = screen.getByText("Repeat").closest("label")?.querySelector("select") as HTMLSelectElement | null;
    expect(repeat).toBeInstanceOf(HTMLSelectElement);
    if (!repeat) throw new Error("Repeat select was not rendered");
    expect(repeat.disabled).toBe(true);
    expect(screen.getByText("Add a due date to repeat this task.")).toBeTruthy();

    const checkbox = screen.getByRole("button", { name: /complete .*standup/i });
    fireEvent.click(checkbox);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Add a due date before completing a repeating task.",
    );
    expect(db.update).not.toHaveBeenCalledWith("tasks", "t1", { status: "done" });
  });

  it("clears recurrence when clearing a due date", async () => {
    const db = installMatrixDb([
      {
        id: "t1",
        title: "Standup",
        status: "open",
        priority: 0,
        due: "2026-06-01T09:00:00.000Z",
        recur: "daily",
      },
    ]);

    render(<App />);
    await screen.findByText("Standup");
    fireEvent.click(screen.getByRole("listitem"));

    const dueInput = screen.getByText("Due date").closest("label")?.querySelector("input") as HTMLInputElement | null;
    expect(dueInput).toBeInstanceOf(HTMLInputElement);
    if (!dueInput) throw new Error("Due date input was not rendered");
    fireEvent.change(dueInput, { target: { value: "" } });

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { due: null, recur: null });
    });
  });

  it("does not delete a task after a due-date edit removes it from the current view", async () => {
    const db = installMatrixDb([
      {
        id: "t1",
        title: "Today only",
        status: "open",
        priority: 0,
        due: isoDaysFromNow(0),
        recur: null,
      },
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^today/i }));
    await screen.findByText("Today only");
    fireEvent.click(screen.getByRole("listitem"));

    const dueInput = screen.getByText("Due date").closest("label")?.querySelector("input") as HTMLInputElement | null;
    expect(dueInput).toBeInstanceOf(HTMLInputElement);
    if (!dueInput) throw new Error("Due date input was not rendered");
    fireEvent.change(dueInput, { target: { value: "" } });
    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { due: null, recur: null });
    });
    expect(screen.getByRole("dialog", { name: /details for today only/i })).toBeTruthy();
    expect(within(screen.getByTestId("task-list")).queryByText("Today only")).toBeNull();

    fireEvent.keyDown(screen.getByTestId("task-list"), { key: "Backspace", ctrlKey: true });

    expect(db.delete).not.toHaveBeenCalled();
  });

  it("clears keyboard selection after completing the selected task", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Finish report", status: "open", priority: 0, due: null },
    ]);
    render(<App />);
    await screen.findByText("Finish report");
    fireEvent.click(screen.getByRole("listitem"));
    expect(screen.getByRole("dialog", { name: /details for finish report/i })).toBeTruthy();

    fireEvent.keyDown(screen.getByTestId("task-list"), { key: "Enter" });
    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("tasks", "t1", { status: "done" });
    });

    expect(screen.queryByRole("dialog", { name: /details for finish report/i })).toBeNull();
    fireEvent.keyDown(screen.getByTestId("task-list"), { key: "Backspace", ctrlKey: true });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("filters tasks into Today and Upcoming views", async () => {
    installMatrixDb([
      { id: "td", title: "Due today task", status: "open", priority: 0, due: isoDaysFromNow(0) },
      { id: "up", title: "Future task", status: "open", priority: 0, due: isoDaysFromNow(5) },
      { id: "ib", title: "No date task", status: "open", priority: 0, due: null },
    ]);
    render(<App />);
    await screen.findByText("No date task");

    // Today view
    fireEvent.click(screen.getByRole("button", { name: /^today/i }));
    const list = screen.getByTestId("task-list");
    expect(within(list).getByText("Due today task")).toBeTruthy();
    expect(within(list).queryByText("Future task")).toBeNull();

    // Upcoming view
    fireEvent.click(screen.getByRole("button", { name: /^upcoming/i }));
    const list2 = screen.getByTestId("task-list");
    expect(within(list2).getByText("Future task")).toBeTruthy();
    expect(within(list2).queryByText("Due today task")).toBeNull();
  });

  it("deletes a task via db.delete", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Disposable", status: "open", priority: 0, due: null },
    ]);
    render(<App />);
    await screen.findByText("Disposable");
    const del = screen.getByRole("button", { name: /delete .*disposable/i });
    await act(async () => {
      fireEvent.click(del);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(db.delete).toHaveBeenCalledWith("tasks", "t1");
    });
  });

  it("keeps delete failure errors visible after reloading", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Disposable", status: "open", priority: 0, due: null },
    ]);
    db.delete.mockRejectedValueOnce(new Error("delete failed"));

    render(<App />);
    await screen.findByText("Disposable");
    fireEvent.click(screen.getByRole("button", { name: /delete .*disposable/i }));

    expect((await screen.findByRole("alert")).textContent).toBe("Task could not be deleted.");
  });

  it("debounces note edits from the inspector", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Annotate", status: "open", priority: 0, due: null, notes: "" },
    ]);
    render(<App />);
    await screen.findByText("Annotate");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("listitem"));
    const notes = screen.getByPlaceholderText("Add notes…");
    fireEvent.change(notes, { target: { value: "Draft note" } });

    expect(db.update).not.toHaveBeenCalledWith(
      "tasks",
      "t1",
      expect.objectContaining({ notes: "Draft note" }),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith("tasks", "t1", { notes: "Draft note" });
    expect(db.update.mock.calls.filter((call) => call[0] === "tasks" && call[1] === "t1")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("flushes pending note edits when closing the inspector", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Annotate", status: "open", priority: 0, due: null, notes: "" },
    ]);
    render(<App />);
    await screen.findByText("Annotate");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("listitem"));
    fireEvent.change(screen.getByPlaceholderText("Add notes…"), { target: { value: "Draft note" } });
    fireEvent.click(screen.getByRole("button", { name: /close details/i }));

    expect(db.update).toHaveBeenCalledWith("tasks", "t1", { notes: "Draft note" });
    vi.useRealTimers();
  });

  it("flushes the previous task draft when switching tasks with matching notes", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Alpha", status: "open", priority: 0, due: null, notes: "Original" },
      { id: "t2", title: "Beta", status: "open", priority: 0, due: null, notes: "Shared" },
    ]);
    render(<App />);
    await screen.findByText("Alpha");

    vi.useFakeTimers();
    const alphaRow = screen.getByText("Alpha").closest('[role="listitem"]');
    if (!alphaRow) throw new Error("Alpha row was not rendered");
    fireEvent.click(alphaRow);
    fireEvent.change(screen.getByPlaceholderText("Add notes…"), { target: { value: "Shared" } });
    db.update.mockClear();

    const betaRow = screen.getByText("Beta").closest('[role="listitem"]');
    if (!betaRow) throw new Error("Beta row was not rendered");
    await act(async () => {
      fireEvent.click(betaRow);
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith("tasks", "t1", { notes: "Shared" });
    vi.useRealTimers();
  });

  it("debounces project edits from the inspector", async () => {
    const db = installMatrixDb([
      { id: "t1", title: "Organize", status: "open", priority: 0, due: null, notes: "", project: null },
    ]);
    render(<App />);
    await screen.findByText("Organize");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("listitem"));
    const project = screen.getByPlaceholderText("No project");
    fireEvent.change(project, { target: { value: "W" } });
    fireEvent.change(project, { target: { value: "Work " } });

    expect(db.update).not.toHaveBeenCalledWith(
      "tasks",
      "t1",
      expect.objectContaining({ project: "Work" }),
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith("tasks", "t1", { project: "Work" });
    db.update.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("survives a missing MatrixOS.db without crashing", async () => {
    render(<App />);
    expect(await screen.findByPlaceholderText(/add a task|new task|capture/i)).toBeTruthy();
  });
});
