// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSocketEvents } from "@desktop/renderer/src/lib/shell-socket";
import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";

const attachMock = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    cols = 80;
    rows = 24;

    loadAddon(): void {}
    open(): void {}
    write(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FakeFitAddon {
    fit(): void {}
  },
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class FakeSerializeAddon {
    serialize(): string {
      return "";
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class FakeWebglAddon {},
}));

vi.mock("@desktop/renderer/src/features/terminal/terminal-runtime", () => ({
  getAttachManager: () => ({
    activeSessionName: null,
    attach: attachMock,
    cacheBuffer: vi.fn(),
    detachActive: vi.fn(),
    getCachedBuffer: vi.fn(() => null),
  }),
}));

describe("TerminalView session switching", () => {
  beforeEach(() => {
    attachMock.mockReset();
    attachMock.mockImplementation((_sessionName: string, _events: ShellSocketEvents) => ({
      resize: vi.fn(),
      write: vi.fn(),
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class FakeResizeObserver {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("clears the ended banner before the next session emits state", () => {
    const { rerender } = render(<TerminalView sessionName="alpha" />);
    const alphaEvents = attachMock.mock.calls[0]?.[1] as ShellSocketEvents;
    alphaEvents.onExit(7);

    expect(screen.getByText("Session exited (code 7).")).toBeTruthy();

    rerender(<TerminalView sessionName="beta" />);

    expect(screen.queryByText("Session exited (code 7).")).toBeNull();
    expect(screen.getByText(/Connecting/)).toBeTruthy();
  });
});
