import { act, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";

export interface SoftResizeTerminal {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  element: HTMLElement | null;
  resize: (cols: number, rows: number) => void;
}

/** Fixed cell metrics replace layout unavailable in jsdom, not sizing policy. */
export function installSoftResizeGeometry(terminal: SoftResizeTerminal, host: HTMLElement) {
  const root = terminal.element!;
  const screen = root.querySelector<HTMLElement>(".xterm-screen") ?? document.createElement("div");
  screen.className = "xterm-screen";
  if (!screen.parentElement) root.append(screen);
  const configuredFontSize = 13;
  const update = () => {
    const fontRatio = Number(terminal.options.fontSize) / configuredFontSize;
    screen.style.width = `${terminal.cols * 10 * fontRatio}px`;
    screen.style.height = `${terminal.rows * 20 * fontRatio}px`;
  };
  terminal.options = new Proxy({ ...terminal.options, fontSize: configuredFontSize }, {
    set(target, property, value) {
      Reflect.set(target, property, value);
      update();
      return true;
    },
  });
  terminal.resize = vi.fn((cols, rows) => {
    terminal.cols = cols;
    terminal.rows = rows;
    update();
  });
  // Cursor at the final canonical row, with the viewport following live output.
  Object.defineProperty(terminal, "buffer", { configurable: true, value: {
    active: { baseY: 0, viewportY: 0, cursorY: 35, cursorX: 2 },
  } });
  update();
  return {
    setHostSize(width: number, height: number) {
      Object.defineProperty(host, "clientWidth", { configurable: true, value: width });
      Object.defineProperty(host, "clientHeight", { configurable: true, value: height });
    },
    visualHeight() {
      const scale = Number(root.style.transform.match(/^scale\(([\d.]+)\)$/)?.[1] ?? 1);
      return Number.parseFloat(screen.style.height) * scale;
    },
  };
}

export async function assertSoftResizeLifecycle(input: {
  terminal: SoftResizeTerminal;
  host: HTMLElement;
  geometry: ReturnType<typeof installSoftResizeGeometry>;
  resizeHost: () => void;
}) {
  const { terminal, host, geometry, resizeHost } = input;
  const resize = async (height: number) => {
    geometry.setHostSize(1_600, height);
    await act(async () => {
      resizeHost();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  };
  const expectCanonicalGrid = () => {
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 120, rows: 36 });
  };

  await resize(600);
  await waitFor(() => expect(geometry.visualHeight(), "last canonical row fits after a moderate shrink")
    .toBeLessThanOrEqual(host.clientHeight + 0.5));
  expect(Number(terminal.options.fontSize)).toBeGreaterThanOrEqual(10);
  expectCanonicalGrid();

  await resize(300);
  expect(Number(terminal.options.fontSize)).toBeGreaterThanOrEqual(10);
  expect(geometry.visualHeight()).toBeGreaterThan(host.clientHeight);
  expect(["auto", "scroll"]).toContain(host.style.overflowY);
  expect(host.scrollTop, "resize follows the final cursor row when already at live output").toBeGreaterThan(0);
  expect(geometry.visualHeight() - host.scrollTop, "the final row remains visible above the viewport bottom")
    .toBeLessThanOrEqual(host.clientHeight + 0.5);
  expectCanonicalGrid();

  await resize(900);
  await waitFor(() => expect(terminal.options.fontSize).toBe(13));
  expect(geometry.visualHeight()).toBeLessThanOrEqual(host.clientHeight);
  expect(host.scrollTop).toBe(0);
  expectCanonicalGrid();
}
