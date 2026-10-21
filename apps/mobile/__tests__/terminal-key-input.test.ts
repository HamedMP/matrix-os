import {
  ARROW_SWIPE_START_PX,
  applyTerminalCtrlModifier,
  arrowKeysForSwipe,
  type ArrowSwipeState,
} from "../lib/terminal-key-input";
import { buildTerminalControlSequence } from "../lib/terminal-state";

describe("sticky ctrl", () => {
  it("turns a typed letter into its control key, whatever its case", () => {
    expect(applyTerminalCtrlModifier("c")).toBe("\x03");
    expect(applyTerminalCtrlModifier("C")).toBe("\x03");
    expect(applyTerminalCtrlModifier("a")).toBe("\x01");
    expect(applyTerminalCtrlModifier("z")).toBe("\x1a");
  });

  it("covers the punctuation that has a control form", () => {
    expect(applyTerminalCtrlModifier("@")).toBe("\x00");
    expect(applyTerminalCtrlModifier(" ")).toBe("\x00");
    expect(applyTerminalCtrlModifier("[")).toBe("\x1b");
    expect(applyTerminalCtrlModifier("\\")).toBe("\x1c");
    expect(applyTerminalCtrlModifier("]")).toBe("\x1d");
    expect(applyTerminalCtrlModifier("^")).toBe("\x1e");
    expect(applyTerminalCtrlModifier("_")).toBe("\x1f");
    expect(applyTerminalCtrlModifier("?")).toBe("\x7f");
  });

  it("leaves text without a control form alone", () => {
    expect(applyTerminalCtrlModifier("1")).toBeNull();
    expect(applyTerminalCtrlModifier("ab")).toBeNull();
    expect(applyTerminalCtrlModifier("\r")).toBeNull();
    expect(applyTerminalCtrlModifier("")).toBeNull();
    expect(applyTerminalCtrlModifier("é")).toBeNull();
    expect(applyTerminalCtrlModifier("\x1b[A")).toBeNull();
  });
});

describe("swiping across the key rows", () => {
  const idle: ArrowSwipeState = { axis: null, sent: 0 };

  it("does nothing until the finger has clearly moved", () => {
    const step = arrowKeysForSwipe(idle, ARROW_SWIPE_START_PX - 1, 3);
    expect(step.keys).toEqual([]);
    expect(step.state).toEqual(idle);
  });

  it("sends one arrow per step of a sideways drag and takes them back when it reverses", () => {
    let step = arrowKeysForSwipe(idle, 30, 2);
    expect(step.keys).toEqual(["arrow-right", "arrow-right"]);

    step = arrowKeysForSwipe(step.state, 44, 4);
    expect(step.keys).toEqual(["arrow-right"]);

    step = arrowKeysForSwipe(step.state, 15, 4);
    expect(step.keys).toEqual(["arrow-left", "arrow-left"]);

    step = arrowKeysForSwipe(step.state, -29, 4);
    expect(step.keys).toEqual(["arrow-left", "arrow-left", "arrow-left"]);
  });

  it("keeps to the axis the drag started on", () => {
    let step = arrowKeysForSwipe(idle, 20, 2);
    expect(step.state.axis).toBe("x");

    step = arrowKeysForSwipe(step.state, 20, 120);
    expect(step.keys).toEqual([]);
  });

  it("sends up and down for a vertical drag", () => {
    let step = arrowKeysForSwipe(idle, 2, 45);
    expect(step.keys).toEqual(["arrow-down", "arrow-down"]);

    step = arrowKeysForSwipe(idle, 2, -21);
    expect(step.keys).toEqual(["arrow-up"]);
  });
});

describe("terminal control sequences", () => {
  it("sends shift-tab as a back-tab", () => {
    expect(buildTerminalControlSequence("shift-tab")).toBe("\x1b[Z");
  });
});
