// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/task-manager/src/App";
import { boardFromRows, cardToRow } from "../../home/apps/task-manager/src/persistence";

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

  it("round-trips labels containing commas through structured storage", () => {
    const row = cardToRow({
      id: "card-1",
      projectId: "project-default",
      columnId: "col-1",
      title: "Tagged",
      description: "",
      priority: "medium",
      labels: ["bug, ui", "release"],
      assignee: "",
      dueDate: "",
      checklist: [],
      delegation: null,
      order: 0,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    }, 0);

    expect(row.labels).toEqual(["bug, ui", "release"]);

    const board = boardFromRows(
      [{ id: "col-1", title: "To do", color: "#7A7768", position: 0 }],
      [{ id: "card-1", created_at: "2026-05-01T00:00:00.000Z", ...row }],
    );
    expect(board.cards[0].labels).toEqual(["bug, ui", "release"]);
  });

  it("seeds default columns into Postgres on first run", async () => {
    const { db } = installMatrixDb();
    render(<App />);

    // The empty board seeds the default workflow columns.
    await waitFor(() => expect(db.insert).toHaveBeenCalledWith("columns", expect.objectContaining({ title: "Backlog" })));
    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
    expect(db.find.mock.calls.filter((call) => call[0] === "columns")).toHaveLength(2);
  });

  it("cleans up partially seeded columns when first-run seeding fails", async () => {
    const { db, store } = installMatrixDb();
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "columns" && data.title === "Ready") {
        throw new Error("seed failed");
      }
      const id = `${table}-${store[table as keyof FakeDb].length + 1}`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);

    expect(await screen.findByText(/board could not be loaded/i)).toBeTruthy();
    await waitFor(() => expect(db.delete).toHaveBeenCalledWith("columns", "columns-1"));
    expect(store.columns).toHaveLength(0);
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

  it("migrates local fallback board data when the DB bridge becomes available", async () => {
    const localBoard = {
      version: 1,
      projects: [{ id: "project-default", name: "Local", color: "#434E3F", description: "" }],
      columns: [{ id: "local-col", title: "Local Queue", color: "#7A7768" }],
      cards: [{
        id: "local-card",
        projectId: "project-default",
        columnId: "local-col",
        title: "Recovered local card",
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
    localStorage.setItem("task-manager:board", JSON.stringify(localBoard));
    const { db } = installMatrixDb();

    render(<App />);

    await waitFor(() => {
      expect(db.insert).toHaveBeenCalledWith("columns", expect.objectContaining({ title: "Local Queue" }));
      expect(db.insert).toHaveBeenCalledWith("cards", expect.objectContaining({
        title: "Recovered local card",
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

  it("does not claim the board refreshed when failed persistence cannot reload", async () => {
    const { db } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Write the spec", description: "", labels: "", assignee: "", priority: "high", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Write the spec"));
    db.update.mockRejectedValueOnce(new Error("offline"));
    db.find.mockRejectedValue(new Error("still offline"));

    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Write the spec");
    fireEvent.change(titleInput, { target: { value: "Offline edit" } });
    fireEvent.blur(titleInput);

    expect(await screen.findByText("Card could not be updated. Reopen the board to refresh.")).toBeTruthy();
  });

  it("does not persist a title edit that only changes whitespace", async () => {
    const { db } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Write the spec", description: "", labels: "", assignee: "", priority: "high", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Write the spec"));
    db.update.mockClear();

    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Write the spec");
    fireEvent.change(titleInput, { target: { value: "  Write the spec  " } });
    fireEvent.blur(titleInput);

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(within(dialog).getByDisplayValue("Write the spec")).toBeTruthy();
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

  it("persists pending checklist changes with the latest live checklist", async () => {
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
    fireEvent.change(input, { target: { value: "Checklist pending" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(await screen.findByText("Checklist pending"));
    const dialog = await screen.findByRole("dialog");
    const checklistInput = within(dialog).getByLabelText("Add checklist item");
    fireEvent.change(checklistInput, { target: { value: "first" } });
    fireEvent.submit(checklistInput.closest("form") as HTMLFormElement);
    await waitFor(() => expect(within(dialog).getByText("first")).toBeTruthy());
    fireEvent.change(checklistInput, { target: { value: "second" } });
    fireEvent.submit(checklistInput.closest("form") as HTMLFormElement);

    await act(async () => {
      resolveCardInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const checklistUpdates = db.update.mock.calls.filter(
        ([table, id, data]) => table === "cards" && id === "cards-created" && Array.isArray(data.checklist),
      );
      expect(checklistUpdates.at(-1)?.[2].checklist).toEqual([
        expect.objectContaining({ text: "first" }),
        expect.objectContaining({ text: "second" }),
      ]);
    });
  });

  it("persists pending card edits with the latest live column and order", async () => {
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
    fireEvent.change(input, { target: { value: "Race card" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(await screen.findByText("Race card"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Race card");
    fireEvent.change(titleInput, { target: { value: "Moved card" } });
    fireEvent.blur(titleInput);
    fireEvent.change(within(dialog).getByLabelText("Column"), { target: { value: "col-2" } });

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
        expect.objectContaining({
          title: "Moved card",
          column_id: "col-2",
          position: 0,
        }),
      ),
    );
    const cardUpdates = db.update.mock.calls.filter(
      (call) => call[0] === "cards" && call[1] === "cards-created",
    );
    expect(cardUpdates.at(-1)?.[2]).toMatchObject({
      column_id: "col-2",
      position: 0,
    });
    expect(store.cards.find((card) => card.id === "cards-created")).toMatchObject({
      title: "Moved card",
      column_id: "col-2",
      position: 0,
    });
  });

  it("resolves a pending destination column before persisting card detail edits", async () => {
    const { db, store } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [{ id: "card-1", column_id: "col-1", title: "Move me", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" }],
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
    expect(await screen.findByText("Move me")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add column/i }));
    fireEvent.change(screen.getByPlaceholderText("Column name"), { target: { value: "Sprint" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    fireEvent.click(screen.getByText("Move me"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Move me");
    fireEvent.change(titleInput, { target: { value: "Moved with title" } });
    fireEvent.blur(titleInput);
    const columnSelect = within(dialog).getByLabelText("Column") as HTMLSelectElement;
    const sprintOption = Array.from(columnSelect.options).find((option) => option.textContent === "Sprint");
    expect(sprintOption?.value).toMatch(/^column-/);
    fireEvent.change(columnSelect, { target: { value: sprintOption!.value } });

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalledWith(
      "cards",
      "card-1",
      expect.objectContaining({ column_id: expect.stringMatching(/^column-/) }),
    );

    await act(async () => {
      resolveColumnInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith(
        "cards",
        "card-1",
        expect.objectContaining({ title: "Moved with title", column_id: "columns-sprint" }),
      ),
    );
  });

  it("keeps card detail drafts when a pending card id resolves", async () => {
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
    fireEvent.change(input, { target: { value: "Draft card" } });
    fireEvent.keyDown(input, { key: "Enter" });

    fireEvent.click(await screen.findByText("Draft card"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Card title"), { target: { value: "Unsaved title" } });
    fireEvent.change(within(dialog).getByPlaceholderText("Add more detail…"), {
      target: { value: "Unsaved details" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("Unassigned"), { target: { value: "Morgan" } });

    await act(async () => {
      resolveCardInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    const updatedDialog = await screen.findByRole("dialog");
    expect(within(updatedDialog).getByDisplayValue("Unsaved title")).toBeTruthy();
    expect(within(updatedDialog).getByDisplayValue("Unsaved details")).toBeTruthy();
    expect(within(updatedDialog).getByDisplayValue("Morgan")).toBeTruthy();
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

  it("persists pending new-column cards with their latest live order", async () => {
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
        const id = `cards-${String(data.title).toLowerCase()}`;
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
    fireEvent.change(sprintInput, { target: { value: "Alpha" } });
    fireEvent.keyDown(sprintInput, { key: "Enter" });
    fireEvent.change(sprintInput, { target: { value: "Beta" } });
    fireEvent.keyDown(sprintInput, { key: "Enter" });

    fireEvent.click(await screen.findByText("Alpha"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /delete card/i }));

    await act(async () => {
      resolveColumnInsert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(db.insert).toHaveBeenCalledWith(
        "cards",
        expect.objectContaining({ title: "Beta", column_id: "columns-sprint", position: 0 }),
      ),
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

  it("does not persist a cancelled column rename after Escape blurs the input", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "To do" });
    fireEvent.click(heading.closest("button")!);
    const renameInput = screen.getByDisplayValue("To do");
    fireEvent.change(renameInput, { target: { value: "Cancelled" } });
    fireEvent.keyDown(renameInput, { key: "Escape" });
    fireEvent.blur(renameInput);

    await act(async () => {
      await Promise.resolve();
    });

    expect(db.update).not.toHaveBeenCalledWith("columns", "col-1", { title: "Cancelled" });
    expect(screen.getByRole("heading", { name: "To do" })).toBeTruthy();
  });

  it("does not duplicate column rename writes when Enter submission blurs the input", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "To do" });
    fireEvent.click(heading.closest("button")!);
    const renameInput = screen.getByDisplayValue("To do");
    fireEvent.change(renameInput, { target: { value: "Ready" } });
    fireEvent.submit(renameInput.closest("form")!);
    fireEvent.blur(renameInput);

    await waitFor(() => expect(db.update).toHaveBeenCalledTimes(1));
    expect(db.update).toHaveBeenCalledWith("columns", "col-1", { title: "Ready" });
  });

  it("does not persist an empty column title on rename", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });

    render(<App />);
    const heading = await screen.findByRole("heading", { name: "To do" });
    fireEvent.click(heading.closest("button")!);
    const renameInput = screen.getByDisplayValue("To do");
    fireEvent.change(renameInput, { target: { value: "   " } });
    fireEvent.blur(renameInput);

    await act(async () => {
      await Promise.resolve();
    });

    expect(db.update).not.toHaveBeenCalledWith("columns", "col-1", { title: "" });
    expect(db.update).not.toHaveBeenCalledWith("columns", "col-1", { title: "   " });
    expect(screen.getByRole("heading", { name: "To do" })).toBeTruthy();
  });

  it("reloads away a phantom column when its insert fails", async () => {
    const { db, store } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });
    let rejectColumnInsert: ((error: Error) => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "columns" && data.title === "Sprint") {
        await new Promise<never>((_resolve, reject) => {
          rejectColumnInsert = reject;
        });
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

    expect(await screen.findByRole("heading", { name: "Sprint" })).toBeTruthy();
    await act(async () => {
      rejectColumnInsert?.(new Error("insert failed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText(/column could not be created/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sprint" })).toBeNull());
    expect(screen.getByRole("heading", { name: "To do" })).toBeTruthy();
  });

  it("reloads away a phantom card when its insert fails", async () => {
    const { db, store } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [],
    });
    let rejectCardInsert: ((error: Error) => void) | null = null;
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      if (table === "cards" && data.title === "Ghost card") {
        await new Promise<never>((_resolve, reject) => {
          rejectCardInsert = reject;
        });
      }
      const id = `${table}-fallback`;
      store[table as keyof FakeDb].push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    });

    render(<App />);
    const input = await screen.findByPlaceholderText("Add a card to To do");
    fireEvent.change(input, { target: { value: "Ghost card" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Ghost card")).toBeTruthy();
    await act(async () => {
      rejectCardInsert?.(new Error("insert failed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText(/card could not be saved/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Ghost card")).toBeNull());
    expect(screen.getByRole("heading", { name: "To do" })).toBeTruthy();
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

  it("preserves live checklist state when saving a title edit", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        {
          id: "card-1",
          column_id: "col-1",
          title: "Checklist race",
          description: "",
          labels: "",
          assignee: "",
          priority: "medium",
          due: null,
          checklist: [{ id: "item-1", text: "Persist me", done: false }],
          position: 0,
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Checklist race"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /persist me/i }));
    const titleInput = within(dialog).getByDisplayValue("Checklist race");
    fireEvent.change(titleInput, { target: { value: "Checklist title" } });
    fireEvent.blur(titleInput);

    await waitFor(() => {
      const titleUpdate = db.update.mock.calls.find(
        ([table, id, data]) => table === "cards" && id === "card-1" && data.title === "Checklist title",
      );
      expect(titleUpdate?.[2]).toEqual(expect.objectContaining({
        checklist: [expect.objectContaining({ id: "item-1", done: true })],
      }));
    });
  });

  it("keeps a deleted column deleted when a stale card update resolves later", async () => {
    const { db, store } = installMatrixDb({
      columns: [
        { id: "col-a", title: "Doing", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-b", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-a", column_id: "col-a", title: "Race card", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    const baseUpdate = db.update.getMockImplementation();
    let releaseCardUpdate: (() => void) | null = null;
    db.update.mockImplementation(async (table: string, id: string, data: DbRow) => {
      if (table === "cards" && id === "card-a" && data.title === "Edited while deleting") {
        await new Promise<void>((resolve) => {
          releaseCardUpdate = resolve;
        });
      }
      return baseUpdate?.(table, id, data) ?? { ok: true };
    });

    render(<App />);
    fireEvent.click(await screen.findByText("Race card"));
    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByDisplayValue("Race card");
    fireEvent.change(titleInput, { target: { value: "Edited while deleting" } });
    fireEvent.blur(titleInput);

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith("cards", "card-a", expect.objectContaining({ title: "Edited while deleting" })),
    );

    const doingColumn = screen.getByRole("heading", { name: "Doing" }).closest("section");
    fireEvent.click(within(doingColumn as HTMLElement).getByTitle("Delete column"));
    await waitFor(() => expect(db.delete).toHaveBeenCalledWith("cards", "card-a"));
    await waitFor(() => expect(db.delete).toHaveBeenCalledWith("columns", "col-a"));

    await act(async () => {
      releaseCardUpdate?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.columns.some((column) => column.id === "col-a")).toBe(false);
    expect(store.cards.some((card) => card.id === "card-a")).toBe(false);
    expect(screen.queryByRole("heading", { name: "Doing" })).toBeNull();
  });

  it("reloads checklist state when a DB checklist update fails", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        {
          id: "card-1",
          column_id: "col-1",
          title: "Verify rollback",
          description: "",
          labels: "",
          assignee: "",
          priority: "medium",
          due: null,
          checklist: [{ id: "item-1", text: "Persist me", done: false }],
          position: 0,
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    db.update.mockRejectedValueOnce(new Error("update failed"));

    render(<App />);
    fireEvent.click(await screen.findByText("Verify rollback"));
    const checklistItem = within(await screen.findByRole("dialog")).getByRole("button", { name: /persist me/i });
    fireEvent.click(checklistItem);

    expect(await screen.findByText(/checklist could not be saved/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("Checklist").parentElement?.textContent).toContain("0/1"),
    );
  });

  it("clears draft label and checklist inputs when switching selected cards", async () => {
    installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Alpha", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "card-2", column_id: "col-1", title: "Beta", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    fireEvent.click(await screen.findByText("Alpha"));
    let dialog = await screen.findByRole("dialog");
    const labelInput = within(dialog).getByLabelText("Add label") as HTMLInputElement;
    const checklistInput = within(dialog).getByLabelText("Add checklist item") as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "bug" } });
    fireEvent.change(checklistInput, { target: { value: "verify" } });

    fireEvent.click(screen.getByText("Beta"));

    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("Beta")).toBeTruthy();
    expect((within(dialog).getByLabelText("Add label") as HTMLInputElement).value).toBe("");
    expect((within(dialog).getByLabelText("Add checklist item") as HTMLInputElement).value).toBe("");
  });

  it("does not persist card reorders while a filter is active", async () => {
    const { db } = installMatrixDb({
      columns: [{ id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" }],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Visible card", description: "", labels: "urgent", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "card-2", column_id: "col-1", title: "Hidden card", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    render(<App />);

    await screen.findByText("Visible card");
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "Visible" } });
    expect(screen.queryByText("Hidden card")).toBeNull();

    const visibleCard = screen.getByText("Visible card").closest(".task-card");
    const column = screen.getByLabelText("To do");
    if (!visibleCard) throw new Error("Expected visible task card");
    fireEvent.dragStart(visibleCard);
    fireEvent.drop(column);

    await act(async () => {
      await Promise.resolve();
    });
    expect(db.update).not.toHaveBeenCalled();
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

  it("keeps a card visible when a DB card delete fails", async () => {
    const { db } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Keep me", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    db.delete.mockRejectedValueOnce(new Error("delete failed"));
    render(<App />);

    fireEvent.click(await screen.findByText("Keep me"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /delete card/i }));

    expect(await screen.findByText(/card could not be deleted/i)).toBeTruthy();
    expect(await screen.findByText("Keep me")).toBeTruthy();
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

  it("does not add cards to a column while its deletion is in flight", async () => {
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

    const input = screen.getByPlaceholderText("Add a card to To do");
    fireEvent.change(input, { target: { value: "Late card" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByText("Late card")).toBeNull();
    expect(db.insert).not.toHaveBeenCalledWith("cards", expect.objectContaining({ title: "Late card" }));

    await act(async () => {
      resolveColumnDelete?.();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("does not move cards into a column while its deletion is in flight", async () => {
    const { db } = installMatrixDb({
      columns: [
        { id: "col-1", title: "To do", color: "#7A7768", position: 0, created_at: "2026-05-01T00:00:00Z" },
        { id: "col-2", title: "Done", color: "#3A7D44", position: 1, created_at: "2026-05-01T00:00:00Z" },
      ],
      cards: [
        { id: "card-1", column_id: "col-1", title: "Stay put", description: "", labels: "", assignee: "", priority: "medium", due: null, checklist: [], position: 0, created_at: "2026-05-01T00:00:00Z" },
      ],
    });
    let resolveColumnDelete: (() => void) | null = null;
    db.delete.mockImplementation(async (table: string, id: string) => {
      if (table === "columns" && id === "col-2") {
        await new Promise<void>((resolve) => {
          resolveColumnDelete = resolve;
        });
      }
      return { ok: true };
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Done" })).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("Delete column")[1]);

    const card = screen.getByText("Stay put").closest(".task-card");
    if (!card) throw new Error("Expected task card");
    fireEvent.dragStart(card);
    fireEvent.drop(screen.getByLabelText("Done"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(within(screen.getByLabelText("To do")).getByText("Stay put")).toBeTruthy();
    expect(db.update).not.toHaveBeenCalledWith(
      "cards",
      "card-1",
      expect.objectContaining({ column_id: "col-2" }),
    );

    await act(async () => {
      resolveColumnDelete?.();
      await Promise.resolve();
      await Promise.resolve();
    });
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
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sprint" })).toBeNull());
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
