// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSocketEvents } from "@desktop/renderer/src/lib/shell-socket";
import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";
import { useAppearance } from "@desktop/renderer/src/stores/appearance";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTerminalAppearance } from "@desktop/renderer/src/stores/terminal-appearance";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import {
  bracketTerminalPaths,
  terminalPasteFiles,
} from "@desktop/renderer/src/features/terminal/terminal-rich-paste";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
const attachMock = vi.fn();
const attachmentWrite = vi.fn();
const attachmentResize = vi.fn();
const { createdFitAddons, createdTerminals, resizeObserverCallbacks } = vi.hoisted(() => ({
  createdFitAddons: [] as Array<{ fitCalls: number }>,
  createdTerminals: [] as Array<{
    initialOptions: {
      theme?: unknown;
      rightClickSelectsWord?: boolean;
      linkHandler?: {
        activate: (event: Pick<MouseEvent, "button">, text: string) => void;
      };
    };
    options: { theme?: unknown };
    registeredProviders: unknown[];
    dataCallback?: (data: string) => void;
    element: HTMLElement | null;
    focus: ReturnType<typeof vi.fn>;
    blur: ReturnType<typeof vi.fn>;
    selection: string;
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    paste: ReturnType<typeof vi.fn>;
    selectAll: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }>,
  resizeObserverCallbacks: [] as ResizeObserverCallback[],
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
      theme?: unknown;
      rightClickSelectsWord?: boolean;
      linkHandler?: {
        activate: (event: Pick<MouseEvent, "button">, text: string) => void;
      };
    };
    registeredProviders: unknown[] = [];
    selection = "";
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    paste = vi.fn((text: string) => this.dataCallback?.(text));
    selectAll = vi.fn();
    reset = vi.fn();

    constructor(options: FakeTerminal["initialOptions"]) {
      this.initialOptions = options;
      createdTerminals.push(this);
    }

    loadAddon(): void {}
    open(host: HTMLElement): void {
      const root = document.createElement("div");
      root.className = "xterm";
      const viewport = document.createElement("div");
      viewport.className = "xterm-viewport";
      const scrollable = document.createElement("div");
      scrollable.className = "xterm-scrollable-element";
      viewport.append(scrollable);
      root.append(viewport);
      host.append(root);
      this.element = root;
    }
    write(): void {}
    clear(): void {}
    focus = vi.fn();
    blur = vi.fn();
    dispose(): void {}
    onData(callback: (data: string) => void): { dispose: () => void } {
      this.dataCallback = callback;
      return { dispose: () => {} };
    }
    attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean): void {
      this.customKeyEventHandler = callback;
    }
    hasSelection(): boolean {
      return this.selection.length > 0;
    }
    getSelection(): string {
      return this.selection;
    }
    registerLinkProvider(provider: unknown): { dispose: () => void } {
      this.registeredProviders.push(provider);
      return { dispose: () => {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FakeFitAddon {
    fitCalls = 0;

    constructor() {
      createdFitAddons.push(this);
    }

    fit(): void {
      this.fitCalls += 1;
    }
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
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    createdFitAddons.length = 0;
    createdTerminals.length = 0;
    resizeObserverCallbacks.length = 0;
    attachMock.mockReset();
    attachMock.mockImplementation((_sessionName: string, _events: ShellSocketEvents) => ({
      resize: attachmentResize,
      write: attachmentWrite,
    }));
    attachmentResize.mockReset();
    attachmentWrite.mockReset();
    useAppearance.setState({ mode: "light", themeId: "operator", hydrated: true });
    useTerminalAppearance.setState({
      ...useTerminalAppearance.getInitialState(),
      themeId: "dark",
      hydrated: true,
    }, true);
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: null,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    vi.stubGlobal(
      "ResizeObserver",
      class FakeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallbacks.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(navigator, "platform", originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "platform");
    }
  });

  it("insets terminal glyphs while keeping the xterm surface fitted and theme-matched", () => {
    const { container } = render(<TerminalView sessionName="alpha" />);
    const host = container.querySelector<HTMLElement>("[data-terminal-viewport]")!;
    const frame = host.parentElement!;
    const root = host.querySelector<HTMLElement>(".xterm")!;
    const viewport = host.querySelector<HTMLElement>(".xterm-viewport")!;
    const scrollable = host.querySelector<HTMLElement>(".xterm-scrollable-element")!;
    const background = "#0C0C0C";
    const colorProbe = document.createElement("div");
    colorProbe.style.backgroundColor = background;

    expect(host.className).not.toMatch(/\b(?:px-2|pt-1\.5)\b/);
    expect(host.className).toContain("overflow-hidden");
    expect(frame.getAttribute("data-terminal-surface")).not.toBeNull();
    expect(frame.className).toContain("p-4");
    expect(frame.className).not.toContain("p-2");
    expect(frame.className).not.toContain("pl-3");
    expect(frame.className).not.toContain("pl-4");
    expect(frame.className).toContain("overflow-hidden");
    expect(frame.style.backgroundColor).toBe(colorProbe.style.backgroundColor);
    expect(root.style.width).toBe("100%");
    expect(root.style.height).toBe("100%");
    expect(root.style.backgroundColor).toBe(colorProbe.style.backgroundColor);
    expect(viewport.style.backgroundColor).toBe(colorProbe.style.backgroundColor);
    expect(scrollable.style.backgroundColor).toBe(colorProbe.style.backgroundColor);
  });

  it("proposes a new grid to the authority without locally refitting after a host resize", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<TerminalView sessionName="alpha" />);
    const fit = createdFitAddons.at(-1)!;
    const fitCallsBeforeResize = fit.fitCalls;
    attachmentResize.mockClear();

    act(() => {
      resizeObserverCallbacks.at(-1)?.([], {} as ResizeObserver);
    });

    expect(fit.fitCalls).toBe(fitCallsBeforeResize);
    expect(attachmentResize).toHaveBeenCalledOnce();
    expect(attachmentResize).toHaveBeenCalledWith(80, 24);
  });

  it("keeps xterm mounted and asks the authority for its grid when it becomes active again", () => {
    const { rerender } = render(<TerminalView sessionName="alpha" active />);
    const terminal = createdTerminals.at(-1)!;
    const fit = createdFitAddons.at(-1)!;
    const fitCallsBeforeNavigation = fit.fitCalls;

    rerender(<TerminalView sessionName="alpha" active={false} />);
    rerender(<TerminalView sessionName="alpha" active />);

    expect(createdTerminals).toHaveLength(1);
    expect(fit.fitCalls).toBe(fitCallsBeforeNavigation);
    expect(terminal.focus).toHaveBeenCalledTimes(2);
    expect(attachMock).toHaveBeenCalledTimes(2);
    expect(attachmentResize).toHaveBeenCalledTimes(2);
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

  it("forwards terminal input without updating navigation state", () => {
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const navigationUpdates = vi.fn();
    const unsubscribe = useTabs.subscribe(navigationUpdates);
    act(() => terminal.dataCallback?.("pwd\r"));
    act(() => terminal.dataCallback?.("ls\r"));

    expect(attachmentWrite).toHaveBeenCalledWith("pwd\r");
    expect(attachmentWrite).toHaveBeenCalledWith("ls\r");
    expect(navigationUpdates).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("never publishes Chat-bound input as a standalone Terminal tab", () => {
    render(<TerminalView sessionName="chat-shell" chatId="chat_selected" />);
    const terminal = createdTerminals.at(-1)!;
    const initialTabs = useTabs.getState().tabs;
    const navigationUpdates = vi.fn();
    const unsubscribe = useTabs.subscribe(navigationUpdates);

    act(() => terminal.dataCallback?.("pnpm test\r"));

    expect(attachmentWrite).toHaveBeenCalledWith("pnpm test\r");
    expect(useTabs.getState().tabs).toEqual(initialTabs);
    expect(navigationUpdates).not.toHaveBeenCalled();
    unsubscribe();
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

  it("releases keyboard focus when a retained terminal becomes inactive", () => {
    const { rerender } = render(<TerminalView sessionName="alpha" active />);
    const terminal = createdTerminals.at(-1)!;

    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(terminal.blur).not.toHaveBeenCalled();

    rerender(<TerminalView sessionName="alpha" active={false} />);

    expect(terminal.blur).toHaveBeenCalledOnce();

    rerender(<TerminalView sessionName="alpha" active />);

    expect(terminal.focus).toHaveBeenCalledTimes(2);
    expect(terminal.blur).toHaveBeenCalledOnce();
  });

  it("announces reconnecting, disconnected, and ended lifecycle states", () => {
    render(<TerminalView sessionName="alpha" />);
    const events = attachMock.mock.calls[0]?.[1] as ShellSocketEvents;

    act(() => events.onState("reconnecting"));
    expect(screen.getByRole("status").textContent).toContain("Reconnecting…");

    act(() => events.onState("connection-lost"));
    expect(screen.getByRole("status").textContent).toContain("Connection lost. Reconnecting…");

    act(() => events.onState("fatal"));
    expect(screen.getByRole("status").textContent).toContain("This session has ended on your computer.");
  });

  it("freezes after a lease takeover and explicitly reacquires on Resume here", () => {
    render(<TerminalView sessionName="alpha" />);
    const events = attachMock.mock.calls[0]?.[1] as ShellSocketEvents;

    act(() => events.onLeaseRevoked?.());
    expect(screen.getByRole("status").textContent).toContain("Live on another device.");

    fireEvent.click(screen.getByRole("button", { name: "Resume here" }));
    expect(attachMock).toHaveBeenCalledTimes(2);
  });

  it("resets xterm before rendering a replacement Zellij presentation", () => {
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const events = attachMock.mock.calls[0]?.[1] as ShellSocketEvents;

    act(() => events.onPresentationReset?.());

    expect(terminal.reset).toHaveBeenCalledOnce();
  });

  it("re-themes the right-hand shell without changing or following Desktop appearance", () => {
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    expect(terminal.initialOptions.theme).toMatchObject({ background: "#0C0C0C" });

    act(() => {
      useAppearance.setState({ mode: "dark", themeId: "dracula" });
    });
    expect(terminal.options.theme).toMatchObject({ background: "#0C0C0C" });

    act(() => {
      useTerminalAppearance.setState({ themeId: "matrix" });
    });
    const colorProbe = document.createElement("div");
    colorProbe.style.backgroundColor = "#020A02";
    expect(terminal.options.theme).toMatchObject({ background: "#020A02", cursor: "#39FF6A" });
    expect(terminal.element?.style.backgroundColor).toBe(colorProbe.style.backgroundColor);
    expect(terminal.element?.querySelector<HTMLElement>(".xterm-viewport")?.style.backgroundColor)
      .toBe(colorProbe.style.backgroundColor);
  });

  it("recreates a switched session with the current Terminal theme", () => {
    const { rerender } = render(<TerminalView sessionName="alpha" />);

    act(() => {
      useTerminalAppearance.setState({ themeId: "powerlevel10k-pure" });
    });
    rerender(<TerminalView sessionName="beta" />);

    expect(createdTerminals).toHaveLength(2);
    expect(createdTerminals.at(-1)?.initialOptions.theme).toMatchObject({ background: "#1B1D1E" });
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

  it.each([
    { label: "Command+C", metaKey: true, ctrlKey: false, shiftKey: false },
    { label: "Command+Shift+C", metaKey: true, ctrlKey: false, shiftKey: true },
    { label: "Ctrl+Shift+C", metaKey: false, ctrlKey: true, shiftKey: true },
  ])("copies the exact xterm selection once with $label", async ({ metaKey, ctrlKey, shiftKey }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    terminal.selection = "HTTP/1.1 401 Unauthorized\nλ-value: 👩🏽‍💻";
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey,
      ctrlKey,
      shiftKey,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\nλ-value: 👩🏽‍💻");
    expect(attachmentWrite).not.toHaveBeenCalled();
  });

  it("leaves copy unhandled without a selection and ignores repeated shortcuts", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;

    const withoutSelection = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);
    terminal.selection = "do not duplicate";
    const repeated = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: true,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(withoutSelection).toBe(true);
    expect(repeated).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("selects all terminal scrollback with Command+A", () => {
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "a",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(terminal.selectAll).toHaveBeenCalledOnce();
  });

  it("does not treat Meta+C as a macOS shortcut on non-Mac platforms", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    terminal.selection = "leave this selection alone";
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    { label: "Command+V", metaKey: true, ctrlKey: false, shiftKey: false },
    { label: "Ctrl+Shift+V", metaKey: false, ctrlKey: true, shiftKey: true },
  ])("pastes clipboard text once without Enter with $label", async ({ metaKey, ctrlKey, shiftKey }) => {
    const readText = vi.fn().mockResolvedValue("printf 'λ 👩🏽‍💻'");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const preventDefault = vi.fn();

    const handled = terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "v",
      metaKey,
      ctrlKey,
      shiftKey,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith("printf 'λ 👩🏽‍💻'"));
    expect(readText).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledOnce();
    expect(attachmentWrite).toHaveBeenCalledOnce();
    expect(attachmentWrite).toHaveBeenCalledWith("printf 'λ 👩🏽‍💻'");
    expect(attachmentWrite.mock.calls[0]?.[0]).not.toMatch(/[\r\n]$/);
  });

  it("keeps rich image paste precedence for Command+V", async () => {
    const blob = new Blob(["image"], { type: "image/png" });
    const readText = vi.fn().mockResolvedValue("text fallback");
    const read = vi.fn().mockResolvedValue([{
      types: ["image/png"],
      getType: vi.fn().mockResolvedValue(blob),
    }]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { read, readText },
    });
    const postBytes = vi.fn(async () => ({
      terminalPath: "/home/matrix/home/data/terminal-paste/clipboard.png",
    }));
    useConnection.setState({ api: { postBytes } as never });
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;

    terminal.customKeyEventHandler?.({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledWith(
      "\x1b[200~/home/matrix/home/data/terminal-paste/clipboard.png\x1b[201~",
    ));
    expect(read).toHaveBeenCalledOnce();
    expect(readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(postBytes).toHaveBeenCalledOnce();
  });

  it("keeps clipboard shortcuts pane-local when multiple terminals exist", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <>
        <TerminalView sessionName="alpha" active={false} />
        <TerminalView sessionName="beta" />
      </>,
    );
    const first = createdTerminals[0]!;
    const focused = createdTerminals[1]!;
    first.selection = "wrong pane";
    focused.selection = "focused pane";

    focused.customKeyEventHandler?.({
      type: "keydown",
      key: "c",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      isComposing: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("focused pane");
  });

  it("opens terminal actions on right click and copies the xterm selection", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    terminal.selection = "content-type: application/json";
    const host = container.querySelector<HTMLElement>("[data-terminal-viewport]")!;

    expect(fireEvent.contextMenu(host, { clientX: 120, clientY: 80 })).toBe(false);
    expect(screen.getByRole("menu", { name: "Terminal actions" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("content-type: application/json");
  });

  it("captures the immutable multiline selection before an inner xterm context listener", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const root = terminal.element!;
    terminal.selection = "first row\nλ second row 👩🏽‍💻";
    terminal.focus.mockClear();
    root.addEventListener("contextmenu", () => {
      terminal.selection = "hovered";
    });

    expect(terminal.initialOptions.rightClickSelectsWord).toBe(false);
    expect(fireEvent.contextMenu(root, { clientX: 120, clientY: 80 })).toBe(false);
    const copy = screen.getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("first row\nλ second row 👩🏽‍💻");
    expect(terminal.selection).toBe("first row\nλ second row 👩🏽‍💻");
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(container.querySelector("[role=menu]")).toBeNull();
  });

  it("shields a completed selection from passive and secondary TUI mouse reports", () => {
    render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const root = terminal.element!;
    const reports: string[] = [];
    for (const type of ["mousemove", "mousedown", "mouseup"] as const) {
      root.addEventListener(type, () => {
        reports.push(type);
        terminal.selection = "";
      });
    }
    terminal.selection = "first row\nλ second row 👩🏽‍💻";

    for (let index = 0; index < 20; index += 1) {
      fireEvent.mouseMove(root, { button: 0, buttons: 0 });
    }
    fireEvent.mouseDown(root, { button: 2, buttons: 2 });
    fireEvent.mouseUp(root, { button: 2, buttons: 0 });

    expect(reports).toEqual([]);
    expect(terminal.selection).toBe("first row\nλ second row 👩🏽‍💻");

    fireEvent.mouseDown(root, { button: 0, buttons: 1 });
    expect(reports).toEqual(["mousedown"]);
    expect(terminal.selection).toBe("");

    fireEvent.mouseMove(root, { button: 0, buttons: 0 });
    expect(reports).toEqual(["mousedown", "mousemove"]);
  });

  it("opens terminal actions without a selection and can select the buffer", () => {
    const { container } = render(<TerminalView sessionName="alpha" />);
    const terminal = createdTerminals.at(-1)!;
    const host = container.querySelector<HTMLElement>("[data-terminal-viewport]")!;

    expect(fireEvent.contextMenu(host, { clientX: 120, clientY: 80 })).toBe(false);
    expect((screen.getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "Select All" }));

    expect(terminal.selectAll).toHaveBeenCalledOnce();
  });

  it("filters terminal files to supported image formats and strips nested paste markers", () => {
    const png = new File(["png"], "screen.png", { type: "image/png" });
    const extensionFallback = new File(["jpeg"], "photo.JPG", { type: "" });
    const text = new File(["text"], "notes.txt", { type: "text/plain" });
    expect(terminalPasteFiles({ files: [png, extensionFallback, text] } as unknown as DataTransfer)).toEqual([
      { file: png, mimeType: "image/png" },
      { file: extensionFallback, mimeType: "image/jpeg" },
    ]);
    expect(bracketTerminalPaths(["/home/matrix/home/a\u001b[200~.png\u001b[201~"])).toBe(
      "\u001b[200~/home/matrix/home/a.png\u001b[201~",
    );
  });

  it("pastes uploaded images into the active terminal once, in order, without Enter", async () => {
    const paths = [
      "/home/matrix/home/projects/.matrix-terminal-pastes/first.png",
      "/home/matrix/home/projects/.matrix-terminal-pastes/second.png",
    ];
    let resolveFirst!: (value: { terminalPath: string }) => void;
    let resolveSecond!: (value: { terminalPath: string }) => void;
    const firstUpload = new Promise<{ terminalPath: string }>((resolve) => { resolveFirst = resolve; });
    const secondUpload = new Promise<{ terminalPath: string }>((resolve) => { resolveSecond = resolve; });
    const postBytes = vi.fn()
      .mockReturnValueOnce(firstUpload)
      .mockReturnValueOnce(secondUpload);
    useConnection.setState({ api: { postBytes } as never });
    const { container } = render(<TerminalView sessionName="alpha" />);
    const host = container.querySelector("[data-terminal-viewport]") as HTMLElement;
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });

    fireEvent.paste(host, { clipboardData: { files: [first, second] } });

    // Multiple clipboard images start together, while Promise.all preserves
    // their original clipboard order even when the second upload settles first.
    await waitFor(() => expect(postBytes).toHaveBeenCalledTimes(2));
    resolveSecond({ terminalPath: paths[1]! });
    resolveFirst({ terminalPath: paths[0]! });
    expect(postBytes).toHaveBeenNthCalledWith(
      1,
      "/api/terminal/sessions/alpha/paste-assets",
      first,
      { "Content-Type": "image/png", "X-Matrix-Filename": "first.png" },
      { timeoutMs: 30_000 },
    );
    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledWith(
      `\u001b[200~${paths.join(" ")}\u001b[201~`,
    ));
    expect(attachmentWrite).toHaveBeenCalledTimes(1);
    expect(attachmentWrite.mock.calls[0]?.[0]).not.toMatch(/\r|\n/);
  });

  it("supports drop but leaves unsupported and inactive terminal paste untouched", async () => {
    const postBytes = vi.fn(async () => ({ terminalPath: "/home/matrix/home/projects/drop.webp" }));
    useConnection.setState({ api: { postBytes } as never });
    const { container, rerender } = render(<TerminalView sessionName="alpha" />);
    const host = container.querySelector("[data-terminal-viewport]") as HTMLElement;
    const unsupported = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(unsupported, "clipboardData", {
      value: { files: [new File(["text"], "notes.txt", { type: "text/plain" })] },
    });
    host.dispatchEvent(unsupported);
    expect(unsupported.defaultPrevented).toBe(false);
    expect(postBytes).not.toHaveBeenCalled();

    fireEvent.drop(host, {
      dataTransfer: { files: [new File(["webp"], "drop.webp", { type: "image/webp" })] },
    });
    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledTimes(1));

    rerender(<TerminalView sessionName="alpha" active={false} />);
    const inactivePaste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(inactivePaste, "clipboardData", {
      value: { files: [new File(["png"], "inactive.png", { type: "image/png" })] },
    });
    host.dispatchEvent(inactivePaste);
    expect(inactivePaste.defaultPrevented).toBe(false);
    expect(postBytes).toHaveBeenCalledTimes(1);
  });

  it("logs terminal image upload failures while keeping the user error generic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const postBytes = vi.fn().mockRejectedValue(new Error("preview gateway offline"));
    useConnection.setState({ api: { postBytes } as never });
    const { container } = render(<TerminalView sessionName="alpha" />);
    const host = container.querySelector("[data-terminal-viewport]") as HTMLElement;

    fireEvent.paste(host, {
      clipboardData: { files: [new File(["png"], "failed.png", { type: "image/png" })] },
    });

    expect(await screen.findByText("Image paste failed. Try again.")).toBeTruthy();
    expect(warn).toHaveBeenCalledWith("[terminal] image paste failed:", "preview gateway offline");
    expect(attachmentWrite).not.toHaveBeenCalled();
  });

  it("shows a safe error and does not upload an image over 10 MB", async () => {
    const postBytes = vi.fn();
    useConnection.setState({ api: { postBytes } as never });
    const { container } = render(<TerminalView sessionName="alpha" />);
    const host = container.querySelector("[data-terminal-viewport]") as HTMLElement;
    const large = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
    fireEvent.paste(host, { clipboardData: { files: [large] } });

    expect(await screen.findByText("Images are limited to 10 MB.")).toBeTruthy();
    expect(postBytes).not.toHaveBeenCalled();
    expect(attachmentWrite).not.toHaveBeenCalled();
  });
});
