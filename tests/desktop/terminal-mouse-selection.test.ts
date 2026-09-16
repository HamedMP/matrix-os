// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMouseTrackingSelection } from "@desktop/renderer/src/features/terminal/terminal-mouse-selection";
import { mergeTerminalEdgeSelectionLines } from "@desktop/renderer/src/features/terminal/terminal-mouse-selection";

type DeliveredMouse = Pick<
  MouseEvent,
  "type" | "clientX" | "clientY" | "button" | "buttons" | "altKey" | "shiftKey" | "detail"
> & { corrected: boolean };

function mouse(type: string, init: MouseEventInit): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
}

function setup({
  isMac = true,
  mouseTrackingMode = "any",
  visualScale = 1,
}: {
  isMac?: boolean;
  mouseTrackingMode?: string;
  visualScale?: number;
} = {}) {
  const host = document.createElement("div");
  const root = document.createElement("div");
  host.append(root);
  document.body.append(host);
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 50,
    right: 500,
    bottom: 250,
    width: 400,
    height: 200,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  });
  const delivered: DeliveredMouse[] = [];
  for (const type of ["mousedown", "mousemove", "mouseup"] as const) {
    root.addEventListener(type, (event) => {
      if (!(event as MouseEvent & { _xtermScaleCorrected?: boolean })._xtermScaleCorrected) return;
      delivered.push({
        type: event.type,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
        buttons: event.buttons,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        detail: event.detail,
        corrected: true,
      });
    });
  }
  const onPrimaryGestureStart = vi.fn();
  const activeBuffer = { viewportY: 100 };
  const scrollLines = vi.fn((amount: number) => {
    activeBuffer.viewportY = Math.max(0, activeBuffer.viewportY + amount);
  });
  const select = vi.fn();
  const selectLines = vi.fn();
  const onExtendedSelection = vi.fn();
  const wheelEvents: WheelEvent[] = [];
  root.addEventListener("wheel", (event) => wheelEvents.push(event));
  const remove = installMouseTrackingSelection({
    host,
    getTerminal: () => ({
      modes: { mouseTrackingMode },
      element: root,
      cols: 100,
      rows: 20,
      buffer: {
        active: {
          ...activeBuffer,
          getLine: (index: number) => ({ translateToString: () => `line-${index}` }),
        },
      },
      getSelectionPosition: () => ({
        start: { x: 6, y: 101 },
        end: { x: 6, y: 120 },
      }),
      select,
      selectLines,
      scrollLines,
    }),
    getVisualScale: () => visualScale,
    isMac,
    onPrimaryGestureStart,
    onExtendedSelection,
  });
  return {
    host,
    root,
    delivered,
    onPrimaryGestureStart,
    onExtendedSelection,
    scrollLines,
    select,
    selectLines,
    wheelEvents,
    remove,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("mouse-reporting terminal selection", () => {
  it("turns a primary drag into an Option-forced xterm selection on macOS", () => {
    const { root, delivered, onPrimaryGestureStart, remove } = setup();

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    expect(delivered).toEqual([]);
    root.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 90 }));
    root.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 140, clientY: 100 }));

    expect(onPrimaryGestureStart).toHaveBeenCalledOnce();
    expect(delivered).toEqual([
      expect.objectContaining({ type: "mousedown", altKey: true, shiftKey: false, buttons: 1 }),
      expect.objectContaining({ type: "mousemove", altKey: true, shiftKey: false, buttons: 1 }),
      expect.objectContaining({ type: "mouseup", altKey: true, shiftKey: false, buttons: 0 }),
    ]);
    remove();
  });

  it("replays a primary click without a selection modifier so the TUI still receives it", () => {
    const { root, delivered, remove } = setup();

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    root.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 121, clientY: 81 }));

    expect(delivered).toEqual([
      expect.objectContaining({ type: "mousedown", altKey: false, shiftKey: false, buttons: 1 }),
      expect.objectContaining({ type: "mouseup", altKey: false, shiftKey: false, buttons: 0 }),
    ]);
    remove();
  });

  it("forces a double click into xterm word selection instead of reporting its second click", () => {
    const { root, delivered, remove } = setup();

    root.dispatchEvent(mouse("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 80,
      detail: 1,
    }));
    root.dispatchEvent(mouse("mouseup", {
      button: 0,
      buttons: 0,
      clientX: 120,
      clientY: 80,
      detail: 1,
    }));
    root.dispatchEvent(mouse("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 80,
      detail: 2,
    }));
    root.dispatchEvent(mouse("mouseup", {
      button: 0,
      buttons: 0,
      clientX: 120,
      clientY: 80,
      detail: 2,
    }));

    expect(delivered).toEqual([
      expect.objectContaining({ type: "mousedown", altKey: false, detail: 1 }),
      expect.objectContaining({ type: "mouseup", altKey: false, detail: 1 }),
      expect.objectContaining({ type: "mousedown", altKey: true, detail: 2 }),
      expect.objectContaining({ type: "mouseup", altKey: true, detail: 2 }),
    ]);
    remove();
  });

  it("uses Shift to force selection outside macOS and corrects Canvas-scaled coordinates", () => {
    const { root, delivered, remove } = setup({ isMac: false, visualScale: 0.5 });

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80, detail: 2 }));
    root.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 90 }));
    root.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 140, clientY: 100, detail: 2 }));

    expect(delivered[0]).toMatchObject({
      type: "mousedown",
      clientX: 140,
      clientY: 110,
      altKey: false,
      shiftKey: true,
    });
    expect(delivered[2]).toMatchObject({
      type: "mouseup",
      clientX: 180,
      clientY: 150,
      shiftKey: true,
    });
    remove();
  });

  it("keeps forced drag events targeted at xterm after the pointer leaves the terminal", () => {
    const { root, delivered, remove } = setup();
    const outside = document.createElement("div");
    document.body.append(outside);

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    outside.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 30 }));
    outside.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 130, clientY: 30 }));

    expect(delivered).toEqual([
      expect.objectContaining({ type: "mousedown", altKey: true }),
      expect.objectContaining({ type: "mousemove", clientY: 30, altKey: true }),
      expect.objectContaining({ type: "mouseup", clientY: 30, altKey: true }),
    ]);
    remove();
  });

  it("repeats an unmodified held event so the mouse-reporting app scrolls its selection", () => {
    vi.useFakeTimers();
    const {
      root,
      delivered,
      onExtendedSelection,
      scrollLines,
      wheelEvents,
      selectLines,
      remove,
    } = setup();
    const outside = document.createElement("div");
    document.body.append(outside);

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    outside.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 20 }));
    vi.advanceTimersByTime(160);
    expect(scrollLines.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(scrollLines.mock.calls.every(([amount]) => amount < 0)).toBe(true);
    expect(delivered.filter(({ type }) => type === "mousemove").length).toBeGreaterThanOrEqual(3);
    expect(wheelEvents.length).toBeGreaterThanOrEqual(3);
    expect(wheelEvents.every(({ deltaY }) => deltaY < 0)).toBe(true);
    expect(selectLines).toHaveBeenCalled();
    expect(onExtendedSelection).toHaveBeenCalled();
    expect(onExtendedSelection.mock.calls[0]?.[0]).toMatch(/line-100[\s\S]*\nline-1$/);

    outside.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 290 }));
    delivered.length = 0;
    scrollLines.mockClear();
    vi.advanceTimersByTime(160);
    expect(delivered.filter(({ type }) => type === "mousemove").length).toBeGreaterThanOrEqual(3);
    expect(wheelEvents.some(({ deltaY }) => deltaY > 0)).toBe(true);
    expect(scrollLines.mock.calls.every(([amount]) => amount > 0)).toBe(true);

    outside.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 130, clientY: 290 }));
    scrollLines.mockClear();
    vi.advanceTimersByTime(160);
    expect(scrollLines).not.toHaveBeenCalled();
    remove();
  });

  it("captures complete rows while auto-scrolling an ordinary xterm selection", () => {
    vi.useFakeTimers();
    const { root, delivered, onExtendedSelection, scrollLines, remove } = setup({
      mouseTrackingMode: "none",
    });
    const outside = document.createElement("div");
    document.body.append(outside);
    const nativeDown = vi.fn();
    root.addEventListener("mousedown", nativeDown);

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    outside.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 290 }));
    vi.advanceTimersByTime(160);

    expect(nativeDown).toHaveBeenCalledOnce();
    expect(scrollLines.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(scrollLines.mock.calls.every(([amount]) => amount > 0)).toBe(true);
    expect(delivered).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mousemove", clientY: 290, altKey: false, shiftKey: false }),
    ]));

    outside.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 130, clientY: 290 }));
    expect(delivered.at(-1)).toEqual(expect.objectContaining({ type: "mouseup", altKey: false }));
    expect(onExtendedSelection.mock.calls.at(-1)?.[0]).toMatch(/^103\nline-104[\s\S]*\nline-127$/);
    remove();
  });

  it.each(["none", "any"])("captures the anchor before xterm scrolls between edge entry and the first timer tick (%s)", (mouseTrackingMode) => {
    vi.useFakeTimers();
    const { root, scrollLines, onExtendedSelection, remove } = setup({ mouseTrackingMode });
    try {
      root.dispatchEvent(mouse("mousedown", {
        button: 0, buttons: 1, clientX: 120, clientY: 65,
      }));
      root.dispatchEvent(mouse("mousemove", {
        button: 0, buttons: 1, clientX: 120, clientY: 290,
      }));
      // xterm has its own drag-scroll timer, independent of our capture timer.
      scrollLines(2);
      vi.advanceTimersByTime(40);
      const selected = onExtendedSelection.mock.calls.at(-1)?.[0] as string;
      expect(selected).toContain("line-102");
      expect(selected).toContain("line-121");
    } finally {
      remove();
    }
  });

  it("releases the captured edge range when an ordinary drag returns inside", () => {
    vi.useFakeTimers();
    const { root, onExtendedSelection, remove } = setup({
      mouseTrackingMode: "none",
    });
    const outside = document.createElement("div");
    document.body.append(outside);

    root.dispatchEvent(mouse("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 80,
    }));
    outside.dispatchEvent(mouse("mousemove", {
      button: 0,
      buttons: 1,
      clientX: 130,
      clientY: 290,
    }));
    vi.advanceTimersByTime(80);
    expect(onExtendedSelection.mock.calls.at(-1)?.[0]).not.toBe("");

    root.dispatchEvent(mouse("mousemove", {
      button: 0,
      buttons: 1,
      clientX: 130,
      clientY: 100,
    }));
    root.dispatchEvent(mouse("mouseup", {
      button: 0,
      buttons: 0,
      clientX: 130,
      clientY: 100,
    }));

    expect(onExtendedSelection.mock.calls.at(-1)?.[0]).toBe("");
    remove();
  });

  it("replaces unscaled document events while an ordinary scaled selection leaves the terminal", () => {
    const { root, delivered, remove } = setup({
      mouseTrackingMode: "none",
      visualScale: 0.5,
    });
    const outside = document.createElement("div");
    document.body.append(outside);

    root.dispatchEvent(mouse("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 80,
    }));
    const outsideMove = mouse("mousemove", {
      button: 0,
      buttons: 1,
      clientX: 130,
      clientY: 20,
    });
    const outsideUp = mouse("mouseup", {
      button: 0,
      buttons: 0,
      clientX: 130,
      clientY: 20,
    });
    outside.dispatchEvent(outsideMove);
    outside.dispatchEvent(outsideUp);

    expect(delivered).toEqual([
      expect.objectContaining({ type: "mousemove", clientX: 100, clientY: -10 }),
      expect.objectContaining({ type: "mouseup", clientX: 100, clientY: -10 }),
    ]);
    expect(outsideMove.defaultPrevented).toBe(true);
    expect(outsideUp.defaultPrevented).toBe(true);

    delivered.length = 0;
    root.dispatchEvent(mouse("mousedown", {
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 80,
    }));
    outside.dispatchEvent(mouse("mousemove", {
      button: 0,
      buttons: 1,
      clientX: 130,
      clientY: 290,
    }));
    outside.dispatchEvent(mouse("mouseup", {
      button: 0,
      buttons: 0,
      clientX: 130,
      clientY: 290,
    }));
    expect(delivered).toEqual([
      expect.objectContaining({ type: "mousemove", clientX: 900, clientY: 530 }),
      expect.objectContaining({ type: "mouseup", clientX: 900, clientY: 530 }),
    ]);
    remove();
  });

  it("leaves primary pointer events untouched when mouse reporting is disabled", () => {
    const { root, delivered, onPrimaryGestureStart, remove } = setup({ mouseTrackingMode: "none" });
    const observed = vi.fn();
    root.addEventListener("mousedown", observed);

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));

    expect(observed).toHaveBeenCalledOnce();
    expect(onPrimaryGestureStart).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    remove();
  });
});

