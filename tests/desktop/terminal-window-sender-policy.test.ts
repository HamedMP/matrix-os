import { describe, expect, it } from "vitest";
import { createSenderPolicy } from "@desktop/main/ipc/sender-policy";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "@desktop/shared/ipc-contract";
import {
  TERMINAL_WINDOW_EVENT_CHANNELS,
  TERMINAL_WINDOW_INVOKE_CHANNELS,
  TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS,
} from "@desktop/shared/terminal-window";

const MAIN_URL = "file:///app/out/renderer/index.html";
const TERMINAL_URL = "file:///app/out/renderer/index.html?window=terminal";

function fakeWindow(url: string) {
  const mainFrame = { name: "main" };
  const webContents = { isDestroyed: () => false, getURL: () => url, mainFrame };
  return { isDestroyed: () => false, webContents };
}

function setup() {
  const main = fakeWindow(MAIN_URL);
  const terminal = fakeWindow(TERMINAL_URL);
  const authorize = createSenderPolicy({
    mainWindow: () => main,
    terminalWindow: () => terminal,
    mainUrl: MAIN_URL,
    terminalUrl: TERMINAL_URL,
  });
  const from = (win: ReturnType<typeof fakeWindow>) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return { main, terminal, authorize, from };
}

describe("IPC sender policy", () => {
  const allChannels = Object.keys(INVOKE_CHANNELS);
  const terminalAllowed = new Set<string>(TERMINAL_WINDOW_INVOKE_CHANNELS);
  const terminalOnly = new Set<string>(TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS);

  it("lets the Terminal window use exactly these channels", () => {
    // Written out here on purpose: widening the window's surface must be a
    // reviewed change to this list, not a silent edit to the allowlist.
    const expected = [
      "app:get-version", "app:get-zoom", "app:set-zoom", "auth:status", "runtime:list-computers",
      "terminal:read-clipboard-files", "terminal-window:focus-main",
      "local-terminal:ack", "local-terminal:attach", "local-terminal:create", "local-terminal:detach",
      "local-terminal:input", "local-terminal:kill", "local-terminal:list", "local-terminal:put",
      "local-terminal:rename", "local-terminal:resize",
    ].sort();
    const { terminal, authorize, from } = setup();
    expect(allChannels.filter((channel) => authorize(from(terminal), channel)).sort()).toEqual(expected);
  });

  it("lets the Terminal window read its appearance and no other saved state", () => {
    const { main, terminal, authorize, from } = setup();
    expect(authorize(from(terminal), "state:get", { key: "appearance" })).toBe(true);
    for (const payload of [{ key: "recents" }, { key: "panelLayouts" }, { key: "terminalWindowBounds" }, {}, null, undefined, "appearance", { key: ["appearance"] }]) {
      expect(authorize(from(terminal), "state:get", payload), JSON.stringify(payload)).toBe(false);
    }
    expect(authorize(from(terminal), "state:set", { key: "appearance", value: {} })).toBe(false);
    expect(authorize(from(main), "state:get", { key: "recents" })).toBe(true);
  });

  it("lets the Terminal window listen to exactly these events", () => {
    expect([...TERMINAL_WINDOW_EVENT_CHANNELS].sort()).toEqual(
      ["auth:changed", "local-terminal:closed", "local-terminal:output", "window:focus-changed"],
    );
    for (const channel of TERMINAL_WINDOW_EVENT_CHANNELS) expect(Object.keys(EVENT_CHANNELS), channel).toContain(channel);
  });

  it("lets the main window use every channel except Terminal-window-only ones", () => {
    const { main, authorize, from } = setup();
    for (const channel of allChannels) {
      expect(authorize(from(main), channel), channel).toBe(!terminalOnly.has(channel));
    }
  });

  it("keeps privileged channels away from the Terminal window", () => {
    for (const channel of ["auth:sign-out", "runtime:select", "state:set", "embed:open", "shell:open-external",
      "runtime:save-file-content", "terminal-window:open"]) {
      expect(terminalAllowed.has(channel), channel).toBe(false);
    }
    for (const channel of terminalAllowed) expect(allChannels, channel).toContain(channel);
  });

  it("rejects unknown senders, subframes, navigated windows and destroyed windows", () => {
    const { main, terminal, authorize, from } = setup();
    const stranger = fakeWindow(MAIN_URL);
    expect(authorize(from(stranger), "auth:status")).toBe(false);
    expect(authorize({ sender: main.webContents, senderFrame: { name: "subframe" } }, "auth:status")).toBe(false);
    expect(authorize(null, "auth:status")).toBe(false);
    expect(authorize({}, "auth:status")).toBe(false);

    terminal.webContents.getURL = () => "https://untrusted.example/";
    expect(authorize(from(terminal), "auth:status")).toBe(false);
    main.webContents.isDestroyed = () => true;
    expect(authorize(from(main), "auth:status")).toBe(false);
  });

  it("rejects everything when the windows are absent", () => {
    const authorize = createSenderPolicy({
      mainWindow: () => null, terminalWindow: () => null, mainUrl: MAIN_URL, terminalUrl: TERMINAL_URL,
    });
    expect(authorize({ sender: {}, senderFrame: {} }, "auth:status")).toBe(false);
  });
});
