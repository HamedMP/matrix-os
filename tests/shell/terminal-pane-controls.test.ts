// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebTerminalControlsTransport } from "../../shell/src/components/terminal/terminal-controls-transport.js";
import { createTerminalKeyHandler } from "../../shell/src/components/terminal/terminal-key-handler.js";
import {
  dispatchTerminalPaneAction,
  listenTerminalPaneActions,
} from "../../shell/src/components/terminal/terminal-pane-actions.js";

afterEach(() => vi.unstubAllGlobals());

describe("Web terminal controls transport", () => {
  it("targets the explicit gateway and includes owner cookies with bounded requests", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ keyboard: { profile: "mac" } }),
    }));
    vi.stubGlobal("fetch", fetcher);
    const transport = createWebTerminalControlsTransport(
      "https://app.matrix-os.com/vm/test",
    );
    await transport.getPreferences();
    await transport.savePreferences({ profile: "mac", overrides: {} });
    await transport.paneAction("my shell", {
      type: "split",
      direction: "right",
    });
    expect(fetcher.mock.calls).toEqual([
      [
        "https://app.matrix-os.com/vm/test/api/terminal/preferences",
        expect.objectContaining({
          credentials: "same-origin",
          signal: expect.any(AbortSignal),
        }),
      ],
      [
        "https://app.matrix-os.com/vm/test/api/terminal/preferences",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ keyboard: { profile: "mac", overrides: {} } }),
          signal: expect.any(AbortSignal),
        }),
      ],
      [
        "https://app.matrix-os.com/vm/test/api/terminal/sessions/my%20shell/pane-actions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "split", direction: "right" }),
          signal: expect.any(AbortSignal),
        }),
      ],
    ]);
  });
  it("never exposes server failures or network details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("secret provider path")),
    );
    await expect(
      createWebTerminalControlsTransport("").paneAction("main", {
        type: "close",
      }),
    ).rejects.toThrow("Terminal request failed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(
      createWebTerminalControlsTransport("").getPreferences(),
    ).rejects.toThrow("Terminal request failed");
  });
});

describe("Web xterm keyboard integration", () => {
  const event = (key: string, options = {}) =>
    new KeyboardEvent("keydown", { key, cancelable: true, ...options });
  function setup() {
    const controls = vi.fn(() => false);
    const copy = vi.fn();
    const paste = vi.fn();
    const selectAll = vi.fn();
    const handler = createTerminalKeyHandler({
      isMac: true,
      getSelection: () => "selected",
      getCommandBlock: () => "block",
      copy,
      paste,
      selectAll,
      toggleSearch: vi.fn(),
      handleControls: controls,
    });
    return { handler, controls, copy, paste };
  }
  it("gives clipboard precedence and suppresses browser copy", () => {
    const { handler, copy, controls } = setup();
    const ev = event("c", { metaKey: true });
    expect(handler(ev)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(copy).toHaveBeenCalledWith("selected");
    expect(controls).not.toHaveBeenCalled();
  });
  it("delegates editing and pane chords to shared controls exactly once", () => {
    const { handler, controls } = setup();
    const ev = event("ArrowLeft", { metaKey: true });
    expect(handler(ev)).toBe(false);
    expect(controls).toHaveBeenCalledExactlyOnceWith(ev);
  });
  it("leaves IME keyCode 229 to the shared input guard before clipboard handling", () => {
    const { handler, controls, copy } = setup();
    const ev = event("c", { metaKey: true, keyCode: 229 });
    handler(ev);
    expect(copy).not.toHaveBeenCalled();
    expect(controls).toHaveBeenCalledWith(ev);
  });
  it("does not intercept composition as a clipboard shortcut", () => {
    const { handler, controls, copy } = setup();
    const ev = event("c", { metaKey: true, isComposing: true });
    handler(ev);
    expect(copy).not.toHaveBeenCalled();
    expect(controls).toHaveBeenCalledWith(ev);
  });
});

describe("Zellij actions from legacy web pane layouts", () => {
  it("addresses only the selected pane and removes its listener on unmount", () => {
    const selected = vi.fn();
    const other = vi.fn();
    const stop = listenTerminalPaneActions("selected", selected);
    const stopOther = listenTerminalPaneActions("other", other);
    dispatchTerminalPaneAction("selected", {
      type: "split",
      direction: "down",
    });
    dispatchTerminalPaneAction("selected", { type: "close" });
    expect(selected.mock.calls).toEqual([
      [{ type: "split", direction: "down" }],
      [{ type: "close" }],
    ]);
    expect(other).not.toHaveBeenCalled();
    stop();
    stopOther();
    dispatchTerminalPaneAction("selected", { type: "close" });
    expect(selected).toHaveBeenCalledTimes(2);
  });
});

it("retries only a plain missing route through the older standalone split endpoint", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("404 Not Found", { status: 404 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ pane: "terminal_2" })),
    );
  vi.stubGlobal("fetch", fetcher);
  await createWebTerminalControlsTransport("/vm/owner").paneAction("main", {
    type: "split",
    direction: "down",
  });
  expect(fetcher).toHaveBeenLastCalledWith(
    "/vm/owner/api/terminal/sessions/main/panes",
    expect.objectContaining({ body: JSON.stringify({ direction: "down" }) }),
  );
});
it("does not retry structured session errors or failed requests", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "session_not_found" } }), {
        status: 404,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createWebTerminalControlsTransport("").paneAction("main", {
      type: "split",
      direction: "down",
    }),
  ).rejects.toThrow("Terminal request failed");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
