// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/task-manager/src/App";
import { boardFromRows } from "../../home/apps/task-manager/src/persistence";

type DbRow = Record<string, unknown>;

interface FakeDb {
  columns: DbRow[];
  cards: DbRow[];
}

function installMatrixDb(initial?: Partial<FakeDb>, legacyBoard?: unknown) {
  const store: FakeDb = {
    columns: initial?.columns ? [...initial.columns] : [],
    cards: initial?.cards ? [...initial.cards] : [],
  };
  let seq = 0;
  const listeners: Record<string, Array<() => void>> = {};
  const emit = (table: string) => {
    for (const cb of listeners[table] ?? []) cb();
  };

  const db = {
    find: vi.fn(async (table: string, opts?: { orderBy?: Record<string, "asc" | "desc"> }) => {
      const rows = [...(store[table as keyof FakeDb] ?? [])];
      const orderBy = opts?.orderBy;
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy)[0] ?? [];
        if (key) {
          rows.sort((a, b) => {
            const av = Number(a[key] ?? 0);
            const bv = Number(b[key] ?? 0);
            return dir === "desc" ? bv - av : av - bv;
          });
        }
      }
      return rows;
    }),
    findOne: vi.fn(async (table: string, id: string) =>
      (store[table as keyof FakeDb] ?? []).find((row) => row.id === id) ?? null),
    insert: vi.fn(async (table: string, data: DbRow) => {
      seq += 1;
      const id = `${table}-${seq}`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      emit(table);
      return { id };
    }),
    update: vi.fn(async (table: string, id: string, data: DbRow) => {
      const list = store[table as keyof FakeDb];
      const idx = list.findIndex((row) => row.id === id);
      if (idx >= 0) list[idx] = { ...list[idx], ...data };
      emit(table);
      return { ok: true };
    }),
    delete: vi.fn(async (table: string, id: string) => {
      store[table as keyof FakeDb] = store[table as keyof FakeDb].filter((row) => row.id !== id);
      emit(table);
      return { ok: true };
    }),
    count: vi.fn(async (table: string) => (store[table as keyof FakeDb] ?? []).length),
    onChange: vi.fn((table: string, cb: () => void) => {
      (listeners[table] ??= []).push(cb);
      return () => {
        listeners[table] = (listeners[table] ?? []).filter((fn) => fn !== cb);
      };
    }),
  };

  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: {
      db,
      readData: vi.fn(async (key: string) => key === "project-board" ? legacyBoard : null),
    },
  });
  return { db, store };
}

