// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellSocketEvents } from "@desktop/renderer/src/lib/shell-socket";
import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";
import { getThemeTerminalColors } from "@desktop/renderer/src/design/themes";
import { useAppearance } from "@desktop/renderer/src/stores/appearance";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import {
  bracketTerminalPaths,
  terminalPasteFiles,
} from "@desktop/renderer/src/features/terminal/terminal-rich-paste";

const attachMock = vi.fn();
const attachmentWrite = vi.fn();
const { createdTerminals } = vi.hoisted(() => ({
  createdTerminals: [] as Array<{ options: { theme?: unknown } }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    cols = 80;
    rows = 24;
    options: { theme?: unknown } = {};

    constructor() {
      createdTerminals.push(this);
    }

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
      write: attachmentWrite,
    }));
    attachmentWrite.mockReset();
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      authGeneration: 1,
      api: null,
    });
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
