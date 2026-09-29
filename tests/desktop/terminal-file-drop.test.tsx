// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSocketEvents } from "@desktop/renderer/src/lib/shell-socket";
import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";
import { useAppearance } from "@desktop/renderer/src/stores/appearance";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTerminalAppearance } from "@desktop/renderer/src/stores/terminal-appearance";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
const TERMINAL_REF_KEY = `tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`;
const attachMock = vi.fn();
const attachmentWrite = vi.fn();
const attachmentWriteBinary = vi.fn();
const attachmentResize = vi.fn();

const { createdFitAddons, createdTerminals, resizeObserverCallbacks } = vi.hoisted(() => ({
  createdFitAddons: [] as Array<{ fitCalls: number }>,
  createdTerminals: [] as Array<{
    initialOptions: {
      theme?: unknown;
      macOptionClickForcesSelection?: boolean;
      rightClickSelectsWord?: boolean;
      linkHandler?: {
        activate: (event: Pick<MouseEvent, "button">, text: string) => void;
      };
    };
    options: { theme?: unknown };
    registeredProviders: unknown[];
    dataCallback?: (data: string) => void;
    binaryCallback?: (data: string) => void;
    osc52Handler?: (data: string) => boolean;
    selectionChangeCallback?: () => void;
    modes: { mouseTrackingMode: "none" | "any" };
    element: HTMLElement | null;
    focus: ReturnType<typeof vi.fn>;
    blur: ReturnType<typeof vi.fn>;
    selection: string;
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    paste: ReturnType<typeof vi.fn>;
    selectAll: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
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
    parser = {
      registerOscHandler: vi.fn((_identifier: number, handler: (data: string) => boolean) => {
        this.osc52Handler = handler;
        return { dispose: () => {} };
      }),
    };
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
      macOptionClickForcesSelection?: boolean;
      rightClickSelectsWord?: boolean;
      linkHandler?: {
        activate: (event: Pick<MouseEvent, "button">, text: string) => void;
      };
    };
    registeredProviders: unknown[] = [];
    modes: { mouseTrackingMode: "none" | "any" } = { mouseTrackingMode: "none" };
    selection = "";
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    paste = vi.fn((text: string) => this.dataCallback?.(text));
    selectAll = vi.fn();
    clearSelection = vi.fn(() => {
      this.selection = "";
    });
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
    clear = vi.fn();
    focus = vi.fn();
    blur = vi.fn();
    dispose(): void {}
    onData(callback: (data: string) => void): { dispose: () => void } {
      this.dataCallback = callback;
      return { dispose: () => {} };
    }
    onBinary(callback: (data: string) => void): { dispose: () => void } {
      this.binaryCallback = callback;
      return { dispose: () => {} };
    }
    onSelectionChange(callback: () => void): { dispose: () => void } {
      this.selectionChangeCallback = callback;
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

describe("Electron Terminal protected file drag", () => {
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
      writeBinary: attachmentWriteBinary,
    }));
    attachmentResize.mockReset();
    attachmentWrite.mockReset();
    attachmentWriteBinary.mockReset();
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
    Reflect.deleteProperty(window, "operator");
    window.getSelection()?.removeAllRanges();
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

  it.each(["dragenter", "dragover"])("accepts %s with protected file data then uploads on drop", async (type) => {
    const post = vi.fn(async () => ({ assets: [{ terminalPath: "/home/matrix/home/projects/design.png" }] }));
    useConnection.setState({ api: { post } as never });
    const { container } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    const host = container.querySelector<HTMLElement>("[data-terminal-viewport]")!;
    const bubble = vi.fn();
    host.addEventListener(type, bubble);
    const getAsFile = vi.fn(() => null);
    const payload = { types: ["Files"], items: [{ kind: "file", type: "image/png", getAsFile }], files: [], dropEffect: "none" };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: payload });
    host.querySelector(".xterm")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(payload.dropEffect).toBe("copy");
    expect(bubble).not.toHaveBeenCalled();
    expect(getAsFile).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();

    fireEvent.drop(host, { dataTransfer: { files: [new File(["png"], "design.png", { type: "image/png" })] } });
    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledWith("\u001b[200~/home/matrix/home/projects/design.png\u001b[201~"));
    expect(post).toHaveBeenCalledOnce();
  });

  it("leaves text drags and inactive terminal drags untouched", () => {
    const { container, rerender } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    const host = container.querySelector<HTMLElement>("[data-terminal-viewport]")!;
    const text = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(text, "dataTransfer", { value: { types: ["text/plain"], files: [], items: [] } });
    host.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    rerender(<TerminalView sessionName={TERMINAL_REF_KEY} active={false} />);
    const file = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(file, "dataTransfer", { value: { types: ["Files"], files: [], items: [], dropEffect: "none" } });
    host.dispatchEvent(file);
    expect(file.defaultPrevented).toBe(false);
  });
  it.each([
    ["brief.pdf", "application/pdf", "%PDF-1.7"],
    ["说明.txt", "text/plain", "design notes"],
    ["archive.zip", "application/zip", "zip bytes"],
    ["unknown.bin", "", "binary bytes"],
    ["empty.txt", "text/plain", ""],
  ])("uploads dropped file %s and inserts only the remote path", async (name, type, contents) => {
    const post = vi.fn(async () => ({ assets: [{ terminalPath: "/home/matrix/home/temporary/terminal-pastes/file.txt" }] }));
    useConnection.setState({ api: { post } as never });
    const { container } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    const host = container.querySelector<HTMLElement>("[data-terminal-viewport]")!;
    fireEvent.drop(host, { dataTransfer: { files: [new File([contents], name, { type })] } });
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]).toEqual([
      expect.stringContaining("/paste-assets"),
      { kind: "file", assets: [{ name, mimeType: type || "application/octet-stream", dataBase64: btoa(contents) }] },
      { timeoutMs: 30_000 },
    ]);
    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledExactlyOnceWith("\u001b[200~/home/matrix/home/temporary/terminal-pastes/file.txt\u001b[201~"));
  });

  it("rejects more than eight dropped files without silently truncating the batch", async () => {
    const post = vi.fn();
    useConnection.setState({ api: { post } as never });
    const { container } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    fireEvent.drop(container.querySelector("[data-terminal-viewport]")!, {
      dataTransfer: { files: Array.from({ length: 9 }, (_, n) => new File(["x"], `${n}.txt`)) },
    });
    expect(await screen.findByText("Upload up to 8 files at a time.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(attachmentWrite).not.toHaveBeenCalled();
  });

  it("uploads copied Finder files on Cmd+V instead of pasting the name", async () => {
    const readText = vi.fn(async () => "IMG_0330.JPG");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    const invoke = vi.fn(async () => ({ status: "files", files: [{ name: "IMG_0330.JPG", mimeType: "application/octet-stream", dataBase64: "eA==" }] }));
    Object.defineProperty(window, "operator", { configurable: true, value: { invoke } });
    const post = vi.fn(async () => ({ assets: [{ terminalPath: "/home/matrix/home/temporary/terminal-pastes/copied.jpg" }] }));
    useConnection.setState({ api: { post } as never });
    render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    createdTerminals.at(-1)!.customKeyEventHandler?.(new KeyboardEvent("keydown", { key: "v", metaKey: true, cancelable: true }));
    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledExactlyOnceWith("\x1b[200~/home/matrix/home/temporary/terminal-pastes/copied.jpg\x1b[201~"));
    expect(invoke).toHaveBeenCalledWith("terminal:read-clipboard-files", {});
    expect(post).toHaveBeenCalledWith(expect.stringContaining("/paste-assets"), {
      kind: "file", assets: [{ name: "IMG_0330.JPG", mimeType: "application/octet-stream", dataBase64: "eA==" }],
    }, { timeoutMs: 30_000 });
    expect(readText).not.toHaveBeenCalled();
  });

  it.each(["directory", "unreadable"])("rejects an entire mixed drop containing an %s item", async (kind) => {
    const post = vi.fn();
    useConnection.setState({ api: { post } as never });
    const { container } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    const file = new File(["notes"], "notes.txt");
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file], items: [
      { kind: "file", getAsFile: () => file },
      { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: kind === "directory" }) },
    ] } });
    fireEvent(container.querySelector("[data-terminal-viewport]")!, event);
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText("Drop individual files only. Some items could not be read.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(attachmentWrite).not.toHaveBeenCalled();
  });

  it("reports a copied-file error without falling back to its name", async () => {
    const readText = vi.fn(async () => "too-big.bin");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    Object.defineProperty(window, "operator", { configurable: true, value: { invoke: vi.fn(async () => ({ status: "error", error: "too_large" })) } });
    render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    createdTerminals.at(-1)!.customKeyEventHandler?.(new KeyboardEvent("keydown", { key: "v", metaKey: true }));
    expect(await screen.findByText("Files are limited to 10 MB.")).toBeTruthy();
    expect(readText).not.toHaveBeenCalled();
    expect(attachmentWrite).not.toHaveBeenCalled();
  });

  it("discards copied files when the active terminal changes during native clipboard read", async () => {
    let resolveClipboard!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise((resolve) => { resolveClipboard = resolve; }));
    Object.defineProperty(window, "operator", { configurable: true, value: { invoke } });
    const post = vi.fn();
    useConnection.setState({ api: { post } as never });
    const { rerender } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    createdTerminals.at(-1)!.customKeyEventHandler?.(new KeyboardEvent("keydown", { key: "v", metaKey: true }));
    await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    rerender(<TerminalView sessionName={`tws_${"a".repeat(32)}:tt_${"c".repeat(32)}`} />);
    resolveClipboard({ status: "files", files: [{ name: "copied.txt", mimeType: "application/octet-stream", dataBase64: "eA==" }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).not.toHaveBeenCalled();
    expect(attachmentWrite).not.toHaveBeenCalled();
  });

  it("uploads selected files from the attachment action using the same terminal path flow", async () => {
    attachMock.mockImplementation((_name: string, events: ShellSocketEvents) => {
      events.onState("attached");
      return { resize: attachmentResize, write: attachmentWrite, writeBinary: attachmentWriteBinary };
    });
    const post = vi.fn(async () => ({ assets: [{ terminalPath: "/home/matrix/home/temporary/terminal-pastes/selected.pdf" }] }));
    useConnection.setState({ api: { post } as never });
    const { container } = render(<TerminalView sessionName={TERMINAL_REF_KEY} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(attachmentWrite).toHaveBeenCalledExactlyOnceWith("\x1b[200~/home/matrix/home/temporary/terminal-pastes/selected.pdf\x1b[201~"));
    expect(post).toHaveBeenCalledWith(expect.stringContaining("/paste-assets"), {
      kind: "file", assets: [{ name: "brief.pdf", mimeType: "application/pdf", dataBase64: "cGRm" }],
    }, { timeoutMs: 30_000 });
  });

});
