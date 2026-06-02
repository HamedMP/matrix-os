// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/whiteboard/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  // Mutable backing store so insert/update/delete + find reflect each other,
  // and find() can be filtered/sorted like the bridge calls the app relies on.
  const store: DbRow[] = rows.map((r) => ({ ...r }));
  let seq = 0;
  const db = {
    find: vi.fn(async (_table: string, opts?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc"> }) => {
      const where = opts?.where;
      let matched = where
        ? store.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        : store;
      if (opts?.orderBy) {
        const [field, dir] = Object.entries(opts.orderBy)[0] as [string, "asc" | "desc"];
        matched = [...matched].sort((a, b) => {
          const av = String(a[field] ?? "");
          const bv = String(b[field] ?? "");
          return dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
        });
      }
      return matched.map((r) => ({ ...r }));
    }),
    findOne: vi.fn(async (_table: string, id: string) => {
      const row = store.find((r) => r.id === id);
      return row ? { ...row } : null;
    }),
    insert: vi.fn(async (_table: string, data: Record<string, unknown>) => {
      seq += 1;
      const id = `scene-${seq}`;
      store.push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    }),
    update: vi.fn(async (_table: string, id: string, data: Record<string, unknown>) => {
      const row = store.find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return { ok: true };
    }),
    delete: vi.fn(async (_table: string, id: string) => {
      const i = store.findIndex((r) => r.id === id);
      if (i >= 0) store.splice(i, 1);
      return { ok: true };
    }),
    count: vi.fn(async () => store.length),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db;
}

// jsdom lacks these canvas/SVG APIs the app touches defensively.
beforeEach(() => {
  vi.useFakeTimers();
  // pointer capture is a no-op in jsdom
  if (!(Element.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
    (Element.prototype as unknown as Record<string, unknown>).setPointerCapture = () => undefined;
    (Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = () => undefined;
  }
  // getBoundingClientRect returns zeros in jsdom by default; give the canvas a size
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "MatrixOS");
});

describe("Whiteboard app", () => {
  it("renders the toolbar with the core drawing tools", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    // Tool buttons expose accessible names via aria-label.
    expect(screen.getByRole("button", { name: "Select (V)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pen (P)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rectangle (R)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ellipse (O)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("shows an empty-state onboarding affordance when the board is blank", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("whiteboard-empty")).toBeTruthy();
  });

  it("uses unique svg definition ids for multiple instances", async () => {
    installMatrixDb([]);
    const { container } = render(
      <>
        <App />
        <App />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const gridIds = [...container.querySelectorAll("pattern")].map((node) => node.id);
    const markerIds = [...container.querySelectorAll("marker")].map((node) => node.id);
    expect(gridIds).toHaveLength(2);
    expect(markerIds).toHaveLength(2);
    expect(new Set(gridIds).size).toBe(2);
    expect(new Set(markerIds).size).toBe(2);
    expect(gridIds).not.toContain("wb-grid");
    expect(markerIds).not.toContain("wb-arrow");
  });

  it("prevents native autoscroll when starting a middle-button pan", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const canvas = screen.getByTestId("whiteboard-canvas");
    const wasNotCanceled = fireEvent.pointerDown(canvas, {
      clientX: 100,
      clientY: 100,
      button: 1,
      pointerId: 1,
    });

    expect(wasNotCanceled).toBe(false);
  });

  it("draws a rectangle which adds an element and autosaves to the DB", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    // Init: empty store -> a first board is created and opened.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Pick the rectangle tool.
    fireEvent.click(screen.getByRole("button", { name: "Rectangle (R)" }));

    const canvas = screen.getByTestId("whiteboard-canvas");
    // Drag to draw a rectangle.
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 220, clientY: 180, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 220, clientY: 180, pointerId: 1 });
      await Promise.resolve();
    });

    // One element now exists -> empty state is gone.
    expect(screen.queryByTestId("whiteboard-empty")).toBeNull();

    // Debounced autosave fires after the timer elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    // The board row is persisted through the bridge (insert on create, then
    // update for the drawn rect) — never via a raw fetch.
    const persisted = db.insert.mock.calls.length + db.update.mock.calls.length;
    expect(persisted).toBeGreaterThan(0);
    const allCalls = [...db.insert.mock.calls, ...db.update.mock.calls];
    const sawRect = allCalls.some((call) => JSON.stringify(call).includes("rect"));
    expect(sawRect).toBe(true);
  });
});

