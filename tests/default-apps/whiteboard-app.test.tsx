// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/whiteboard/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  // Mutable backing store so insert/update/delete + find reflect each other,
  // and find() can be filtered/sorted like the bridge calls the app relies on.
  const store: DbRow[] = rows.map((r) => ({ ...r }));
  let seq = 0;
  let onChangeHandler: (() => void) | null = null;
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
    onChange: vi.fn((_table: string, callback: () => void) => {
      onChangeHandler = callback;
      return () => {
        onChangeHandler = null;
      };
    }),
    emitChange: () => {
      onChangeHandler?.();
    },
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

  it("does not switch drawing tools for browser modifier shortcuts", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    const select = screen.getByRole("button", { name: "Select (V)" });
    const pen = screen.getByRole("button", { name: "Pen (P)" });
    expect(select.getAttribute("aria-pressed")).toBe("true");

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(select.getAttribute("aria-pressed")).toBe("true");
    expect(pen.getAttribute("aria-pressed")).toBe("false");

    fireEvent.keyDown(window, { key: "p" });
    expect(pen.getAttribute("aria-pressed")).toBe("true");
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

  it("discards in-progress rectangles when the pointer is canceled", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Rectangle (R)" }));

    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 220, clientY: 180, pointerId: 1 });
      fireEvent.pointerCancel(canvas, { clientX: 220, clientY: 180, pointerId: 1 });
      await Promise.resolve();
    });

    expect(screen.getByTestId("whiteboard-empty")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select (V)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Rectangle (R)" }).getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    const allCalls = [...db.insert.mock.calls, ...db.update.mock.calls];
    const sawRect = allCalls.some((call) => JSON.stringify(call).includes("rect"));
    expect(sawRect).toBe(false);
  });

  it("matches the text editor font metrics to rendered text", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Text (T)" }));
    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 120, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      await Promise.resolve();
    });

    const editor = screen.getByLabelText("Edit text") as HTMLTextAreaElement;
    expect(editor.style.fontSize).toBe("22px");
    expect(editor.style.lineHeight).toBe("1.35");
  });

  it("does not commit cancelled text edits when Escape is followed by blur", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Text (T)" }));
    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 120, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      await Promise.resolve();
    });

    const editor = screen.getByLabelText("Edit text") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Draft text" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.blur(editor);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(JSON.stringify(db.update.mock.calls)).not.toContain("Draft text");
    expect(screen.queryByLabelText("Edit text")).toBeNull();
  });

  it("does not add a duplicate undo entry when a committed text edit blurs after unmount", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Text (T)" }));
    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 120, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      await Promise.resolve();
    });

    const editor = screen.getByLabelText("Edit text") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Committed text" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    fireEvent.blur(editor);

    expect(screen.getByText("Committed text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.queryByText("Committed text")).toBeNull();
  });

  it("reopens placed text for editing and commits a second edit", async () => {
    installMatrixDb([]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Text (T)" }));
    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 120, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      await Promise.resolve();
    });

    const editor = screen.getByLabelText("Edit text") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Initial text" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });

    fireEvent.doubleClick(screen.getByText("Initial text"));
    const reopened = screen.getByLabelText("Edit text") as HTMLTextAreaElement;
    expect(reopened.value).toBe("Initial text");
    fireEvent.change(reopened, { target: { value: "Revised text" } });
    fireEvent.keyDown(reopened, { key: "Enter", metaKey: true });

    expect(screen.getByText("Revised text")).toBeTruthy();
    expect(screen.queryByText("Initial text")).toBeNull();
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

  it("scrolls the active board into view after selection", async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
      board("b2", "Wireframe", "2026-03-03T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    scrollIntoView.mockClear();

    const sprintButton = screen.getByText("Sprint plan").closest("button");
    if (!sprintButton) throw new Error("Expected Sprint plan board button");
    fireEvent.click(sprintButton);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
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

  it("reserves generated board names during rapid consecutive creates", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    const resolvers: Array<() => void> = [];
    db.insert.mockImplementation(async (_table: string, data: Record<string, unknown>) => {
      const id = `scene-new-${resolvers.length + 1}`;
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return { id, ...data };
    });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    db.insert.mockClear();

    const newBtn = screen.getByRole("button", { name: /new board/i });
    fireEvent.click(newBtn);
    fireEvent.click(newBtn);

    expect(db.insert).toHaveBeenNthCalledWith(1, "scenes", expect.objectContaining({ name: "Untitled board" }));
    expect(db.insert).toHaveBeenNthCalledWith(2, "scenes", expect.objectContaining({ name: "Untitled board 2" }));

    await act(async () => {
      for (const resolve of resolvers) resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("recovers the initial loading state when first board creation fails", async () => {
    const db = installMatrixDb([]);
    db.insert.mockRejectedValueOnce(new Error("create failed"));
    render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Could not create a board.")).toBeTruthy();
    expect(screen.getByTestId("whiteboard-empty")).toBeTruthy();
  });

  it("does not create a first board when loading the board index fails", async () => {
    const db = installMatrixDb([]);
    db.find.mockRejectedValueOnce(new Error("list failed"));
    render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Could not load your boards.")).toBeTruthy();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("reports a create failure when the bridge insert omits the new board id", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    db.insert.mockResolvedValueOnce({} as { id: string });
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /new board/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Could not create a board.")).toBeTruthy();
  });

  it("keeps rename editing open when the db update fails", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    db.update.mockRejectedValueOnce(new Error("rename failed"));
    render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
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

  it("clears a failed rename editor when switching boards", async () => {
    const db = installMatrixDb([
      board("board-a", "Board A", "2026-04-04T00:00:00.000Z"),
      board("board-b", "Board B", "2026-02-02T00:00:00.000Z"),
    ]);
    db.update.mockRejectedValueOnce(new Error("rename failed"));
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /rename board board a/i }));
    const input = screen.getByLabelText(/rename board a/i);
    fireEvent.change(input, { target: { value: "Renamed A" } });
    await act(async () => {
      fireEvent.blur(input);
      fireEvent.click(screen.getByText("Board B"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith("scenes", "board-a", expect.objectContaining({ name: "Renamed A" }));
    expect(screen.queryByDisplayValue("Renamed A")).toBeNull();
    expect(screen.getAllByText("Board B").length).toBeGreaterThan(0);
  });

  it("does not commit a cancelled board rename when Escape is followed by blur", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /rename board sprint plan/i }));
    const input = screen.getByLabelText(/rename sprint plan/i);
    fireEvent.change(input, { target: { value: "Launch plan" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
    });

    expect(db.update).not.toHaveBeenCalledWith("scenes", "b1", expect.objectContaining({ name: "Launch plan" }));
    expect(screen.getAllByText("Sprint plan").length).toBeGreaterThan(0);
    expect(screen.queryByText("Launch plan")).toBeNull();
  });

  it("does not commit a board rename twice when Enter is followed by blur", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /rename board sprint plan/i }));
    const input = screen.getByLabelText(/rename sprint plan/i);
    fireEvent.change(input, { target: { value: "Launch plan" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const renameCalls = db.update.mock.calls.filter(
      ([table, id, data]) => table === "scenes" && id === "b1" && data.name === "Launch plan",
    );
    expect(renameCalls).toHaveLength(1);
  });

  it("clears the rename error after a recovery refresh succeeds", async () => {
    const db = installMatrixDb([
      board("b1", "Sprint plan", "2026-02-02T00:00:00.000Z"),
    ]);
    db.update.mockRejectedValueOnce(new Error("rename failed"));
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /rename board sprint plan/i }));
    const input = screen.getByLabelText(/rename sprint plan/i);
    fireEvent.change(input, { target: { value: "Launch plan" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm rename/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Could not rename the board.")).toBeNull();
    expect(screen.getAllByText("Sprint plan").length).toBeGreaterThan(0);
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

  it("fills ellipses when exporting PNGs", async () => {
    installMatrixDb([
      {
        ...board("b1", "Sketch", "2026-02-02T00:00:00.000Z"),
        doc: {
          version: 1,
          elements: [
            { id: "e1", kind: "ellipse", x: 20, y: 30, width: 80, height: 50, stroke: "#000", fill: "#F87171", strokeWidth: 2 },
          ],
        },
      },
    ]);
    const ctx = {
      beginPath: vi.fn(),
      ellipse: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn(),
      set fillStyle(_value: string) {},
      set lineCap(_value: string) {},
      set lineJoin(_value: string) {},
      set lineWidth(_value: number) {},
      set strokeStyle(_value: string) {},
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,stub");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTitle("Export PNG"));

    expect(ctx.ellipse).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("fills arrowheads when exporting PNGs", async () => {
    installMatrixDb([
      {
        ...board("b1", "Sketch", "2026-02-02T00:00:00.000Z"),
        doc: {
          version: 1,
          elements: [
            { id: "a1", kind: "arrow", x1: 20, y1: 30, x2: 100, y2: 90, stroke: "#000", strokeWidth: 2 },
          ],
        },
      },
    ]);
    const ctx = {
      beginPath: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn(),
      set fillStyle(_value: string) {},
      set lineCap(_value: string) {},
      set lineJoin(_value: string) {},
      set lineWidth(_value: number) {},
      set strokeStyle(_value: string) {},
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,stub");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTitle("Export PNG"));

    expect(ctx.closePath).toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalled();
  });

  it("preserves explicit text newlines when exporting PNGs", async () => {
    installMatrixDb([
      {
        ...board("b1", "Sketch", "2026-02-02T00:00:00.000Z"),
        doc: {
          version: 1,
          elements: [
            { id: "t1", kind: "text", x: 40, y: 50, width: 200, height: 80, stroke: "#111", fill: "transparent", strokeWidth: 1, text: "First line\nSecond line" },
          ],
        },
      },
    ]);
    const ctx = {
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn((value: string) => ({ width: value.length * 8 })),
      translate: vi.fn(),
      set fillStyle(_value: string) {},
      set font(_value: string) {},
      set lineCap(_value: string) {},
      set lineJoin(_value: string) {},
      set lineWidth(_value: number) {},
      set strokeStyle(_value: string) {},
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,stub");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTitle("Export PNG"));

    expect(ctx.fillText).toHaveBeenCalledWith("First line", 40, 70);
    expect(ctx.fillText).toHaveBeenCalledWith("Second line", 40, 92);
  });

  it("does not reset the active canvas selection for table-wide change notifications", async () => {
    const db = installMatrixDb([
      {
        id: "b1",
        name: "Sketch",
        doc: {
          version: 1,
          elements: [
            { id: "r1", kind: "rect", x: 10, y: 10, width: 80, height: 50, stroke: "#000", fill: "transparent", strokeWidth: 2 },
          ],
        },
        created_at: "2026-02-02T00:00:00.000Z",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, button: 0, pointerId: 1 });
      await Promise.resolve();
    });
    expect(document.querySelector(".wb-el--selected")).toBeTruthy();

    db.find.mockClear();
    await act(async () => {
      db.emitChange();
      await Promise.resolve();
    });

    expect(document.querySelector(".wb-el--selected")).toBeTruthy();
    expect(db.find.mock.calls.some(
      ([table, opts]) =>
        table === "scenes" &&
        (opts as { where?: Record<string, unknown> } | undefined)?.where?.id === "b1",
    )).toBe(false);
  });

  it("clears a flushed save indicator when switching boards", async () => {
    const db = installMatrixDb([
      board("old-board", "Old board", "2026-02-02T00:00:00.000Z"),
      board("new-board", "New board", "2026-04-04T00:00:00.000Z"),
    ]);
    db.update.mockImplementationOnce(async () => new Promise(() => undefined));
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
      fireEvent.click(screen.getByText("Old board"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Saving…")).toBeNull();
  });

  it("does not save a blurred text editor to the next board during switch", async () => {
    const db = installMatrixDb([
      board("board-a", "Board A", "2026-04-04T00:00:00.000Z"),
      board("board-b", "Board B", "2026-02-02T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Text (T)" }));
    const canvas = screen.getByTestId("whiteboard-canvas");
    await act(async () => {
      fireEvent.pointerDown(canvas, { clientX: 120, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerMove(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(canvas, { clientX: 260, clientY: 150, pointerId: 1 });
      await Promise.resolve();
    });

    const editor = screen.getByLabelText("Edit text") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Hello from A" } });
    db.update.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByText("Board B"));
      fireEvent.blur(editor);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    const corruptedB = db.update.mock.calls.some(
      ([table, id, data]) =>
        table === "scenes" &&
        id === "board-b" &&
        JSON.stringify((data as Record<string, unknown>).doc).includes("Hello from A"),
    );
    const savedA = db.update.mock.calls.some(
      ([table, id, data]) =>
        table === "scenes" &&
        id === "board-a" &&
        JSON.stringify((data as Record<string, unknown>).doc).includes("Hello from A"),
    );
    expect(corruptedB).toBe(false);
    expect(savedA).toBe(true);
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

  it("keeps delete confirmation open when deleting a board fails", async () => {
    const db = installMatrixDb([
      board("b1", "Keep me", "2026-02-02T00:00:00.000Z"),
      board("b2", "Delete me", "2026-03-03T00:00:00.000Z"),
    ]);
    db.delete.mockRejectedValueOnce(new Error("delete failed"));
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /delete board delete me/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete board$/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Could not delete the board.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: /delete board/i })).toBeTruthy();
  });

  it("traps keyboard focus inside delete confirmation", async () => {
    installMatrixDb([
      board("b1", "Keep me", "2026-02-02T00:00:00.000Z"),
      board("b2", "Delete me", "2026-03-03T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /delete board delete me/i }));
    const dialog = screen.getByRole("dialog", { name: /delete board/i });
    const cancel = within(dialog).getByRole("button", { name: /cancel/i });
    const confirm = within(dialog).getByRole("button", { name: /^delete board$/i });

    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("dismisses delete confirmation with Escape", async () => {
    installMatrixDb([
      board("b1", "Keep me", "2026-02-02T00:00:00.000Z"),
      board("b2", "Delete me", "2026-03-03T00:00:00.000Z"),
    ]);
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /delete board delete me/i }));
    expect(screen.getByRole("dialog", { name: /delete board/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: /delete board/i })).toBeNull();
  });
});
