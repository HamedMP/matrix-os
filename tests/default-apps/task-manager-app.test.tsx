// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/task-manager/src/App";
import { addCard, createBoard, type Board } from "../../home/apps/task-manager/src/board-model";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function boardValue(board: Board): { value: string } {
  return { value: JSON.stringify(board) };
}

describe("Task Manager app persistence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("blocks editing when the persisted board payload is malformed", async () => {
    const fetchMock = vi.fn(async () => new Response("{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("Board could not be loaded.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add task/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("debounces detail edits and persists only the latest board", async () => {
    let board = createBoard("Matrix OS");
    board = addCard(board, {
      columnId: "backlog",
      projectId: board.projects[0].id,
      title: "Initial title",
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ok: true });
      return jsonResponse(boardValue(board));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(await screen.findByText("Initial title"));
    fetchMock.mockClear();
    vi.useFakeTimers();

    const titleInput = screen.getByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "First edit" } });
    fireEvent.change(titleInput, { target: { value: "Final edit" } });

    await act(async () => {
      vi.advanceTimersByTime(399);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(requestInit?.body)) as { value: string };
    const savedBoard = JSON.parse(body.value) as Board;
    expect(savedBoard.cards[0].title).toBe("Final edit");
  });
});
