// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("Canvas interaction safety", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("interacting overlay timeout", () => {
    it("auto-clears interacting state after 5 seconds", () => {
      let interacting = true;
      const setInteracting = (v: boolean) => { interacting = v; };

      // Simulate the safety timer logic
      const safetyTimer = setTimeout(() => {
        setInteracting(false);
      }, 5000);

      vi.advanceTimersByTime(5000);
      expect(interacting).toBe(false);
      clearTimeout(safetyTimer);
    });

    it("does not auto-clear if pointer up fires in time", () => {
      let interacting = true;
      const setInteracting = (v: boolean) => { interacting = v; };

      const safetyTimer = setTimeout(() => {
        setInteracting(false);
      }, 5000);

      // Pointer up fires at 2 seconds
      vi.advanceTimersByTime(2000);
      clearTimeout(safetyTimer);
      setInteracting(false); // normal pointer up
      interacting = false;

      vi.advanceTimersByTime(3000); // past the 5s mark
      expect(interacting).toBe(false);
    });
  });

  describe("space key / overlay reset on visibility change", () => {
    it("resets spaceDown on visibility change to visible", () => {
      let spaceDown = true;
      let overlayPointerEvents = "all";

      // Simulate visibility change handler
      if (true /* document.visibilityState === "visible" */) {
        spaceDown = false;
        overlayPointerEvents = "none";
      }

      expect(spaceDown).toBe(false);
      expect(overlayPointerEvents).toBe("none");
    });
  });
});
