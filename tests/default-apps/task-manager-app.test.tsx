// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/task-manager/src/App";

type DbRow = Record<string, unknown>;

interface FakeDb {
  columns: DbRow[];
  cards: DbRow[];
}

function installMatrixDb(initial?: Partial<FakeDb>) {
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
    value: { db },
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

  it("seeds default columns into Postgres on first run", async () => {
    const { db } = installMatrixDb();
    render(<App />);

    // The empty board seeds the default workflow columns.
    await waitFor(() => expect(db.insert).toHaveBeenCalledWith("columns", expect.objectContaining({ title: "Backlog" })));
    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done" })).toBeTruthy();
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
