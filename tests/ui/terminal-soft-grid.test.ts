// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalGridPresentation, measureTerminalViewport } from "../../packages/ui/src/terminal/terminal-grid-presentation";
import { installSoftResizeGeometry, type SoftResizeTerminal } from "../helpers/terminal-soft-resize-regression";

describe("shared terminal grid presentation", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });
  const flush = () => {
    let passes = 0;
    while (frames.length && passes++ < 10) frames.splice(0).forEach((frame) => frame(0));
    expect(frames, "presentation settles without scheduling an endless layout loop").toHaveLength(0);
  };
  function setup(parentScale = 1) {
    const host = document.createElement("div");
    const root = document.createElement("div");
    host.append(root);
    document.body.append(host);
    const terminal = {
      cols: 120, rows: 36, element: root, options: { fontSize: 13 }, resize: vi.fn(),
    } satisfies SoftResizeTerminal;
    const geometry = installSoftResizeGeometry(terminal, host);
    geometry.setHostSize(1_600, 900);
    const onScale = vi.fn();
    const presentation = createTerminalGridPresentation({ host, getTerminal: () => terminal,
      getConfiguredFontSize: () => 13, onScale, getParentScale: () => parentScale });
    const layout = (width: number, height: number) => {
      geometry.setHostSize(width, height);
      presentation.schedule();
      flush();
    };
    return { host, root, terminal, geometry, onScale, presentation, layout };
  }

  it("gives the pan stage exactly the visual extent and clips unscaled layout overflow", () => {
    const { host, root, geometry, layout } = setup();
    layout(1_600, 600);
    const stage = host.querySelector<HTMLElement>("[data-terminal-grid-stage]")!;
    expect(stage.style.overflow).toBe("hidden");
    expect(root.style.position).toBe("absolute");
    expect(Number.parseFloat(stage.style.height)).toBeCloseTo(geometry.visualHeight());
    expect(geometry.visualHeight()).toBeLessThanOrEqual(600.5);
  });

  it("keeps deliberate outer-grid panning through repeated resizes", () => {
    const { host, layout } = setup();
    layout(1_600, 300);
    expect(host.scrollTop).toBeGreaterThan(200);
    host.scrollTop = 20;
    layout(1_600, 320);
    layout(1_600, 340);
    expect(host.scrollTop).toBe(20);
  });

  it("keeps quantized font metrics stable across output-only layout passes", () => {
    const { root, terminal, layout, presentation } = setup();
    const screen = root.querySelector<HTMLElement>(".xterm-screen")!;
    let fontSize = 13;
    const measure = () => {
      screen.style.width = `${63 * fontSize}px`;
      // Real renderer cell heights are quantized, not proportional to font size.
      screen.style.height = `${fontSize === 11 ? 612 : fontSize === 12 ? 720 : 756}px`;
    };
    terminal.options = {
      get fontSize() { return fontSize; },
      set fontSize(value) { fontSize = value; measure(); },
    };
    measure();
    layout(714, 623);
    const settled = { font: fontSize, transform: root.style.transform, height: root.parentElement!.style.height };
    for (let output = 0; output < 4; output += 1) {
      presentation.schedule();
      flush();
      expect({ font: fontSize, transform: root.style.transform, height: root.parentElement!.style.height })
        .toEqual(settled);
    }
    layout(1_600, 900);
    expect(fontSize).toBe(13);
  });

  it("does not pull a reader out of xterm scrollback when the window shrinks", () => {
    const { host, terminal, layout } = setup();
    Object.defineProperty(terminal, "buffer", { value: {
      active: { baseY: 80, viewportY: 20, cursorY: 35, cursorX: 2 },
    } });
    layout(1_600, 300);
    expect(host.scrollTop).toBe(0);
  });

  it("subtracts viewport padding and restores font size and pan on expansion", () => {
    const { host, terminal, geometry, layout } = setup();
    host.style.padding = "12px";
    layout(1_600, 600);
    expect(geometry.visualHeight()).toBeLessThanOrEqual(576.5);
    expect(terminal.options.fontSize).toBeGreaterThanOrEqual(10);
    layout(1_600, 300);
    expect(geometry.visualHeight() - host.scrollTop).toBeLessThanOrEqual(276.5);
    layout(1_600, 900);
    expect(terminal.options.fontSize).toBe(13);
    expect(host.scrollTop).toBe(0);
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 120, rows: 36 });
  });

  it("follows later output in a short live viewport and disposes the subscription", () => {
    const { host, terminal, layout, presentation } = setup();
    const buffer = { baseY: 0, viewportY: 0, cursorY: 0, cursorX: 0 };
    Object.defineProperty(terminal, "buffer", { value: { active: buffer } });
    let onOutput: (() => void) | undefined;
    const dispose = vi.fn();
    Object.assign(terminal, { onWriteParsed: (listener: () => void) => {
      onOutput = listener;
      return { dispose };
    } });
    layout(1_600, 300);
    expect(host.scrollTop).toBe(0);
    buffer.cursorY = 35;
    onOutput?.();
    onOutput?.();
    expect(frames).toHaveLength(1);
    flush();
    expect(host.scrollTop).toBeGreaterThan(200);
    host.scrollTop = 20;
    onOutput?.();
    flush();
    expect(host.scrollTop).toBe(20);
    presentation.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    onOutput?.();
    expect(frames).toHaveLength(0);
  });

  it("defers hidden hosts and coalesces repeated measurements", () => {
    const { host, geometry, presentation, layout } = setup();
    layout(0, 0);
    expect(host.querySelector("[data-terminal-grid-stage]")).toBeNull();
    geometry.setHostSize(1_600, 600);
    presentation.schedule();
    presentation.schedule();
    presentation.schedule();
    expect(frames).toHaveLength(1);
    flush();
    expect(host.querySelector("[data-terminal-grid-stage]")).not.toBeNull();
  });

  it("restores the root and drains pending presentation work before caching", () => {
    const { host, root, presentation, layout, onScale } = setup();
    root.style.width = "100%";
    layout(1_600, 300);
    presentation.schedule();
    presentation.dispose();
    flush();
    expect(host.querySelector("[data-terminal-grid-stage]")).toBeNull();
    expect(root.parentElement).toBe(host);
    expect(root.style.width).toBe("100%");
    expect(root.style.position).toBe("");
    expect(root.style.transform).toBe("");
    expect(onScale).toHaveBeenLastCalledWith(1);
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
  });

  it("measures the real viewport through FitAddon's parent and restores the stage even on failure", () => {
    const { host, root, layout } = setup();
    host.style.padding = "12px";
    layout(800, 300);
    const stage = root.parentElement!;
    const previous = { width: stage.style.width, height: stage.style.height };
    const measured = measureTerminalViewport(host, root, () => ({
      width: root.parentElement!.style.width, height: root.parentElement!.style.height,
    }));
    expect(measured).toEqual({ width: "776px", height: "276px" });
    expect({ width: stage.style.width, height: stage.style.height }).toEqual(previous);
    expect(() => measureTerminalViewport(host, root, () => { throw new Error("font unavailable"); }))
      .toThrow("font unavailable");
    expect({ width: stage.style.width, height: stage.style.height }).toEqual(previous);
  });

  it("does not measure hidden or detached hosts", () => {
    const { host, root, geometry } = setup();
    const measure = vi.fn(() => ({ cols: 1, rows: 1 }));
    geometry.setHostSize(0, 0);
    expect(measureTerminalViewport(host, root, measure)).toBeUndefined();
    geometry.setHostSize(800, 600);
    host.remove();
    expect(measureTerminalViewport(host, root, measure)).toBeUndefined();
    expect(measure).not.toHaveBeenCalled();
  });

  it.each([false, true])("corrects wheel cells once, preserving deltas and consumed=%s", (consumed) => {
    const { root, layout, presentation } = setup(0.5);
    layout(1_600, 900);
    const received: WheelEvent[] = [];
    root.addEventListener("wheel", (event) => {
      received.push(event);
      if (consumed) event.preventDefault();
    });
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true,
      clientX: 40, clientY: 60, deltaX: 3, deltaY: -100, deltaMode: 1, shiftKey: true });
    root.dispatchEvent(wheel);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ clientX: 80, clientY: 120, deltaX: 3, deltaY: -100, deltaMode: 1, shiftKey: true });
    expect(wheel.defaultPrevented).toBe(consumed);
    presentation.dispose();
    received.length = 0;
    root.dispatchEvent(new WheelEvent("wheel", { clientX: 40, bubbles: true }));
    expect(received[0].clientX).toBe(40);
  });
});