describe("Whiteboard app — multi-board files", () => {
  const board = (id: string, name: string, updatedAt: string): DbRow => ({
    id,
    name,
    doc: { version: 1, elements: [] },
    created_at: updatedAt,
    updated_at: updatedAt,
  });

  it("lists existing boards by name in the file sidebar", async () => {
    installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
      board("b2", "Wireframe", "2026-03-03T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Names render in the sidebar list (the active board's name also shows in
    // the toolbar, so use getAllByText for the active one).
    expect(screen.getByText("Sprint plan")).toBeTruthy();
    expect(screen.getAllByText("Wireframe").length).toBeGreaterThan(0);
  });

  it("creates a new board via db.insert when New board is clicked", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    db.insert.mockClear();

    const newBtn = screen.getByRole("button", { name: /new board/i });
    await act(async () => {
      fireEvent.click(newBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).toHaveBeenCalled();
    expect(db.insert.mock.calls[0][0]).toBe("scenes");
    const inserted = db.insert.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof inserted.name).toBe("string");
  });

  it("keeps rename editing open when the db update fails", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    db.update.mockRejectedValueOnce(new Error("rename failed"));
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    db.find.mockRejectedValueOnce(new Error("list failed"));
    fireEvent.click(screen.getByRole("button", { name: /rename board sprint plan/i }));
    const input = screen.getByLabelText(/rename sprint plan/i);
    fireEvent.change(input, { target: { value: "Launch plan" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm rename/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Could not rename the board.")).toBeTruthy();
    expect(screen.getByDisplayValue("Launch plan")).toBeTruthy();
    fireEvent.keyDown(screen.getByDisplayValue("Launch plan"), { key: "Escape" });
    expect(screen.getAllByText("Sprint plan").length).toBeGreaterThan(0);
    expect(screen.queryByText("Launch plan")).toBeNull();
  });

  it("loads the active board's doc when switching boards", async () => {
    const db = installMatrixDb([
      board("b1", "Empty one", "2026-02-02T00:00:00.000Z"),
    ]);
    // Give b2 a real element so we can assert its doc loads on switch.
    db.insert.mockClear();
    // Seed a second board directly in the store via insert mock semantics:
    await db.insert("scenes", {
      name: "Has a rect",
      doc: {
        version: 1,
        elements: [
          { id: "r1", kind: "rect", x: 10, y: 10, width: 40, height: 30, stroke: "#000", fill: "transparent", strokeWidth: 2 },
        ],
      },
      updated_at: "2026-04-04T00:00:00.000Z",
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Switch to the board named "Empty one" (the other one is active first since newer).
    const target = screen.getByText("Empty one");
    db.find.mockClear();
    await act(async () => {
      fireEvent.click(target);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Switching loads that board's row by id.
    const loadedById = db.find.mock.calls.some(
      ([table, opts]) =>
        table === "scenes" &&
        (opts as { where?: Record<string, unknown> } | undefined)?.where?.id === "b1",
    );
    const loadedOne = db.findOne.mock.calls.some(([table, id]) => table === "scenes" && id === "b1");
    expect(loadedById || loadedOne).toBe(true);
  });

  it("autosaves edits to the ACTIVE board's row via db.update", async () => {
    const db = installMatrixDb([
      board("active-board", "My board", "2026-05-05T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Rectangle (R)" }));
    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 200, clientY: 160, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 200, clientY: 160, pointerId: 1 });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    const updatedActive = db.update.mock.calls.some(
      ([table, id]) => table === "scenes" && id === "active-board",
    );
    expect(updatedActive).toBe(true);
  });

  it("deletes a board via db.delete after confirmation", async () => {
    const db = installMatrixDb([
      board("b1", "Keep me", "2026-02-02T00:00:00.000Z"),
      board("b2", "Delete me", "2026-03-03T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Open the delete affordance for "Delete me".
    const delBtn = screen.getByRole("button", { name: /delete board delete me/i });
    await act(async () => {
      fireEvent.click(delBtn);
      await Promise.resolve();
    });
    // Confirm in the dialog.
    const confirm = screen.getByRole("button", { name: /^delete board$/i });
    await act(async () => {
      fireEvent.click(confirm);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.delete).toHaveBeenCalledWith("scenes", "b2");
  });
});
