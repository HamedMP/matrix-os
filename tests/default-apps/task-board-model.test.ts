import { describe, expect, it } from "vitest";
import {
  addCard,
  createBoard,
  delegateCard,
  hydrateBoard,
  moveCardToAdjacentColumn,
  moveCard,
  resolveColumnId,
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
      delegatedCards: 0,
      urgentCards: 0,
    });
  });

  it("summarizes completed cards on custom boards without a done column id", () => {
    let board = createBoard("Custom");
    board = {
      ...board,
      columns: [
        { id: "today", title: "Today", color: "#0ea5e9" },
        { id: "complete", title: "Complete", color: "#10b981" },
      ],
    };
    board = addCard(board, {
      columnId: "complete",
      title: "Custom board done",
      projectId: board.projects[0].id,
    });

    expect(summarizeBoard(board).doneCards).toBe(1);
  });

  it("records Matrix and Hermes delegation intent on cards", () => {
    let board = createBoard("Default");
    board = addCard(board, {
      columnId: "ready",
      title: "Research integration path",
      projectId: board.projects[0].id,
    });

    const card = board.cards[0];
    board = delegateCard(board, card.id, {
      target: "hermes",
      trigger: "when_ready",
      instructions: "Use a cloud worker and report tradeoffs before implementation.",
    });

    expect(board.cards[0].delegation).toMatchObject({
      target: "hermes",
      trigger: "when_ready",
      status: "queued",
      instructions: "Use a cloud worker and report tradeoffs before implementation.",
    });
    expect(summarizeBoard(board).delegatedCards).toBe(1);
  });

  it("hydrates legacy cards without delegation fields", () => {
    const board = hydrateBoard({
      version: 1,
      projects: [{ id: "project-a", name: "A", color: "#2563eb", description: "" }],
      columns: [{ id: "backlog", title: "Backlog", color: "#64748b" }],
      cards: [{
        id: "card-a",
        projectId: "project-a",
        columnId: "backlog",
        title: "Legacy card",
        description: "",
        priority: "urgent",
        labels: [],
        assignee: "",
        dueDate: "",
        checklist: [],
        order: 0,
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:00:00.000Z",
      }],
      updatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(board.cards[0].delegation).toBeNull();
    expect(summarizeBoard(board).urgentCards).toBe(1);
  });

  it("moves cards to adjacent columns for touch and keyboard controls", () => {
    let board = createBoard("Default");
    board = addCard(board, {
      columnId: "backlog",
      title: "Touch move",
      projectId: board.projects[0].id,
    });

    const card = board.cards[0];
    board = moveCardToAdjacentColumn(board, card.id, "next");
    expect(board.cards[0].columnId).toBe("ready");

    board = moveCardToAdjacentColumn(board, card.id, "previous");
    board = moveCardToAdjacentColumn(board, card.id, "previous");
    expect(board.cards[0].columnId).toBe("backlog");
  });

  it("keeps quick-created cards visible when the requested column is stale", () => {
    let board = createBoard("Custom");
    board = {
      ...board,
      columns: [{ id: "today", title: "Today", color: "#0ea5e9" }],
    };

    board = addCard(board, {
      columnId: "backlog",
      title: "Custom board capture",
      projectId: board.projects[0].id,
    });

    expect(resolveColumnId(board, "backlog")).toBe("today");
    expect(board.cards[0].columnId).toBe("today");
  });

  it("hydrates stale card column references into the first available column", () => {
    const board = hydrateBoard({
      version: 1,
      projects: [{ id: "project-a", name: "A", color: "#2563eb", description: "" }],
      columns: [{ id: "today", title: "Today", color: "#0ea5e9" }],
      cards: [{
        id: "card-a",
        projectId: "project-a",
        columnId: "backlog",
        title: "Previously orphaned card",
        description: "",
        priority: "medium",
        labels: [],
        assignee: "",
        dueDate: "",
        checklist: [],
        delegation: null,
        order: 0,
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:00:00.000Z",
      }],
      updatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(board.cards[0].columnId).toBe("today");
  });

  it("hydrates cards with malformed identity fields into mutable records", () => {
    const board = hydrateBoard({
      version: 1,
      projects: [{ id: "project-a", name: "A", color: "#2563eb", description: "" }],
      columns: [{ id: "today", title: "Today", color: "#0ea5e9" }],
      cards: [{
        id: undefined,
        projectId: undefined,
        columnId: "today",
        title: "Malformed identity",
        description: "",
        priority: "medium",
        labels: [],
        assignee: "",
        dueDate: "",
        checklist: [],
        delegation: null,
        order: 0,
        createdAt: "2026-05-10T00:00:00.000Z",
        updatedAt: "2026-05-10T00:00:00.000Z",
      }],
      updatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(board.cards[0].id).toMatch(/^card-/);
    expect(board.cards[0].projectId).toBe("");
    expect(moveCard(board, board.cards[0].id, "today", 0).cards[0].id).toBe(board.cards[0].id);
  });
});
