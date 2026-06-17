import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdater } from "@desktop/main/updates";

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true },
}));

const updaterMock = vi.hoisted(() => {
  type UpdateHandler = (info: { version: string } | Error) => void;
  const handlers = new Map<string, UpdateHandler>();
  const autoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: vi.fn(),
    removeAllListeners: vi.fn((eventName: string) => {
      handlers.delete(eventName);
      return autoUpdater;
    }),
    once: vi.fn((eventName: string, handler: UpdateHandler) => {
      handlers.set(eventName, handler);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(),
  };
  return { autoUpdater, handlers };
});

vi.mock("electron", () => electronMock);
vi.mock("electron-updater", () => ({ autoUpdater: updaterMock.autoUpdater }));

beforeEach(() => {
  process.env.OPERATOR_UPDATE_FEED = "https://updates.example.com";
  delete process.env.MATRIX_DESKTOP_UPDATE_CHANNEL;
  electronMock.app.isPackaged = true;
  updaterMock.handlers.clear();
  updaterMock.autoUpdater.autoDownload = false;
  updaterMock.autoUpdater.autoInstallOnAppQuit = false;
  updaterMock.autoUpdater.setFeedURL.mockClear();
  updaterMock.autoUpdater.removeAllListeners.mockClear();
  updaterMock.autoUpdater.once.mockClear();
  updaterMock.autoUpdater.checkForUpdates.mockReset().mockResolvedValue({});
});

describe("createUpdater", () => {
  it("replaces one-shot update listeners on each check", async () => {
    const onAvailable = vi.fn();
    const updater = createUpdater({ onAvailable, onReady: vi.fn() });

    await updater.check();
    await updater.check();

    expect(updaterMock.autoUpdater.removeAllListeners).toHaveBeenCalledWith("update-available");
    expect(updaterMock.autoUpdater.removeAllListeners).toHaveBeenCalledWith("update-downloaded");
    expect(updaterMock.autoUpdater.removeAllListeners).toHaveBeenCalledWith("update-not-available");
    expect(updaterMock.autoUpdater.removeAllListeners).toHaveBeenCalledWith("error");

    updaterMock.handlers.get("update-available")?.({ version: "1.2.3" });
    expect(onAvailable).toHaveBeenCalledOnce();
    expect(onAvailable).toHaveBeenCalledWith("1.2.3");
    expect(updater.status()).toBe("downloading");
  });

  it("does not replace download listeners while an update is downloading", async () => {
    const onReady = vi.fn();
    const updater = createUpdater({ onAvailable: vi.fn(), onReady });

    await updater.check();
    updaterMock.handlers.get("update-available")?.({ version: "1.2.3" });
    updaterMock.autoUpdater.removeAllListeners.mockClear();
    updaterMock.autoUpdater.checkForUpdates.mockClear();

    await updater.check();

    expect(updaterMock.autoUpdater.removeAllListeners).not.toHaveBeenCalled();
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    updaterMock.handlers.get("update-downloaded")?.({ version: "1.2.3" });
    expect(onReady).toHaveBeenCalledWith("1.2.3");
    expect(updater.status()).toBe("ready");
  });

  it("does not start a second update check while one is already checking", async () => {
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    const firstCheck = updater.check();
    expect(updater.status()).toBe("checking");
    updaterMock.autoUpdater.removeAllListeners.mockClear();
    updaterMock.autoUpdater.checkForUpdates.mockClear();

    await updater.check();

    expect(updater.status()).toBe("checking");
    expect(updaterMock.autoUpdater.removeAllListeners).not.toHaveBeenCalled();
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await firstCheck;
  });

  it("does not reset ready status on later scheduled checks", async () => {
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();
    updaterMock.handlers.get("update-downloaded")?.({ version: "1.2.3" });
    updaterMock.autoUpdater.removeAllListeners.mockClear();
    updaterMock.autoUpdater.checkForUpdates.mockClear();

    await updater.check();

    expect(updater.status()).toBe("ready");
    expect(updaterMock.autoUpdater.removeAllListeners).not.toHaveBeenCalled();
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports ready through callbacks instead of check return timing", async () => {
    const onReady = vi.fn();
    const updater = createUpdater({ onAvailable: vi.fn(), onReady });

    await updater.check();
    expect(updater.status()).toBe("checking");

    updaterMock.handlers.get("update-downloaded")?.({ version: "1.2.4" });
    expect(onReady).toHaveBeenCalledWith("1.2.4");
    expect(updater.status()).toBe("ready");
  });

  it("sets an error status when the update check fails", async () => {
    updaterMock.autoUpdater.checkForUpdates.mockRejectedValue(new Error("network down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updater.status()).toBe("error");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("recovers from asynchronous download errors so later checks can retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();
    updaterMock.handlers.get("update-available")?.({ version: "1.2.3" });
    expect(updater.status()).toBe("downloading");

    updaterMock.handlers.get("error")?.(new Error("download failed"));
    expect(updater.status()).toBe("error");

    updaterMock.autoUpdater.checkForUpdates.mockClear();
    await updater.check();

    expect(updaterMock.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("[updates] download failed:", "download failed");
    warn.mockRestore();
  });

  it("passes the resolved prerelease channel to the GitHub provider", async () => {
    delete process.env.OPERATOR_UPDATE_FEED;
    process.env.MATRIX_DESKTOP_UPDATE_CHANNEL = "beta";
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updaterMock.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "github",
      owner: "HamedMP",
      repo: "matrix-os",
      channel: "beta",
    });
  });

  it("stays disabled when the app is not packaged", async () => {
    electronMock.app.isPackaged = false;
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updater.status()).toBe("disabled");
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});
