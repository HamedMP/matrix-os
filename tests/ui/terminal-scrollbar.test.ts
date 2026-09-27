// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalNativeHistory } from "../../packages/ui/src/terminal/terminal-native-history";
import { createTerminalScrollbar } from "../../packages/ui/src/terminal/terminal-scrollbar";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.replaceChildren(); });
function setup(tailHeight?: number, nativeHistory?: Parameters<typeof createTerminalScrollbar>[0]["nativeHistory"]) {
  const parent = document.createElement("div"), host = document.createElement("div"), root = document.createElement("div");
  root.innerHTML = '<div class="xterm-scrollable-element"><div class="scrollbar vertical"></div></div>';
  parent.append(host); host.append(root); document.body.append(parent);
  Object.defineProperties(host, { clientHeight: { value: 300, configurable: true }, clientWidth: { value: 800 }, scrollHeight: { value: 576, configurable: true } });
  const active = { baseY: 80, viewportY: 80 };
  let onScroll: (() => void) | undefined;
  const dispose = vi.fn();
  const terminal = { buffer: { active }, scrollToLine: vi.fn((line: number) => { active.viewportY = line; onScroll?.(); }),
    onScroll: (listener: () => void) => { onScroll = listener; return { dispose }; } };
  const scrollbar = createTerminalScrollbar({ host, root, terminal, nativeHistory, getCellHeight: () => 16, getTailHeight: tailHeight === undefined ? undefined : () => tailHeight, onPan: vi.fn() });
  cleanup = () => scrollbar.dispose();
  scrollbar.sync();
  const rail = parent.querySelector<HTMLElement>("[data-terminal-scrollbar=content]")!;
  return { parent, host, root, active, terminal, scrollbar, rail, dispose };
}
describe("unified terminal scrollbar", () => {
  it("replaces the inner and outer vertical bars with one viewport-aligned native rail", () => {
    const { host, root, rail, scrollbar } = setup();
    expect(rail).not.toBeNull();
    expect(host.style.scrollbarWidth).toBe("auto");
    expect(root.querySelector<HTMLElement>(".scrollbar.vertical")!.style.display).toBe("none");
    expect(rail.style.height).toBe("300px");
    expect(rail.firstElementChild?.getAttribute("style")).toContain("1856px");
    scrollbar.dispose();
    expect(host.style.scrollbarWidth).toBe("");
    expect(root.querySelector<HTMLElement>(".scrollbar.vertical")!.style.display).toBe("");
    expect(rail.isConnected).toBe(false);
  });
  it("drags continuously from oldest history to the bottom of the clipped live grid", () => {
    const { rail, host, active } = setup();
    const drag = (top: number) => { rail.scrollTop = top; rail.dispatchEvent(new Event("scroll")); };
    drag(0);
    expect(active.viewportY).toBe(0); expect(host.scrollTop).toBe(0);
    drag(160);
    expect(active.viewportY).toBe(10); expect(host.scrollTop).toBe(0);
    drag(1556);
    expect(active.viewportY).toBe(80); expect(host.scrollTop).toBe(276);
  });
  it("reflects terminal and trackpad scrolling without changing history or leaving listeners behind", () => {
    const { rail, host, active, scrollbar, terminal, dispose } = setup();
    active.viewportY = 12; host.scrollTop = 7;
    host.dispatchEvent(new Event("scroll"));
    expect(rail.scrollTop).toBe(199);
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    // A delayed native scroll event from our own synchronization is not a drag.
    rail.dispatchEvent(new Event("scroll"));
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
    scrollbar.dispose(); expect(dispose).toHaveBeenCalledOnce();
    rail.scrollTop = 50; rail.dispatchEvent(new Event("scroll"));
    expect(terminal.scrollToLine).not.toHaveBeenCalled();
  });
  it("keeps the rail range stable while full history rows replace a short live prompt", () => {
    const { rail, host, active, scrollbar } = setup(48);
    const height = rail.firstElementChild!.getAttribute("style");
    rail.scrollTop = 167; rail.dispatchEvent(new Event("scroll"));
    expect(active.viewportY).toBe(10); expect(host.scrollTop).toBe(7);
    scrollbar.sync();
    expect(rail.firstElementChild!.getAttribute("style")).toBe(height);
    rail.scrollTop = 1280; rail.dispatchEvent(new Event("scroll"));
    expect(active.viewportY).toBe(80); expect(host.scrollTop).toBe(0);
  });

  it("does not overwrite a pending rail gesture with a delayed host scroll event", () => {
    const { rail, host, active } = setup();
    rail.scrollTop = 0;
    host.dispatchEvent(new Event("scroll"));
    rail.dispatchEvent(new Event("scroll"));
    expect(active.viewportY).toBe(0);
    expect(host.scrollTop).toBe(0);
  });

  it("coalesces a delayed xterm viewport target and cancels it on disposal", () => {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const { rail, terminal, scrollbar } = setup();
    try {
      rail.scrollTop = 0; rail.dispatchEvent(new Event("scroll"));
      rail.scrollTop = 160; rail.dispatchEvent(new Event("scroll"));
      expect(cancel).toHaveBeenCalledWith(1);
      expect(terminal.scrollToLine).toHaveBeenLastCalledWith(10);
      frames[1](0);
      expect(terminal.scrollToLine).toHaveBeenCalledTimes(3);
      expect(terminal.scrollToLine).toHaveBeenLastCalledWith(10);
      rail.scrollTop = 320; rail.dispatchEvent(new Event("scroll"));
      scrollbar.cancelPending();
      expect(cancel).toHaveBeenLastCalledWith(3);
      rail.scrollTop = 480; rail.dispatchEvent(new Event("scroll"));
      scrollbar.dispose();
      expect(cancel).toHaveBeenLastCalledWith(4);
    } finally { scrollbar.dispose(); vi.unstubAllGlobals(); }
  });

  it.each(["history trim", "viewport resize"])("yields actual state when a pending target becomes unreachable after %s", change => {
    const { rail, host, active, terminal, scrollbar } = setup();
    terminal.scrollToLine.mockImplementation(() => undefined);
    try {
      rail.scrollTop = 1556; rail.dispatchEvent(new Event("scroll"));
      if (change === "history trim") { active.baseY = 20; active.viewportY = 20; }
      else Object.defineProperty(host, "clientHeight", { value: 500 });
      host.scrollTop = change === "history trim" ? 0 : 76;
      scrollbar.sync();
      expect(rail.scrollTop).toBe(active.viewportY * 16 + host.scrollTop);
    } finally { scrollbar.dispose(); }
  });

  it.each(["read-only", "missing acknowledgment"])("expires a real native target after %s without continuing scroll retries", failure => {
    vi.useFakeTimers();
    const send = vi.fn();
    const native = createTerminalNativeHistory({ send, canWrite: () => failure !== "read-only", onState() {} });
    native.attach(true); native.update({ above: 80, below: 0, rows: 36 }); send.mockClear();
    const { rail, scrollbar } = setup(undefined, native);
    try {
      rail.scrollTop = 0; rail.dispatchEvent(new Event("scroll"));
      if (failure === "read-only") expect(rail.scrollTop).toBe(1280);
      else expect(rail.scrollTop).toBe(0);
      vi.advanceTimersByTime(4_000);
      expect(rail.scrollTop).toBe(1280);
      const scrollCount = send.mock.calls.filter(([frame]) => frame.type === "scroll-to").length;
      if (failure === "read-only") expect(scrollCount).toBe(0);
      else expect(scrollCount).toBeGreaterThan(0);
      vi.advanceTimersByTime(8_000);
      expect(send.mock.calls.filter(([frame]) => frame.type === "scroll-to")).toHaveLength(scrollCount);
    } finally { scrollbar.dispose(); native.dispose(); vi.useRealTimers(); }
  });

  it("rejects an old local frame when native history appears before dispatch", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let state: { above: number; below: number; rows: number } | null = null;
    const scrollTo = vi.fn();
    const { rail, terminal, scrollbar } = setup(undefined, { getState: () => state, scrollTo });
    try {
      rail.scrollTop = 0; rail.dispatchEvent(new Event("scroll"));
      expect(terminal.scrollToLine).toHaveBeenCalledOnce();
      state = { above: 80, below: 0, rows: 36 };
      frames[0](0);
      expect(terminal.scrollToLine).toHaveBeenCalledOnce();
      expect(scrollTo).not.toHaveBeenCalled();
      scrollbar.sync();
      expect(rail.scrollTop).toBe(1280);
    } finally { scrollbar.dispose(); vi.unstubAllGlobals(); }
  });

  it.each(["newer gesture", "disposal"])("does not dispatch a captured old frame after %s", superseded => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { rail, terminal, scrollbar } = setup();
    try {
      rail.scrollTop = 0; rail.dispatchEvent(new Event("scroll"));
      if (superseded === "disposal") scrollbar.dispose();
      else { rail.scrollTop = 160; rail.dispatchEvent(new Event("scroll")); }
      const before = terminal.scrollToLine.mock.calls.length;
      frames[0](0);
      expect(terminal.scrollToLine).toHaveBeenCalledTimes(before);
    } finally { scrollbar.dispose(); vi.unstubAllGlobals(); }
  });

});
