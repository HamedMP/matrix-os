// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalScrollbar } from "../../packages/ui/src/terminal/terminal-scrollbar";
import { TerminalTabClientFrameSchema, TerminalTabServerFrameSchema } from "@matrix-os/contracts";

const terminalRef = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
describe("native terminal history", () => {
  it("validates bounded scroll state and absolute targets", () => {
    expect(TerminalTabClientFrameSchema.safeParse({ type: "scroll-to", terminalRef, line: 32 }).success).toBe(true);
    expect(TerminalTabClientFrameSchema.safeParse({ type: "scroll-to", terminalRef, line: -1 }).success).toBe(false);
    expect(TerminalTabServerFrameSchema.safeParse({ type: "scroll-state", terminalRef, revision: 1,
      state: { above: 20, below: 80, rows: 36 } }).success).toBe(true);
  });
  it("uses native history for thumb range and routes drag back to that history", () => {
    const parent = document.createElement("div");
    const host = document.createElement("div");
    const root = document.createElement("div");
    parent.append(host); host.append(root); document.body.append(parent);
    Object.defineProperties(host, { clientHeight: { value: 360, configurable: true }, clientWidth: { value: 800 }, scrollHeight: { value: 360 } });
    const scrollToLine = vi.fn(); const scrollNative = vi.fn();
    let state = { above: 20, below: 80, rows: 36 };
    const bar = createTerminalScrollbar({ host, root, getCellHeight: () => 10, onPan() {},
      terminal: { buffer: { active: { baseY: 0, viewportY: 0 } }, scrollToLine, onScroll: () => ({ dispose() {} }) },
      nativeHistory: { getState: () => state, scrollTo: scrollNative },
    });
    try {
      bar.sync();
      const rail = parent.querySelector<HTMLElement>('[data-terminal-scrollbar="content"]')!;
      expect(rail.style.display).toBe("block");
      expect(rail.firstElementChild?.getAttribute("style")).toContain("1360px");
      expect(rail.scrollTop).toBe(200);
      rail.scrollTop = 750; rail.dispatchEvent(new Event("scroll"));
      expect(scrollNative).toHaveBeenCalledWith(75);
      expect(scrollToLine).not.toHaveBeenCalled();
      state = { above: 75, below: 40, rows: 36 }; bar.sync();
      expect(rail.firstElementChild?.getAttribute("style")).toContain("1510px");
      expect(rail.scrollTop).toBe(750);
      Object.defineProperty(host, "clientHeight", { value: 720 });
      bar.sync();
      expect(rail.firstElementChild?.getAttribute("style")).toContain("3020px");
      expect(rail.scrollTop).toBe(1500);
    } finally { bar.dispose(); parent.remove(); }
  });
});

it("coalesces dragging, respects ownership, and stops polling after disposal", async () => {
  const { createTerminalNativeHistory } = await import("../../packages/ui/src/terminal/terminal-native-history");
  vi.useFakeTimers();
  const send = vi.fn(); let writer = true;
  const history = createTerminalNativeHistory({ send, canWrite: () => writer, onState() {} });
  try {
    history.attach(true);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
    history.update({ above: 100, below: 0, rows: 36 });
    history.scrollTo(20); history.scrollTo(40); history.scrollTo(60);
    expect(send).toHaveBeenLastCalledWith({ type: "scroll-to", line: 20 });
    history.update({ above: 20, below: 80, rows: 36 });
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenLastCalledWith({ type: "scroll-to", line: 60 });
    writer = false;
    history.update({ above: 60, below: 40, rows: 36 }); history.scrollTo(10);
    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenLastCalledWith({ type: "scroll-query" });
    history.dispose(); const count = send.mock.calls.length;
    vi.advanceTimersByTime(10000); expect(send).toHaveBeenCalledTimes(count);
  } finally { history.dispose(); vi.useRealTimers(); }
});

it("recovers after an unavailable native query and clears state across reattachment", async () => {
  const { createTerminalNativeHistory } = await import("../../packages/ui/src/terminal/terminal-native-history");
  vi.useFakeTimers();
  const send = vi.fn(), onState = vi.fn();
  const history = createTerminalNativeHistory({ send, canWrite: () => true, onState });
  try {
    history.attach(true); history.update(null);
    vi.advanceTimersByTime(500); expect(send).toHaveBeenCalledTimes(2);
    history.update({ above: 10, below: 40, rows: 36 });
    history.scrollTo(25); history.attach(false);
    expect(history.getState()).toBeNull();
    const count = send.mock.calls.length;
    vi.advanceTimersByTime(5000); expect(send).toHaveBeenCalledTimes(count);
    history.attach(true);
    expect(send).toHaveBeenLastCalledWith({ type: "scroll-query" });
    history.update({ above: 50, below: 0, rows: 36 });
    expect(history.getState()?.above).toBe(50);
  } finally { history.dispose(); vi.useRealTimers(); }
});
