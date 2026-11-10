import { describe, expect, it } from "vitest";
import { createSenderPolicy } from "@desktop/main/ipc/sender-policy";
import { INVOKE_CHANNELS } from "@desktop/shared/ipc-contract";
import {
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

  it("lets the Terminal window use only its allowlisted channels", () => {
    const { terminal, authorize, from } = setup();
    for (const channel of allChannels) {
      expect(authorize(from(terminal), channel), channel).toBe(terminalAllowed.has(channel));
    }
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
