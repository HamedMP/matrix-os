// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import type { ShellSocketEvents } from "@desktop/renderer/src/lib/shell-socket";

const { terminals, attach, write } = vi.hoisted(() => ({
  terminals: [] as Array<{ key?: (event: KeyboardEvent) => boolean; selection: string; selectAll: ReturnType<typeof vi.fn> }>,
  attach: vi.fn(),
  write: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    selection = "";
    element: HTMLElement | null = null;
    key?: (event: KeyboardEvent) => boolean;
    selectAll = vi.fn();
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    constructor() { terminals.push(this); }
    open(host: HTMLElement) { this.element = host; }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.key = handler; }
    onSelectionChange() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    onBinary() { return { dispose() {} }; }
    registerLinkProvider() { return { dispose() {} }; }
    getSelection() { return this.selection; }
    loadAddon() {}
    focus() {}
    blur() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class { serialize() { return ""; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@desktop/renderer/src/features/terminal/terminal-runtime", () => ({
  getAttachManager: () => ({
    activeSessionName: null,
    attach,
    getCachedBuffer: () => null,
    cacheBuffer() {},
    detachActive() {},
  }),
}));

describe("TerminalView keyboard control wiring", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  let events: ShellSocketEvents;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    terminals.length = 0;
    write.mockReset();
    attach.mockReset().mockImplementation((sessionName: string, callbacks: ShellSocketEvents) => {
      events = callbacks;
      return { sessionName, write, resize() {} };
    });
    api = {
      get: vi.fn().mockResolvedValue({ preferences: { keyboard: { profile: "mac", overrides: {} } } }),
      post: vi.fn().mockResolvedValue({ ok: true }),
      put: vi.fn(),
    };
    useConnection.setState({ api: api as never });
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
    useConnection.setState({ api: null });
  });

  it("renders controls in the supplied header without remounting the terminal", async () => {
    const header = document.createElement("div");
    document.body.append(header);
    const view = render(<TerminalView sessionName="session-one" controlsHost={header} />);
    act(() => events.onState("attached"));
    expect(header.querySelector('[data-testid="terminal-controls"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="terminal-controls"]')).toBeNull();
    expect(header.textContent).not.toContain("Pane controls");
    view.rerender(<TerminalView sessionName="session-one" controlsHost={header} active={false} />);
    expect(terminals).toHaveLength(1);
    expect((header.querySelector('button[aria-label="Split right"]') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    expect(header.childElementCount).toBe(0);
    header.remove();
  });

  it("uses the latest attached controller without remounting xterm and preserves select-all", async () => {
    const { rerender } = render(<TerminalView sessionName="session-one" />);
    act(() => events.onState("attached"));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const key = terminals[0].key!;
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, cancelable: true });
    act(() => expect(key(event)).toBe(false));
    expect(write).toHaveBeenCalledExactlyOnceWith("\x01");
    expect(event.defaultPrevented).toBe(true);
    act(() => expect(key(new KeyboardEvent("keydown", { key: "a", metaKey: true }))).toBe(false));
    expect(terminals[0].selectAll).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(1);

    rerender(<TerminalView sessionName="session-one" active={false} />);
    act(() => key(new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true })));
    expect(write).toHaveBeenCalledTimes(1);
    expect(terminals).toHaveLength(1);
  });

  it("dispatches repeated splits through Zellij without remounting the shared attachment", async () => {
    render(<TerminalView sessionName="session-one" chatId="chat-one" />);
    act(() => events.onState("attached"));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await act(async () => { terminals[0].key!(new KeyboardEvent("keydown", { key: "d", metaKey: true })); });
    expect(api.post).toHaveBeenCalledExactlyOnceWith(
      "/api/terminal/sessions/session-one/pane-actions?chatId=chat-one",
      { type: "split", direction: "right" },
    );
    expect(attach).toHaveBeenCalledTimes(1);
    await act(async () => { terminals[0].key!(new KeyboardEvent("keydown", { key: "d", metaKey: true })); });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(terminals).toHaveLength(1);
  });
});
