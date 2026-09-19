// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalScrollbar } from "../../packages/ui/src/terminal/terminal-scrollbar";

afterEach(() => document.body.replaceChildren());
function setup(tailHeight?: number) {
  const parent = document.createElement("div"), host = document.createElement("div"), root = document.createElement("div");
  root.innerHTML = '<div class="xterm-scrollable-element"><div class="scrollbar vertical"></div></div>';
  parent.append(host); host.append(root); document.body.append(parent);
  Object.defineProperties(host, { clientHeight: { value: 300 }, clientWidth: { value: 800 }, scrollHeight: { value: 576 } });
  const active = { baseY: 80, viewportY: 80 };
  let onScroll: (() => void) | undefined;
  const dispose = vi.fn();
  const terminal = { buffer: { active }, scrollToLine: vi.fn((line: number) => { active.viewportY = line; onScroll?.(); }),
    onScroll: (listener: () => void) => { onScroll = listener; return { dispose }; } };
  const scrollbar = createTerminalScrollbar({ host, root, terminal, getCellHeight: () => 16, getTailHeight: tailHeight === undefined ? undefined : () => tailHeight, onPan: vi.fn() });
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

});