describe("edge selection viewport merging", () => {
  it("prepends and appends only newly revealed rows", () => {
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 2, lines: ["c", "d", "e"] },
      { startRow: 0, lines: ["a", "b", "c", "d"] },
      "up",
    )).toEqual({ startRow: 0, lines: ["a", "b", "c", "d", "e"] });
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 0, lines: ["a", "b", "c"] },
      { startRow: 1, lines: ["b", "c", "d", "e"] },
      "down",
    )).toEqual({ startRow: 0, lines: ["a", "b", "c", "d", "e"] });
  });

  it("preserves distinct rows when adjacent viewport content is identical", () => {
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 100, lines: ["same", "same"] },
      { startRow: 98, lines: ["same", "same", "same"] },
      "up",
    )).toEqual({ startRow: 98, lines: ["same", "same", "same", "same"] });
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 98, lines: ["same", "same"] },
      { startRow: 99, lines: ["same", "same", "same"] },
      "down",
    )).toEqual({ startRow: 98, lines: ["same", "same", "same", "same"] });
  });

  it("uses the delivered wheel step when a TUI redraws rows in place", () => {
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 100, lines: ["anchor"] },
      { startRow: 100, lines: ["new", "same", "same"] },
      "up",
      1,
      { startRow: 100, lines: ["same", "same", "old"] },
    )).toEqual({ startRow: 99, lines: ["new", "anchor"] });
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 100, lines: ["anchor"] },
      { startRow: 100, lines: ["same", "same", "new"] },
      "down",
      1,
      { startRow: 100, lines: ["old", "same", "same"] },
    )).toEqual({ startRow: 100, lines: ["anchor", "new"] });
  });

  it("does not duplicate a TUI viewport that has not redrawn yet", () => {
    const viewport = { startRow: 100, lines: ["same", "same", "same"] };
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 98, lines: ["same", "same", "anchor"] },
      viewport,
      "up",
      2,
      viewport,
    )).toEqual({ startRow: 98, lines: ["same", "same", "anchor"] });
  });

  it("does not treat an empty overlap as a full-viewport shift", () => {
    expect(mergeTerminalEdgeSelectionLines(
      { startRow: 100, lines: ["anchor"] },
      { startRow: 100, lines: ["new-a", "new-b", "new-c"] },
      "up",
      1,
      { startRow: 100, lines: ["old-a", "old-b", "old-c"] },
    )).toEqual({ startRow: 99, lines: ["new-a", "anchor"] });
  });

  it("caps retained viewport rows while preserving the selection anchor", () => {
    const lines = Array.from({ length: 5_001 }, (_, index) => `line-${index}`);

    const upward = mergeTerminalEdgeSelectionLines(
      { startRow: 5_001, lines: ["anchor"] },
      { startRow: 0, lines },
      "up",
    );
    expect(upward.lines).toHaveLength(5_000);
    expect(upward.lines.at(-1)).toBe("anchor");
    expect(upward.startRow).toBe(2);

    const downward = mergeTerminalEdgeSelectionLines(
      { startRow: 0, lines: ["anchor"] },
      { startRow: 1, lines },
      "down",
    );
    expect(downward.lines).toHaveLength(5_000);
    expect(downward.lines.at(0)).toBe("anchor");
    expect(downward.startRow).toBe(0);
  });
});
