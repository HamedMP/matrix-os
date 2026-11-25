// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchLeave } from "../../../home/apps/_shared/office-ui/leave-guard";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("watchLeave", () => {
  it("saves when the window loses focus, is hidden or is torn down", () => {
    const flush = vi.fn();
    stop = watchLeave(window, { flush, dirty: () => true });
    window.dispatchEvent(new Event("blur"));
    setVisibility("hidden");
    window.dispatchEvent(new Event("pagehide"));
    expect(flush).toHaveBeenCalledTimes(3);
    setVisibility("visible");
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("asks before the page unloads only while there is unsaved work", () => {
    let dirty = true;
    stop = watchLeave(window, { flush: () => undefined, dirty: () => dirty });
    const first = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    dirty = false;
    const second = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it("stops listening when stopped and logs a failing save instead of throwing", () => {
    const log = vi.fn();
    const flush = vi.fn(() => {
      throw new Error("boom");
    });
    const off = watchLeave(window, { flush, dirty: () => true, log });
    window.dispatchEvent(new Event("blur"));
    expect(log).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new Event("blur"));
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
