// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMouseTrackingSelection } from "@desktop/renderer/src/features/terminal/terminal-mouse-selection";

type DeliveredMouse = Pick<
  MouseEvent,
  "type" | "clientX" | "clientY" | "button" | "buttons" | "altKey" | "shiftKey"
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
        corrected: true,
      });
    });
  }
  const onPrimaryGestureStart = vi.fn();
  const remove = installMouseTrackingSelection({
    host,
    getTerminal: () => ({ modes: { mouseTrackingMode }, element: root }),
    getVisualScale: () => visualScale,
    isMac,
    onPrimaryGestureStart,
  });
  return { host, root, delivered, onPrimaryGestureStart, remove };
}

afterEach(() => {
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

  it("uses Shift to force selection outside macOS and corrects Canvas-scaled coordinates", () => {
    const { root, delivered, remove } = setup({ isMac: false, visualScale: 0.5 });

    root.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1, clientX: 120, clientY: 80 }));
    root.dispatchEvent(mouse("mousemove", { button: 0, buttons: 1, clientX: 130, clientY: 90 }));
    root.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0, clientX: 140, clientY: 100 }));

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
