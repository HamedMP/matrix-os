// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetail, type TaskDetailProps } from "../../packages/ui/src/project-board/TaskDetail";
import type { UpdateResult } from "../../packages/ui/src/project-board/use-project-board";
import type { ProjectTask } from "../../packages/ui/src/project-board/types";
import { boardTask, fakeBoardClient } from "./project-board-fake-client";

afterEach(cleanup);

function detailProps(task: ProjectTask, overrides: Partial<TaskDetailProps> = {}): TaskDetailProps {
  const { client } = fakeBoardClient(() => [task]);
  return {
    client, task, allTasks: [task], members: [], settings: null, boardLabels: [], nowMs: Date.parse("2026-11-20T12:00:00.000Z"),
    onClose: vi.fn(), onOpenTask: vi.fn(), onStatusChange: vi.fn(),
    onUpdate: vi.fn(async (): Promise<UpdateResult> => ({})),
    run: async <T,>(action: () => Promise<T>) => action(),
    ...overrides,
  };
}

/** Saves like the server: a stale base revision loses to `server()`. */
function serverUpdate(server: () => ProjectTask) {
  return vi.fn(async (base: ProjectTask, input: Partial<ProjectTask>): Promise<UpdateResult> => {
    const current = server();
    if (base.revision !== current.revision) return { conflict: current };
    return { task: { ...current, ...input, revision: current.revision + 1 } };
  });
}

describe("TaskDetail text edits", () => {
  it("saves a title against the revision it was edited from, so a newer save from someone else shows the conflict", async () => {
    const mine = boardTask("t1", { title: "Original", revision: 1 });
    const theirs = { ...mine, title: "Their title", revision: 2 };
    const onUpdate = serverUpdate(() => theirs);
    const props = detailProps(mine, { onUpdate });
    const view = render(<TaskDetail {...props} />);

    const title = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "My title" } });
    // A change signal refreshes the task while the person is still typing.
    view.rerender(<TaskDetail {...props} task={theirs} allTasks={[theirs]} />);
    await act(async () => { fireEvent.blur(title); });

    expect(onUpdate.mock.calls[0]![0].revision).toBe(1);
    expect(await screen.findByRole("alert", { name: "The title changed while you were editing" })).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep mine" })); });
    expect(onUpdate.mock.calls[1]![0].revision).toBe(2);
    expect(onUpdate.mock.calls[1]![1]).toEqual({ title: "My title" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves a description against the revision it was edited from", async () => {
    const mine = boardTask("t1", { description: "Old", revision: 1 });
    const theirs = { ...mine, description: "Theirs", revision: 2 };
    const onUpdate = serverUpdate(() => theirs);
    const props = detailProps(mine, { onUpdate });
    const view = render(<TaskDetail {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Mine" } });
    view.rerender(<TaskDetail {...props} task={theirs} allTasks={[theirs]} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    expect(onUpdate.mock.calls[0]![0].revision).toBe(1);
    expect(await screen.findByRole("alert", { name: "The description changed while you were editing" })).toBeTruthy();
  });

  it("does not resave an untouched title over a newer one", async () => {
    const mine = boardTask("t1", { title: "Original", revision: 1 });
    const theirs = { ...mine, title: "Their title", revision: 2 };
    const onUpdate = serverUpdate(() => theirs);
    const props = detailProps(mine, { onUpdate });
    const view = render(<TaskDetail {...props} />);

    const title = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.focus(title);
    view.rerender(<TaskDetail {...props} task={theirs} allTasks={[theirs]} />);
    await act(async () => { fireEvent.blur(title); });

    expect(onUpdate).not.toHaveBeenCalled();
    expect((title as HTMLTextAreaElement).value).toBe("Their title");
  });
});

describe("TaskDetail comment drafts", () => {
  it("drops the draft when another task opens in the same sheet, so it is never posted to the wrong task", async () => {
    const first = boardTask("t1");
    const second = boardTask("t2");
    const props = detailProps(first);
    const view = render(<TaskDetail {...props} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Add a comment" }), { target: { value: "About t1" } });
    view.rerender(<TaskDetail {...props} task={second} allTasks={[first, second]} />);

    expect((screen.getByRole("combobox", { name: "Add a comment" }) as HTMLTextAreaElement).value).toBe("");
  });
});

function Harness({ task }: { task: ProjectTask }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open task</button>
    <button type="button">Board control</button>
    {open ? <TaskDetail {...detailProps(task)} onClose={() => setOpen(false)} /> : null}
  </>;
}

describe("TaskDetail focus", () => {
  async function openSheet() {
    render(<Harness task={boardTask("t1")} />);
    const opener = screen.getByRole("button", { name: "Open task" });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    return { opener, sheet };
  }

  it("keeps focus inside the sheet when it would move to the covered board", async () => {
    const { sheet } = await openSheet();
    act(() => { screen.getByRole("button", { name: "Board control" }).focus(); });
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it("wraps Tab from the last control back to the first", async () => {
    const { sheet } = await openSheet();
    const tabbable = [...sheet.querySelectorAll<HTMLElement>("button:not([disabled]), textarea, a[href], input")].filter((element) => element.tabIndex >= 0);
    act(() => { tabbable.at(-1)!.focus(); });
    fireEvent.keyDown(tabbable.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(tabbable[0]);
  });

  it("lets a portalled picker take focus and gives it back to its trigger", async () => {
    const { sheet } = await openSheet();
    const trigger = sheet.querySelector<HTMLElement>("aside button[aria-haspopup=listbox]")!;
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "Status" });
    expect(sheet.contains(listbox)).toBe(false);
    const option = screen.getAllByRole("option", { name: /In progress/ })[0]!;
    act(() => { option.focus(); });
    expect(document.activeElement).toBe(option);

    fireEvent.keyDown(option, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Status" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("returns focus to the control that opened it when it closes", async () => {
    const { opener, sheet } = await openSheet();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
