// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSocketEvents } from "@desktop/renderer/src/lib/shell-socket";
import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";
import { getThemeTerminalColors } from "@desktop/renderer/src/design/themes";
import { useAppearance } from "@desktop/renderer/src/stores/appearance";

const attachMock = vi.fn();
const { createdTerminals } = vi.hoisted(() => ({
  createdTerminals: [] as Array<{
    initialOptions: {
      linkHandler?: {
        activate: (event: Pick<MouseEvent, "button">, text: string) => void;
      };
    };
    options: { theme?: unknown };
    registeredProviders: unknown[];
    element: HTMLElement | null;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};
    element: HTMLElement | null = null;
    buffer = {
      active: {
        viewportY: 0,
        length: 1,
        getLine: (row: number) => row === 0
          ? {
              isWrapped: false,
              translateToString: () => "https://example.org/desktop-terminal",
            }
          : undefined,
      },
    };
    initialOptions: {
      linkHandler?: {
        activate: (event: Pick<MouseEvent, "button">, text: string) => void;
      };
    };
    registeredProviders: unknown[] = [];

    constructor(options: FakeTerminal["initialOptions"]) {
      this.initialOptions = options;
      createdTerminals.push(this);
    }

    loadAddon(): void {}
    open(host: HTMLElement): void {
      this.element = host;
    }
    write(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    registerLinkProvider(provider: unknown): { dispose: () => void } {
      this.registeredProviders.push(provider);
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
    act(() => {
      alphaEvents.onExit(7);
    });

    expect(screen.getByText("Session exited (code 7).")).toBeTruthy();

    rerender(<TerminalView sessionName="beta" />);

    expect(screen.queryByText("Session exited (code 7).")).toBeNull();
    expect(screen.getByText(/Connecting/)).toBeTruthy();
  });

  it("preserves the ended banner when re-activating an ended terminal", () => {
    const { rerender } = render(<TerminalView sessionName="alpha" active />);
    const alphaEvents = attachMock.mock.calls[0]?.[1] as ShellSocketEvents;
    act(() => {
      alphaEvents.onExit(7);
    });
    expect(screen.getByText("Session exited (code 7).")).toBeTruthy();

    rerender(<TerminalView sessionName="alpha" active={false} />);
    rerender(<TerminalView sessionName="alpha" active />);

    expect(screen.getByText("Session exited (code 7).")).toBeTruthy();
    expect(screen.queryByText(/Connecting/)).toBeNull();
    expect(attachMock).toHaveBeenCalledTimes(1);
  });

  it("re-themes live terminals only when the theme actually changes", () => {
    useAppearance.setState({ mode: "dark", themeId: "operator", hydrated: false });
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    expect(terminal.options.theme).toBeUndefined();

    // Hydration writes unrelated state; the palette must not be reassigned.
    act(() => {
      useAppearance.setState({ hydrated: true });
    });
    expect(terminal.options.theme).toBeUndefined();

    act(() => {
      useAppearance.setState({ themeId: "dracula" });
    });
    expect(terminal.options.theme).toMatchObject({
      background: getThemeTerminalColors("dracula", "dark").background,
    });
  });

  it("overrides xterm OSC activation and registers plain-text URL detection", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;

    terminal.initialOptions.linkHandler?.activate(
      { button: 2 },
      "https://example.org/final-check",
    );

    expect(open).not.toHaveBeenCalled();
    expect(terminal.initialOptions.linkHandler).toBeDefined();
    expect(terminal.registeredProviders).toHaveLength(1);
  });

  it("intercepts primary and secondary link mouseup before xterm can activate it", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const provider = terminal.registeredProviders[0] as {
      provideLinks: (
        line: number,
        callback: (links: Array<{ hover?: () => void }> | undefined) => void,
      ) => void;
    };
    let links: Array<{ hover?: () => void }> | undefined;
    provider.provideLinks(1, (provided) => {
      links = provided;
    });
    links?.[0]?.hover?.();

    const host = container.querySelector<HTMLElement>("[data-selectable]");
    expect(host).toBeTruthy();
    const primaryAllowed = fireEvent.mouseUp(host!, { button: 0 });
    const secondaryAllowed = fireEvent.mouseUp(host!, { button: 2 });

    expect(primaryAllowed).toBe(false);
    expect(secondaryAllowed).toBe(false);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      "https://example.org/desktop-terminal",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
