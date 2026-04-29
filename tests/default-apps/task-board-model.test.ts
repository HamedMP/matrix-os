import { describe, expect, it } from "vitest";
import {
  addCard,
  createBoard,
  moveCard,
  summarizeBoard,
  toggleChecklistItem,
} from "../../home/apps/task-manager/src/board-model";

describe("task board model", () => {
  it("creates a project board with Trello-style workflow columns", () => {
    const board = createBoard("Matrix OS Launch");

    expect(board.projects[0].name).toBe("Matrix OS Launch");
    expect(board.columns.map((column) => column.title)).toEqual([
      "Backlog",
      "Ready",
      "In progress",
      "Review",
      "Done",
    ]);
  });

  it("adds and moves cards across columns without losing ordering", () => {
    let board = createBoard("Default");
    board = addCard(board, {
      columnId: "backlog",
      title: "Write onboarding spec",
      projectId: board.projects[0].id,
    });
    board = addCard(board, {
      columnId: "backlog",
      title: "Ship task board",
      projectId: board.projects[0].id,
    });

    const movingCard = board.cards.find((card) => card.title === "Write onboarding spec");
    expect(movingCard).toBeDefined();

    board = moveCard(board, movingCard!.id, "in-progress", 0);

    expect(board.cards.filter((card) => card.columnId === "in-progress").map((card) => card.title)).toEqual([
      "Write onboarding spec",
    ]);
    expect(board.cards.filter((card) => card.columnId === "backlog").map((card) => card.title)).toEqual([
      "Ship task board",
    ]);
  });

  it("summarizes active projects and checklist completion", () => {
    let board = createBoard("Default");
    board = addCard(board, {
      columnId: "ready",
      title: "QA release",
      projectId: board.projects[0].id,
      checklist: [
        { id: "a", text: "Test notes", done: false },
        { id: "b", text: "Test boards", done: false },
      ],
    });
    const card = board.cards[0];
    board = toggleChecklistItem(board, card.id, "a");

    expect(summarizeBoard(board)).toEqual({
      totalCards: 1,
      doneCards: 0,
      activeProjects: 1,
      checklistDone: 1,
      checklistTotal: 2,
    });
  });
});
