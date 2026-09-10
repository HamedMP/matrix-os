// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeWindowBounds, WindowResizeControls } from "../../packages/ui/src/window/WindowResizeControls";

afterEach(cleanup);
const bounds = { x: 100, y: 100, width: 600, height: 400 };
const minimum = { width: 320, height: 200 };
describe("window resizing", () => {
  it("exposes named resize separators for every edge and corner", () => {
    const view = render(<WindowResizeControls bounds={bounds} minimum={minimum} onBoundsChange={() => {}} />);
    for (const edge of ["top", "bottom", "left", "right", "top left", "top right", "bottom left", "bottom right"]) {
      expect(view.getByRole("separator", { name: `Resize ${edge}` })).toBeTruthy();
    }
    expect(view.getByRole("separator", { name: "Resize left" }).getAttribute("aria-orientation")).toBe("vertical");
    expect(view.getByRole("separator", { name: "Resize top" }).getAttribute("aria-orientation")).toBe("horizontal");
  });
  it.each([
    ["n", { x: 100, y: 120, width: 600, height: 380 }],
    ["s", { x: 100, y: 100, width: 600, height: 420 }],
    ["w", { x: 140, y: 100, width: 560, height: 400 }],
    ["e", { x: 100, y: 100, width: 640, height: 400 }],
    ["nw", { x: 140, y: 120, width: 560, height: 380 }],
    ["ne", { x: 100, y: 120, width: 640, height: 380 }],
    ["sw", { x: 140, y: 100, width: 560, height: 420 }],
    ["se", { x: 100, y: 100, width: 640, height: 420 }],
  ] as const)("resizes %s while anchoring the opposite edges", (direction, expected) => {
    expect(resizeWindowBounds(bounds, direction, 40, 20, minimum)).toEqual(expected);
  });
  it("anchors the far corner when the minimum is reached", () => {
    expect(resizeWindowBounds(bounds, "nw", 999, 999, minimum)).toEqual({ x: 380, y: 300, ...minimum });
  });
  it.each(["blur", "lostpointercapture", "unmount"])("cleans up an interrupted resize on %s", (end) => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const changed = vi.fn();
    const interaction = vi.fn();
    const { container, unmount } = render(<WindowResizeControls bounds={bounds} minimum={minimum}
      onBoundsChange={changed} onInteractionChange={interaction} />);
    const handle = container.querySelector<HTMLElement>('[data-window-resize="w"]')!;
    fireEvent.pointerDown(handle, { button: 2 });
    expect(interaction).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    if (end === "unmount") unmount();
    else if (end === "blur") fireEvent.blur(window);
    else fireEvent(handle, new MouseEvent("lostpointercapture"));
    expect(interaction).toHaveBeenLastCalledWith(false);
    fireEvent.pointerMove(window, { clientX: 150, clientY: 150 });
    expect(changed).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("captures the handle, accounts for zoom, and ends on cancellation", () => {
    // jsdom does not implement PointerEvent.
    vi.stubGlobal("PointerEvent", MouseEvent);
    const onBoundsChange = vi.fn();
    const onInteractionChange = vi.fn();
    const { container, unmount } = render(<WindowResizeControls bounds={bounds} minimum={minimum} scale={0.5} onBoundsChange={onBoundsChange} onInteractionChange={onInteractionChange} />);
    expect(container.querySelectorAll("[data-window-resize]")).toHaveLength(8);
    const handle = container.querySelector<HTMLElement>('[data-window-resize="nw"]')!;
    expect(handle.style.cursor).toBe("nw-resize");
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    expect(handle.setPointerCapture).toHaveBeenCalled();
    fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 140, y: 120, width: 560, height: 380 });
    fireEvent.pointerCancel(window);
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);
    fireEvent.pointerMove(window, { clientX: 150, clientY: 150 });
    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    unmount();
    vi.unstubAllGlobals();
  });
});
