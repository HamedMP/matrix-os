// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  installTerminalPointerInterception,
  markTerminalZoomCorrected,
} from "../../shell/src/components/terminal/terminal-pointer-interception.js";

describe("terminal pointer interception", () => {
  it("shields passive pointer input while a terminal selection exists", () => {
    const container = document.createElement("div");
    const correctPointer = vi.fn();
    const remove = installTerminalPointerInterception({
      container,
      getTerminal: () => ({ hasSelection: () => true }),
      getVisualScale: () => 0.5,
      correctPointer,
    });
    const event = new MouseEvent("mousemove", { bubbles: true, cancelable: true, buttons: 0 });
    const stopImmediatePropagation = vi.spyOn(event, "stopImmediatePropagation");

    container.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(correctPointer).not.toHaveBeenCalled();
    remove();
  });

  it("delegates deliberate primary input to zoom correction", () => {
    const container = document.createElement("div");
    const correctPointer = vi.fn();
    const remove = installTerminalPointerInterception({
      container,
      getTerminal: () => ({ hasSelection: () => true }),
      getVisualScale: () => 0.5,
      correctPointer,
    });
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
    });

    container.dispatchEvent(event);

    expect(correctPointer).toHaveBeenCalledOnce();
    expect(correctPointer).toHaveBeenCalledWith(event);
    remove();
  });

  it("ignores already-corrected events and removes every listener on cleanup", () => {
    const container = document.createElement("div");
    const correctPointer = vi.fn();
    const remove = installTerminalPointerInterception({
      container,
      getTerminal: () => null,
      getVisualScale: () => 0.5,
      correctPointer,
    });
    const corrected = new MouseEvent("mouseup", { bubbles: true, cancelable: true });
    markTerminalZoomCorrected(corrected);

    container.dispatchEvent(corrected);
    expect(correctPointer).not.toHaveBeenCalled();

    remove();
    container.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    expect(correctPointer).not.toHaveBeenCalled();
  });
});
