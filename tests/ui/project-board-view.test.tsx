// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectBoard } from "../../packages/ui/src/project-board/ProjectBoard";
import { TaskAgentWorkingError, TaskConflictError, type ProjectBoardClient } from "../../packages/ui/src/project-board/client";
import { createFixtureProjectBoardClient } from "../../packages/ui/src/project-board/fixture-client";

afterEach(cleanup);

// jsdom has no modal <dialog> methods; mirror the open state so dialogs render.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
});

function column(name: RegExp) {
  return screen.getByRole("region", { name });
}

describe("ProjectBoard", () => {
  it("shows the five columns with their cards and keeps canceled behind a filter", async () => {
    render(<ProjectBoard client={createFixtureProjectBoardClient({ latencyMs: 0 })} />);
    await screen.findByRole("region", { name: /^Backlog/ });
    for (const name of [/^Backlog/, /^To do/, /^In progress/, /^In review/, /^Done/]) expect(column(name)).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Canceled/ })).toBeNull();
    expect(within(column(/^In progress/)).getByRole("button", { name: /MOS-30: Move project tasks to owner Postgres/ })).toBeTruthy();
    expect(screen.queryByText("Custom board columns")).toBeNull();
  });

  it("moves a card with Alt+Arrow and snaps it back with a generic notice when the move fails", async () => {
    const client = createFixtureProjectBoardClient({ latencyMs: 0 });
    render(<ProjectBoard client={client} />);
    const card = await screen.findByRole("button", { name: /MOS-26: Billing page/ });
    fireEvent.keyDown(card, { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(within(column(/^In progress/)).queryByRole("button", { name: /MOS-26/ })).toBeTruthy());
    expect((await client.getTask("task_fixture_26")).status).toBe("in_progress");

    client.setSimulateFailure(true);
    const moved = within(column(/^In progress/)).getByRole("button", { name: /MOS-26/ });
    await act(async () => { fireEvent.keyDown(moved, { key: "ArrowRight", altKey: true }); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("back where it was"));
    expect(within(column(/^In progress/)).getByRole("button", { name: /MOS-26/ })).toBeTruthy();
    expect((await client.getTask("task_fixture_26")).status).toBe("in_progress");
  });

  it("opens a task over the board and closes it with Escape", async () => {
    render(<ProjectBoard client={createFixtureProjectBoardClient({ latencyMs: 0 })} />);
    fireEvent.click(await screen.findByRole("button", { name: /MOS-31: PR checks roll-up/ }));
    const sheet = await screen.findByRole("dialog", { name: /MOS-31: PR checks roll-up on cards/ });
    expect(await within(sheet).findByText("Looks good, approving.")).toBeTruthy();
    expect(column(/^In review/)).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /MOS-31/ })).toBeNull();
  });

  it("starts a terminal from the task and offers to open it in Terminal, without a fake transcript", async () => {
    const client = createFixtureProjectBoardClient({ latencyMs: 0 });
    const onOpenSession = vi.fn();
    render(<ProjectBoard client={client} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: /MOS-23: Clean up worktree/ }));
    const sheet = await screen.findByRole("dialog", { name: /MOS-23/ });
    fireEvent.click(within(sheet).getByRole("button", { name: "Start terminal" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open in Terminal" }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ kind: "terminal", title: "Terminal 1" }));
    expect(within(sheet).queryByText(/Prototype/)).toBeNull();
    expect((await client.getTask("task_fixture_23")).status).toBe("in_progress");
  });

  it("disables opening a session when the surface cannot open it", async () => {
    render(<ProjectBoard client={createFixtureProjectBoardClient({ latencyMs: 0 })} />);
    fireEvent.click(await screen.findByRole("button", { name: /MOS-30: Move project tasks/ }));
    const sheet = await screen.findByRole("dialog", { name: /MOS-30/ });
    fireEvent.click(within(sheet).getByRole("tab", { name: /Codex · tests, terminal/ }));
    expect(within(sheet).getByRole("button", { name: "Open in Terminal" })).toHaveProperty("disabled", true);
  });

  it("asks before closing when the server reports a working agent, then moves with force", async () => {
    const fixture = createFixtureProjectBoardClient({ latencyMs: 0 });
    const forced: boolean[] = [];
    const client: ProjectBoardClient = {
      ...fixture,
      moveTask: (taskId, input) => {
        forced.push(input.force === true);
        return input.force ? fixture.moveTask(taskId, input) : Promise.reject(new TaskAgentWorkingError());
      },
    };
    render(<ProjectBoard client={client} />);
    const card = await screen.findByRole("button", { name: /MOS-36: Drag and drop/ });
    await act(async () => { fireEvent.keyDown(card, { key: "ArrowRight", altKey: true }); });
    const dialog = await screen.findByRole("dialog", { name: "Agent still working" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to Done" }));
    await waitFor(() => expect(within(column(/^Done/)).queryByRole("button", { name: /MOS-36/ })).toBeTruthy());
    expect(forced).toEqual([false, true]);
    expect((await fixture.getTask("task_fixture_36")).status).toBe("done");
  });

  it("keeps the person's description on a conflict and saves it over theirs with Keep mine", async () => {
    const fixture = createFixtureProjectBoardClient({ latencyMs: 0 });
    let raced = false;
    const bases: number[] = [];
    const client: ProjectBoardClient = {
      ...fixture,
      updateTask: async (taskId, baseRevision, input) => {
        bases.push(baseRevision);
        if (!raced) {
          raced = true;
          const theirs = await fixture.updateTask(taskId, baseRevision, { description: "Their notes" });
          throw new TaskConflictError(theirs);
        }
        return fixture.updateTask(taskId, baseRevision, input);
      },
    };
    render(<ProjectBoard client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /MOS-23: Clean up worktree/ }));
    const sheet = await screen.findByRole("dialog", { name: /MOS-23/ });
    fireEvent.click(within(sheet).getByRole("button", { name: "Edit description" }));
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Description" }), { target: { value: "My notes" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    const conflict = await within(sheet).findByRole("alert", { name: /description changed/ });
    expect(within(conflict).getByText("Their notes")).toBeTruthy();
    expect(within(conflict).getByText("My notes")).toBeTruthy();
    expect((within(sheet).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe("My notes");

    fireEvent.click(within(conflict).getByRole("button", { name: "Keep mine" }));
    await waitFor(async () => expect((await fixture.getTask("task_fixture_23")).description).toBe("My notes"));
    expect(bases).toEqual([1, 2]);
    await waitFor(() => expect(within(sheet).queryByRole("alert", { name: /description changed/ })).toBeNull());
  });

  it("drops their version with Use theirs", async () => {
    const fixture = createFixtureProjectBoardClient({ latencyMs: 0 });
    const client: ProjectBoardClient = {
      ...fixture,
      updateTask: async (taskId, baseRevision) => {
        throw new TaskConflictError(await fixture.updateTask(taskId, baseRevision, { title: "Their title" }));
      },
    };
    render(<ProjectBoard client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /MOS-23: Clean up worktree/ }));
    const sheet = await screen.findByRole("dialog", { name: /MOS-23/ });
    const title = within(sheet).getByRole("textbox", { name: "Task title" });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "My title" } });
    fireEvent.blur(title);
    const conflict = await within(sheet).findByRole("alert", { name: /title changed/ });
    fireEvent.click(within(conflict).getByRole("button", { name: "Use theirs" }));
    expect((within(sheet).getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toBe("Their title");
    expect(within(sheet).queryByRole("alert", { name: /title changed/ })).toBeNull();
  });

  it("shows the empty state with both calls to action", async () => {
    render(<ProjectBoard client={createFixtureProjectBoardClient({ latencyMs: 0, empty: true })} onImportLinear={() => {}} />);
    const empty = await screen.findByTestId("project-board-empty");
    expect(within(empty).getByText("No tasks yet")).toBeTruthy();
    expect(within(empty).getByRole("button", { name: "New task" })).toBeTruthy();
    expect(within(empty).getByRole("button", { name: "Import from Linear" })).toBeTruthy();
  });

  it("hides Import from Linear when the surface offers no import", async () => {
    render(<ProjectBoard client={createFixtureProjectBoardClient({ latencyMs: 0, empty: true })} />);
    const empty = await screen.findByTestId("project-board-empty");
    expect(within(empty).queryByRole("button", { name: "Import from Linear" })).toBeNull();
  });
});