describe("Task Manager app", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    localStorage.clear();
  });

  it("hydrates card updatedAt from the updated_at DB column", () => {
    const board = boardFromRows(
      [{ id: "col-1", title: "To do", color: "#7A7768", position: 0 }],
      [{
        id: "card-1",
        column_id: "col-1",
        title: "Fresh edit",
        position: 0,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-05-02T00:00:00.000Z",
      }],
    );

    expect(board.cards[0].updatedAt).toBe("2026-05-02T00:00:00.000Z");
  });

  it("seeds default columns into Postgres on first run", async () => {
    const { db } = installMatrixDb();
    render(<App />);

    // The empty board seeds the default workflow columns.
    await waitFor(() => expect(db.insert).toHaveBeenCalledWith("columns", expect.objectContaining({ title: "Backlog" })));
    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
  });

  it("migrates the legacy project-board bridge data before seeding defaults", async () => {
    const legacyBoard = {
      version: 1,
      projects: [{ id: "project-default", name: "Legacy", color: "#434E3F", description: "" }],
      columns: [{ id: "legacy-col", title: "Legacy Queue", color: "#7A7768" }],
      cards: [{
        id: "legacy-card",
        projectId: "project-default",
        columnId: "legacy-col",
        title: "Migrated card",
        description: "",
        priority: "medium",
        labels: [],
        assignee: "",
        dueDate: "",
        checklist: [],
        delegation: null,
        order: 0,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    const { db } = installMatrixDb(undefined, legacyBoard);

    render(<App />);

    await waitFor(() => {
      expect(window.MatrixOS?.readData).toHaveBeenCalledWith("project-board");
      expect(db.insert).toHaveBeenCalledWith("columns", expect.objectContaining({ title: "Legacy Queue" }));
      expect(db.insert).toHaveBeenCalledWith("cards", expect.objectContaining({
        title: "Migrated card",
        column_id: "columns-1",
      }));
    });
  });

  it("loads existing columns + cards from Postgres", async () => {
    installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Write the spec", description: "", labels: "", assignee: "", priority: "high", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    expect(await screen.findByText("Write the spec")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "To do" })).toBeTruthy();
  });

  it("adds a card via Enter and persists it to Postgres", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });
    render(<App />);

    const input = await screen.findByPlaceholderText("Add a card to To do");
    fireEvent.change(input, { target: { value: "Ship the board" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(db.insert).toHaveBeenCalledWith("cards", expect.objectContaining({ title: "Ship the board", column_id: "col-1" })),
    );
    expect(await screen.findByText("Ship the board")).toBeTruthy();

    fireEvent.click(screen.getByText("Ship the board"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Ship the board");
    fireEvent.change(titleInput, { target: { value: "Real DB id" } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith("cards", "cards-1", expect.objectContaining({ title: "Real DB id" })),
    );
  });

  it("waits for a new card insert before persisting immediate edits", async () => {
    const { db, store } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });
    let resolveCardInsert: (() => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "cards") {
        await new Promise<void>((resolve) => {
          resolveCardInsert = resolve;
        });
        const id = "cards-created";
        store.cards.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    const input = await screen.findByPlaceholderText("Add a card to To do");
    fireEvent.change(input, { target: { value: "Race card" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(await screen.findByText("Race card"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Race card");
    fireEvent.change(titleInput, { target: { value: "Resolved card" } });
    fireEvent.blur(titleInput);

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalledWith(
      "cards",
      expect.stringMatching(/^card-/),
      expect.anything(),
    );

    await act(async () => {
      resolveCardInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith(
        "cards",
        "cards-created",
        expect.objectContaining({ title: "Resolved card" }),
      ),
    );
  });

  it("persists a card created in a new column with the resolved DB column id", async () => {
    const { db, store } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });
    let resolveColumnInsert: (() => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "columns" && data.title === "Sprint") {
        await new Promise<void>((resolve) => {
          resolveColumnInsert = resolve;
        });
        const id = "columns-sprint";
        store.columns.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      if (table === "cards") {
        const id = "cards-sprint";
        store.cards.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /add column/i }));
    fireEvent.change(screen.getByPlaceholderText("Column name"), { target: { value: "Sprint" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const sprintInput = await screen.findByPlaceholderText("Add a card to Sprint");
    fireEvent.change(sprintInput, { target: { value: "Resolve the id race" } });
    fireEvent.keyDown(sprintInput, { key: "Enter" });

    expect(db.insert).not.toHaveBeenCalledWith("cards", expect.objectContaining({ title: "Resolve the id race" }));
    await act(async () => {
      resolveColumnInsert?.();
    });

    await waitFor(() =>
      expect(db.insert).toHaveBeenCalledWith("cards", expect.objectContaining({
        title: "Resolve the id race",
        column_id: "columns-sprint",
      })),
    );
  });

  it("waits for a new column insert before persisting an immediate rename", async () => {
    const { db, store } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });
    let resolveColumnInsert: (() => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "columns" && data.title === "Sprint") {
        await new Promise<void>((resolve) => {
          resolveColumnInsert = resolve;
        });
        const id = "columns-sprint";
        store.columns.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add column/i }));
    fireEvent.change(screen.getByPlaceholderText("Column name"), { target: { value: "Sprint" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const sprintHeading = await screen.findByRole("heading", { name: "Sprint" });
    fireEvent.click(sprintHeading.closest("button")!);
    const renameInput = screen.getByDisplayValue("Sprint");
    fireEvent.change(renameInput, { target: { value: "Ready" } });
    fireEvent.blur(renameInput);

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalledWith("columns", expect.stringMatching(/^column-/), expect.anything());

    await act(async () => {
      resolveColumnInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith("columns", "columns-sprint", { title: "Ready" }),
    );
  });

  it("filters cards by text query", async () => {
    installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Buy milk", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "card-2", column_id: "col-1", title: "Fix the bug", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    await screen.findByText("Buy milk");
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "bug" } });

    expect(screen.queryByText("Buy milk")).toBeNull();
    expect(screen.getByText("Fix the bug")).toBeTruthy();
  });

  it("opens a card detail and closes it with Escape", async () => {
    installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Inspect me", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Inspect me"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Inspect me")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("persists a card update through the DB bridge", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Edit me", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Edit me"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Edit me");
    fireEvent.change(titleInput, { target: { value: "Edited title" } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith("cards", "card-1", expect.objectContaining({ title: "Edited title" })),
    );
  });

  it("keeps a column visible when a DB column delete fails", async () => {
    const { db } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Keep me", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    db.delete.mockRejectedValueOnce(new Error("delete failed"));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("Delete column")[0]);

    expect(await screen.findByText(/column could not be deleted/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "To do" })).toBeTruthy();
  });

  it("waits for pending card inserts before deleting cards with their column", async () => {
    const { db, store } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [],
    });
    let resolveCardInsert: (() => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "cards") {
        await new Promise<void>((resolve) => {
          resolveCardInsert = resolve;
        });
        const id = "cards-created";
        store.cards.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    const input = await screen.findByPlaceholderText("Add a card to To do");
    fireEvent.change(input, { target: { value: "Remove with column" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Remove with column")).toBeTruthy();

    fireEvent.click(screen.getAllByTitle("Delete column")[0]);

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.delete).not.toHaveBeenCalledWith("cards", expect.stringMatching(/^card-/));

    await act(async () => {
      resolveCardInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.delete).toHaveBeenCalledWith("cards", "cards-created");
      expect(db.delete).toHaveBeenCalledWith("columns", "col-1");
    });
  });

  it("keeps concurrent card additions when a column delete finishes", async () => {
    const { db } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [],
    });
    let resolveColumnDelete: (() => void) | null = null;
    db.delete.mockImplementation(async (table: string, id: string) => {
      if (table === "columns" && id === "col-1") {
        await new Promise<void>((resolve) => {
          resolveColumnDelete = resolve;
        });
      }
      return { ok: true };
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("Delete column")[0]);

    const doneInput = screen.getByPlaceholderText("Add a card to Done");
    fireEvent.change(doneInput, { target: { value: "Concurrent card" } });
    fireEvent.keyDown(doneInput, { key: "Enter" });
    expect(await screen.findByText("Concurrent card")).toBeTruthy();

    await act(async () => {
      resolveColumnDelete?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: "To do" })).toBeNull());
    expect(screen.getByText("Concurrent card")).toBeTruthy();
  });

  it("waits for a pending column insert before deleting the column row", async () => {
    const { db, store } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [],
    });
    let resolveColumnInsert: (() => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "columns" && data.title === "Sprint") {
        await new Promise<void>((resolve) => {
          resolveColumnInsert = resolve;
        });
        const id = "columns-sprint";
        store.columns.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add column/i }));
    fireEvent.change(screen.getByPlaceholderText("Column name"), { target: { value: "Sprint" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const sprintColumn = await screen.findByLabelText("Sprint");
    fireEvent.click(within(sprintColumn).getByTitle("Delete column"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.delete).not.toHaveBeenCalledWith("columns", expect.stringMatching(/^column-/));

    await act(async () => {
      resolveColumnInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(db.delete).toHaveBeenCalledWith("columns", "columns-sprint"));
  });

  it("waits for a pending column insert before persisting reordered positions", async () => {
    const { db, store } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [],
    });
    let resolveColumnInsert: (() => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "columns" && data.title === "Sprint") {
        await new Promise<void>((resolve) => {
          resolveColumnInsert = resolve;
        });
        const id = "columns-sprint";
        store.columns.push({ id, created_at: new Date().toISOString(), ...data });
        return { id };
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add column/i }));
    fireEvent.change(screen.getByPlaceholderText("Column name"), { target: { value: "Sprint" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const sprintColumn = await screen.findByLabelText("Sprint");
    const todoColumn = screen.getByLabelText("To do");
    fireEvent.dragStart(within(sprintColumn).getByTitle("Reorder column"));
    fireEvent.drop(todoColumn);

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalledWith("columns", expect.stringMatching(/^column-/), expect.anything());

    await act(async () => {
      resolveColumnInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(db.update).toHaveBeenCalledWith("columns", "columns-sprint", { position: 0 }));
  });

  it("keeps an existing error visible after unrelated card saves", async () => {
    const { db, store } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Keep me", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    db.delete.mockRejectedValueOnce(new Error("delete failed"));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "To do" })).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("Delete column")[0]);
    const banner = await screen.findByText(/column could not be deleted/i);
    expect(banner).toBeTruthy();
    db.update.mockImplementationOnce(async (table: string, id: string, data: DbRow) => {
      const list = store[table as keyof FakeDb];
      const idx = list.findIndex((row) => row.id === id);
      if (idx >= 0) list[idx] = { ...list[idx], ...data };
      return { ok: true };
    });

    fireEvent.click(screen.getByText("Keep me"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Keep me");
    fireEvent.change(titleInput, { target: { value: "Still visible" } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith("cards", "card-1", expect.objectContaining({ title: "Still visible" })),
    );
    expect(screen.getByText(/column could not be deleted/i)).toBeTruthy();
  });

  it("shows a friendly error when the bridge fails to load", async () => {
    const db = {
      find: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      findOne: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      onChange: vi.fn(() => () => undefined),
    };
    Object.defineProperty(window, "MatrixOS", { configurable: true, value: { db } });

    render(<App />);
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
  });

  it("falls back to localStorage when no DB bridge is present", async () => {
    render(<App />);
    const input = await screen.findByPlaceholderText("Add a card to Backlog");
    fireEvent.change(input, { target: { value: "Local task" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Local task")).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem("task-manager:board")).toBeTruthy());
  });
});
