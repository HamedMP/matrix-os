import { beforeEach, describe, expect, it, vi } from "vitest";

const updaterMock = vi.hoisted(() => {
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    setFeedURL: vi.fn(),
    removeAllListeners: vi.fn(() => autoUpdater),
    once: vi.fn(() => autoUpdater),
    on: vi.fn(() => autoUpdater),
    checkForUpdates: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn(),
  };
  const moduleDefault: { autoUpdater?: typeof autoUpdater } = { autoUpdater };
  return { autoUpdater, moduleDefault };
});

vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({
  default: updaterMock.moduleDefault,
}));

import { createUpdater } from "@desktop/main/updates";

describe("packaged electron-updater module interop", () => {
  beforeEach(() => {
    updaterMock.moduleDefault.autoUpdater = updaterMock.autoUpdater;
    updaterMock.autoUpdater.autoDownload = false;
    updaterMock.autoUpdater.autoInstallOnAppQuit = false;
    updaterMock.autoUpdater.checkForUpdates.mockClear();
  });

  it("checks for updates through a default-wrapped CommonJS module", async () => {
    process.env.OPERATOR_UPDATE_FEED = "https://updates.example.com";
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updaterMock.autoUpdater.autoDownload).toBe(true);
    expect(updaterMock.autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(updaterMock.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.status()).toBe("checking");
  });

  it("fails safely when the updater module has no usable export", async () => {
    updaterMock.moduleDefault.autoUpdater = undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updater.status()).toBe("error");
    expect(warn).toHaveBeenCalledWith(
      "[updates] check failed:",
      "Desktop updater module is unavailable",
    );
    warn.mockRestore();
  });
});
