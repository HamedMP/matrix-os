// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectBoard } from "../../packages/ui/src/project-board/ProjectBoard";
import { TicketHeader } from "../../packages/ui/src/project-board/TicketHeader";
import { useChatTicket } from "../../packages/ui/src/project-board/use-chat-ticket";
import { ProjectBoardRequestError, TaskConflictError } from "../../packages/ui/src/project-board/client";
import { boardTask, fakeBoardClient } from "./project-board-fake-client";

afterEach(cleanup);

describe("every task is a chat", () => {
  it("opens a card's chat when the surface can, and its details when it cannot", async () => {
    const task = boardTask("t1", { title: "Fix login" });
    const { client } = fakeBoardClient(() => [task]);
    const onOpenChat = vi.fn();
    const { unmount } = render(<ProjectBoard client={client} onOpenChat={onOpenChat} />);
    fireEvent.click(await screen.findByText("Fix login"));
    expect(onOpenChat).toHaveBeenCalledWith(task);
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    render(<ProjectBoard client={client} />);
    fireEvent.click(await screen.findByText("Fix login"));
    expect(await screen.findByRole("dialog", { name: "MOS-1: Fix login" })).toBeTruthy();
  });

  it("opens a task's details on request, for a chat's ticket header", async () => {
    const task = boardTask("t1", { title: "Fix login" });
    const { client } = fakeBoardClient(() => [task]);
    render(<ProjectBoard client={client} onOpenChat={vi.fn()} detailsTaskId="t1" />);
    expect(await screen.findByRole("dialog", { name: "MOS-1: Fix login" })).toBeTruthy();
  });

  it("edits the ticket from the chat's header", async () => {
    const onStatusChange = vi.fn();
    const onUpdate = vi.fn();
    const onOpenDetails = vi.fn();
    render(<TicketHeader task={boardTask("t1", { labels: ["bug"] })} members={[]} onUpdate={onUpdate} onStatusChange={onStatusChange} onOpenDetails={onOpenDetails} />);
    expect(screen.getByRole("group", { name: "Ticket MOS-1" })).toBeTruthy();
    const header = screen.getByRole("group", { name: "Ticket MOS-1" });
    fireEvent.click(header.querySelector<HTMLElement>("button[aria-haspopup=listbox]")!);
    await screen.findByRole("listbox", { name: "Status" });
    fireEvent.click(screen.getAllByRole("option", { name: /In review/ })[0]!);
    expect(onStatusChange).toHaveBeenCalledWith("in_review");
    fireEvent.click(screen.getByRole("button", { name: "Remove label bug" }));
    expect(onUpdate).toHaveBeenCalledWith({ labels: [] });
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(onOpenDetails).toHaveBeenCalled();
  });

  it("loads a chat's ticket, saves edits and keeps the server copy after a lost race", async () => {
    let server = boardTask("t1", { chatId: "chat_a", revision: 3 });
    const fake = fakeBoardClient(() => [server]);
    fake.client.updateTask.mockImplementationOnce(async () => { server = { ...server, priority: "high", revision: 4 }; return server; });
    const { result } = renderHook(() => useChatTicket(fake.client, "chat_a"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));

    await act(() => result.current.update({ priority: "high" }));
    expect(fake.client.updateTask).toHaveBeenCalledWith("t1", 3, { priority: "high" });
    expect(result.current.task?.priority).toBe("high");

    const theirs = { ...server, title: "Theirs", revision: 5 };
    fake.client.updateTask.mockRejectedValueOnce(new TaskConflictError(theirs));
    await act(() => result.current.update({ priority: "low" }));
    expect(result.current.task?.title).toBe("Theirs");
    expect(result.current.notice).toMatch(/Someone else changed/);
  });

  it("says a terminal could not start, not that a save failed", async () => {
    const fake = fakeBoardClient(() => [boardTask("t1", { chatId: "chat_a" })]);
    fake.client.startWork.mockRejectedValueOnce(new ProjectBoardRequestError("The session could not be started right now.", "task_session_unavailable"));
    const { result } = renderHook(() => useChatTicket(fake.client, "chat_a"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));
    let started: unknown = "pending";
    await act(async () => { started = await result.current.startTerminal(); });
    expect(started).toBeNull();
    expect(result.current.notice).toBe("Couldn't start the terminal. Try again.");
  });

  it("has no ticket for a chat outside every board", async () => {
    const fake = fakeBoardClient(() => []);
    const { result } = renderHook(() => useChatTicket(fake.client, "chat_loose"));
    await waitFor(() => expect(fake.client.findTaskByChat).toHaveBeenCalledWith("chat_loose"));
    expect(result.current.task).toBeNull();
  });
});
