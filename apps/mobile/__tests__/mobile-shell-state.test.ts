jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  MOBILE_SHELL_STATE_STORAGE_KEY,
  loadMobileShellState,
  parseMobileShellState,
  saveMobileShellState,
} from "../lib/mobile-shell-state";

const TERMINAL_REF = "tws_00000000000000000000000000000001:tt_00000000000000000000000000000001";

describe("mobile shell state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("parses current workspace/tab references", () => {
    expect(parseMobileShellState({
      surface: "native-mobile",
      mode: "terminal",
      lastActiveAppSlug: "games/snake",
      lastActiveTerminalRef: TERMINAL_REF,
      terminalHandoffRef: TERMINAL_REF,
      canvasEnteredAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    })).toMatchObject({
      surface: "native-mobile",
      mode: "terminal",
      lastActiveAppSlug: "games/snake",
      lastActiveTerminalRef: TERMINAL_REF,
      terminalHandoffRef: TERMINAL_REF,
    });
  });

  it("drops legacy and unsafe persisted terminal values", () => {
    expect(parseMobileShellState({
      mode: "desktop",
      lastActiveAppSlug: "../system/secrets",
      lastActiveTerminalRef: "matrix-legacy",
      terminalHandoffRef: "../system/secrets",
      updatedAt: "not-a-date",
    })).toMatchObject({
      surface: "native-mobile",
      mode: "launcher",
      lastActiveAppSlug: null,
      lastActiveTerminalRef: null,
      terminalHandoffRef: null,
    });
  });

  it("loads default state when storage is invalid", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("{not json");
    await expect(loadMobileShellState()).resolves.toMatchObject({
      surface: "native-mobile",
      mode: "launcher",
      lastActiveTerminalRef: null,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("saves sanitized current state under the coordinated schema key", async () => {
    jest.mocked(AsyncStorage.setItem).mockResolvedValueOnce();
    await saveMobileShellState({
      surface: "native-mobile",
      mode: "terminal",
      lastActiveAppSlug: "notes",
      lastActiveTerminalRef: TERMINAL_REF,
      terminalHandoffRef: TERMINAL_REF,
      canvasEnteredAt: null,
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(MOBILE_SHELL_STATE_STORAGE_KEY, expect.any(String));
    const saved = JSON.parse(jest.mocked(AsyncStorage.setItem).mock.calls[0]![1]);
    expect(saved).toMatchObject({
      mode: "terminal",
      lastActiveAppSlug: "notes",
      lastActiveTerminalRef: TERMINAL_REF,
      terminalHandoffRef: TERMINAL_REF,
    });
  });
});
