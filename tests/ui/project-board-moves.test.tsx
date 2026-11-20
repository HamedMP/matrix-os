// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useProjectBoard } from "../../packages/ui/src/project-board/use-project-board";
import type { ProjectTask } from "../../packages/ui/src/project-board/types";
import { boardTask, deferred, fakeBoardClient } from "./project-board-fake-client";

afterEach(cleanup);

async function loadedBoard(tasks: () => readonly ProjectTask[]) {
  const fake = fakeBoardClient(tasks);
  const hook = renderHook(() => useProjectBoard(fake.client));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return { ...fake, hook, task: (id: string) => hook.result.current.tasks.find((task) => task.id === id) };
}

describe("useProjectBoard moves", () => {
  it("sends a task's second quick move only after the first settles, and ends where the last move put it", async () => {
    const { client, hook, task } = await loadedBoard(() => [boardTask("t1", { status: "todo", revision: 1 })]);
    const first = deferred<ProjectTask>();
    const second = deferred<ProjectTask>();
    client.moveTask.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let firstResult!: Promise<unknown>;
    let secondResult!: Promise<unknown>;
    act(() => { firstResult = hook.result.current.moveTask("t1", "in_progress", 0); });
    act(() => { secondResult = hook.result.current.moveTask("t1", "in_review", 0); });

    expect(client.moveTask).toHaveBeenCalledTimes(1);
    expect(task("t1")?.status).toBe("in_review");

    await act(async () => { first.resolve(boardTask("t1", { status: "in_progress", revision: 2 })); await firstResult; });
    // The newer move is still on its way: the card stays where it was last put.
    expect(task("t1")?.status).toBe("in_review");
    expect(client.moveTask).toHaveBeenCalledTimes(2);
    expect(client.moveTask.mock.calls[1]![1]).toMatchObject({ status: "in_review" });

    await act(async () => { second.resolve(boardTask("t1", { status: "in_review", revision: 3 })); await secondResult; });
    expect(task("t1")).toMatchObject({ status: "in_review", revision: 3 });
  });

  it("keeps a newer server copy when a move reply carries an older revision", async () => {
    let server: ProjectTask = boardTask("t1", { status: "todo", revision: 1 });
    const { client, hook, task, emit } = await loadedBoard(() => [server]);
    const reply = deferred<ProjectTask>();
    client.moveTask.mockReturnValueOnce(reply.promise);

    let result!: Promise<unknown>;
    act(() => { result = hook.result.current.moveTask("t1", "in_progress", 0); });
    // Someone else moved it on, and the refetch lands before the move's reply.
    server = boardTask("t1", { status: "done", revision: 3 });
    await act(async () => { emit({ type: "task.moved", taskId: "t1", revision: 3 }); });
    await waitFor(() => expect(client.listTasks).toHaveBeenCalledTimes(2));

    await act(async () => { reply.resolve(boardTask("t1", { status: "in_progress", revision: 2 })); await result; });
    expect(task("t1")).toMatchObject({ status: "done", revision: 3 });
  });

  it("still sends a queued move when the one before it fails", async () => {
    const { client, hook, task } = await loadedBoard(() => [boardTask("t1", { status: "todo", revision: 1 })]);
    const first = deferred<ProjectTask>();
    client.moveTask.mockReturnValueOnce(first.promise).mockResolvedValueOnce(boardTask("t1", { status: "done", revision: 2 }));

    let firstResult!: Promise<unknown>;
    let secondResult!: Promise<unknown>;
    act(() => { firstResult = hook.result.current.moveTask("t1", "in_progress", 0); });
    act(() => { secondResult = hook.result.current.moveTask("t1", "done", 0); });
    await act(async () => { first.reject(new Error("offline")); await firstResult; await secondResult; });

    expect(client.moveTask).toHaveBeenCalledTimes(2);
    expect(task("t1")).toMatchObject({ status: "done", revision: 2 });
  });
});
