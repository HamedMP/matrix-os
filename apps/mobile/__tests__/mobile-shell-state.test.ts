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

describe("mobile shell state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("parses valid native mobile shell state", () => {
    expect(parseMobileShellState({
      surface: "native-mobile",
      mode: "app",
      lastActiveAppSlug: "games/snake",
      lastActiveTerminalSessionId: "550e8400-e29b-41d4-a716-446655440000",
      canvasEnteredAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    })).toMatchObject({
      surface: "native-mobile",
      mode: "app",
      lastActiveAppSlug: "games/snake",
      lastActiveTerminalSessionId: "550e8400-e29b-41d4-a716-446655440000",
      canvasEnteredAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:01:00.000Z",
    });
  });

  it("falls back to launcher mode and drops unsafe persisted values", () => {
    expect(parseMobileShellState({
      surface: "browser-shell",
      mode: "desktop",
      lastActiveAppSlug: "../system/secrets",
      lastActiveTerminalSessionId: "terminal_123",
      canvasEnteredAt: "not-a-date",
      updatedAt: "not-a-date",
    })).toMatchObject({
      surface: "native-mobile",
      mode: "launcher",
      lastActiveAppSlug: null,
      lastActiveTerminalSessionId: null,
      canvasEnteredAt: null,
    });
  });

  it("loads default state when storage is empty or invalid", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("{not json");

    await expect(loadMobileShellState()).resolves.toMatchObject({
      surface: "native-mobile",
      mode: "launcher",
      lastActiveAppSlug: null,
      lastActiveTerminalSessionId: null,
    });
    expect(warnSpy).toHaveBeenCalledWith("[mobile] failed to load mobile shell state", expect.any(SyntaxError));
    warnSpy.mockRestore();
  });

  it("saves sanitized state to async storage", async () => {
    jest.mocked(AsyncStorage.setItem).mockResolvedValueOnce();

    await saveMobileShellState({
      surface: "native-mobile",
      mode: "app",
      lastActiveAppSlug: "Notes App",
      lastActiveTerminalSessionId: "terminal_123",
      canvasEnteredAt: null,
      updatedAt: "bad-date",
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.any(String),
    );
    const saved = JSON.parse(jest.mocked(AsyncStorage.setItem).mock.calls[0][1]);
    expect(saved).toMatchObject({
      surface: "native-mobile",
      mode: "app",
      lastActiveAppSlug: null,
      lastActiveTerminalSessionId: null,
    });
    expect(Date.parse(saved.updatedAt)).not.toBeNaN();
  });

  it("keeps a safe last-active app slug for mobile resume choices", async () => {
    jest.mocked(AsyncStorage.setItem).mockResolvedValueOnce();

    await saveMobileShellState({
      surface: "native-mobile",
      mode: "app",
      lastActiveAppSlug: "games/minesweeper",
      lastActiveTerminalSessionId: null,
      canvasEnteredAt: null,
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    const saved = JSON.parse(jest.mocked(AsyncStorage.setItem).mock.calls[0][1]);
    expect(saved).toMatchObject({
      surface: "native-mobile",
      mode: "app",
      lastActiveAppSlug: "games/minesweeper",
    });
  });
});
