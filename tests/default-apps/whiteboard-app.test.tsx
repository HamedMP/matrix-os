// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/whiteboard/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "scene-new" })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => rows.length),
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

  it("draws a rectangle which adds an element and autosaves to the DB", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    await act(async () => {
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

    // Either insert (first save) or update is called with a serialized scene.
    const persisted = db.insert.mock.calls.length + db.update.mock.calls.length;
    expect(persisted).toBeGreaterThan(0);
    const saveCall = db.insert.mock.calls[0] ?? db.update.mock.calls[0];
    const payload = JSON.stringify(saveCall);
    expect(payload).toContain("rect");
  });
});
