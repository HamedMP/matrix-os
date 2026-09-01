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

  it("auto-scrolls an ordinary xterm selection without swallowing its native pointer events", () => {
    vi.useFakeTimers();
    const { root, delivered, onExtendedSelection, scrollLines, remove } = setup({
      mouseTrackingMode: "none",
    });
    const outside = document.createElement("div");
    document.body.append(outside);
    const nativeDown = vi.fn();
    root.addEventListener("mousedown", nativeDown);

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    outside.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 20 }));
    vi.advanceTimersByTime(160);

    expect(nativeDown).toHaveBeenCalledOnce();
    expect(scrollLines.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(scrollLines.mock.calls.every(([amount]) => amount < 0)).toBe(true);
    expect(delivered).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mousemove", clientY: 20, altKey: false, shiftKey: false }),
    ]));
    expect(onExtendedSelection).not.toHaveBeenCalled();

    outside.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 130, clientY: 20 }));
    expect(delivered.at(-1)).toEqual(expect.objectContaining({ type: "mouseup", altKey: false }));
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
    expect(mergeTerminalEdgeSelectionLines(["c", "d", "e"], ["a", "b", "c", "d"], "up"))
      .toEqual(["a", "b", "c", "d", "e"]);
    expect(mergeTerminalEdgeSelectionLines(["a", "b", "c"], ["b", "c", "d", "e"], "down"))
      .toEqual(["a", "b", "c", "d", "e"]);
  });

  it("caps retained viewport rows while preserving the selection anchor", () => {
    const lines = Array.from({ length: 5_001 }, (_, index) => `line-${index}`);

    expect(mergeTerminalEdgeSelectionLines(["anchor"], lines, "up")).toHaveLength(5_000);
    expect(mergeTerminalEdgeSelectionLines(["anchor"], lines, "up").at(-1)).toBe("anchor");
    expect(mergeTerminalEdgeSelectionLines(["anchor"], lines, "down")).toHaveLength(5_000);
    expect(mergeTerminalEdgeSelectionLines(["anchor"], lines, "down").at(0)).toBe("anchor");
  });
});
