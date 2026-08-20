import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdater } from "@desktop/main/updates";

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true },
}));

const updaterMock = vi.hoisted(() => {
  type UpdateHandler = (info: unknown) => void;
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
    on: vi.fn((eventName: string, handler: UpdateHandler) => {
      handlers.set(eventName, handler);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
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
  updaterMock.autoUpdater.on.mockClear();
  updaterMock.autoUpdater.checkForUpdates.mockReset().mockResolvedValue({});
  updaterMock.autoUpdater.quitAndInstall.mockReset();
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

  it("logs a packaged smoke-test signal when the current version is up to date", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();
    updaterMock.handlers.get("update-not-available")?.({ version: "1.2.3" });

    expect(updater.status()).toBe("up-to-date");
    expect(info).toHaveBeenCalledWith("[updates] update check completed: up to date");
    info.mockRestore();
  });

  it("reports an up-to-date result only for a user-requested check", async () => {
    const onUpToDate = vi.fn();
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onUpToDate,
    });

    await updater.check();
    updaterMock.handlers.get("update-not-available")?.({ version: "1.2.3" });
    expect(onUpToDate).not.toHaveBeenCalled();

    await updater.check({ notifyWhenCurrent: true });
    updaterMock.handlers.get("update-not-available")?.({ version: "1.2.3" });

    expect(onUpToDate).toHaveBeenCalledOnce();
  });

  it("reports a failed user-requested check without notifying for background failures", async () => {
    const onCheckError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onCheckError,
    });

    updaterMock.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("background offline"));
    await updater.check();
    expect(onCheckError).not.toHaveBeenCalled();

    updaterMock.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("manual offline"));
    await updater.check({ notifyWhenCurrent: true });

    expect(onCheckError).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reports that update checks require an installed build", async () => {
    electronMock.app.isPackaged = false;
    const onManualStatus = vi.fn();
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onManualStatus,
    });

    await updater.check({ notifyWhenCurrent: true });

    expect(onManualStatus).toHaveBeenCalledWith({ status: "disabled" });
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("reports an already downloading or ready update for a user-requested check", async () => {
    const onManualStatus = vi.fn();
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onManualStatus,
    });

    await updater.check();
    updaterMock.handlers.get("update-available")?.({ version: "1.2.3" });
    await updater.check({ notifyWhenCurrent: true });
    expect(onManualStatus).toHaveBeenLastCalledWith({
      status: "downloading",
      version: "1.2.3",
      progress: 0,
    });

    updaterMock.handlers.get("update-downloaded")?.({ version: "1.2.3" });
    await updater.check({ notifyWhenCurrent: true });
    expect(onManualStatus).toHaveBeenLastCalledWith({
      status: "ready",
      version: "1.2.3",
      progress: 100,
    });
  });

  it("reports a newly found update for a user-requested check", async () => {
    const onManualStatus = vi.fn();
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onManualStatus,
    });

    await updater.check({ notifyWhenCurrent: true });
    updaterMock.handlers.get("update-available")?.({ version: "1.2.3" });

    expect(onManualStatus).toHaveBeenCalledWith({
      status: "downloading",
      version: "1.2.3",
      progress: 0,
    });
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

  it("passes the resolved prerelease channel to the generic provider", async () => {
    delete process.env.OPERATOR_UPDATE_FEED;
    process.env.MATRIX_DESKTOP_UPDATE_CHANNEL = "beta";
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updaterMock.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/HamedMP/matrix-os/releases/download/desktop-beta/",
      channel: "beta",
    });
  });

  it("uses electron-updater's latest manifest name for the stable channel", async () => {
    delete process.env.OPERATOR_UPDATE_FEED;
    process.env.MATRIX_DESKTOP_UPDATE_CHANNEL = "stable";
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updaterMock.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/HamedMP/matrix-os/releases/download/desktop-stable/",
      channel: "latest",
    });
  });

  it("preserves the selected channel for an overridden generic feed", async () => {
    process.env.MATRIX_DESKTOP_UPDATE_CHANNEL = "canary";
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updaterMock.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://updates.example.com",
      channel: "canary",
    });
  });

  it("stays disabled when the app is not packaged", async () => {
    electronMock.app.isPackaged = false;
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    await updater.check();

    expect(updater.status()).toBe("disabled");
    expect(updaterMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("publishes bounded download progress and release metadata in its snapshot", async () => {
    const onStateChanged = vi.fn();
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onStateChanged,
    });

    await updater.check();
    updaterMock.handlers.get("update-available")?.({
      version: "1.2.3",
      releaseDate: "2026-08-11T09:00:00.000Z",
      releaseNotes: "## Improved\n\n- Faster project loading",
    });
    updaterMock.handlers.get("download-progress")?.({ percent: 42.75 });

    expect(updater.snapshot()).toEqual({
      status: "downloading",
      version: "1.2.3",
      progress: 42.75,
    });

    updaterMock.handlers.get("download-progress")?.({ percent: 250 });
    expect(updater.snapshot().progress).toBe(100);

    updaterMock.handlers.get("update-downloaded")?.({
      version: "1.2.3",
      releaseDate: "2026-08-11T09:00:00.000Z",
      releaseNotes: "## Improved\n\n- Faster project loading",
    });

    expect(updater.snapshot()).toEqual({
      status: "ready",
      version: "1.2.3",
      progress: 100,
    });
    expect(onStateChanged).toHaveBeenLastCalledWith({
      status: "ready",
      version: "1.2.3",
      progress: 100,
    });
  });

  it("installs immediately only after the background download is ready", async () => {
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });

    expect(await updater.install()).toBe(false);
    expect(updaterMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    await updater.check();
    updaterMock.handlers.get("update-downloaded")?.({ version: "1.2.3" });

    expect(await updater.install()).toBe(true);
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("starts persisting release notes before publishing the ready state and waits before install", async () => {
    const events: string[] = [];
    let finishSave: (() => void) | null = null;
    const updater = createUpdater({
      onAvailable: vi.fn(),
      onReady: vi.fn(),
      onStateChanged: (snapshot) => {
        if (snapshot.status === "ready") events.push("ready");
      },
      onReleaseReady: () => {
        events.push("persist");
        return new Promise<void>((resolve) => {
          finishSave = resolve;
        });
      },
    });

    await updater.check();
    updaterMock.handlers.get("update-downloaded")?.({
      version: "1.2.3",
      releaseNotes: "Safe persisted notes",
    });

    expect(events).toEqual(["persist", "ready"]);
    const install = updater.install();
    await Promise.resolve();
    expect(updaterMock.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    finishSave?.();
    await install;
    expect(updaterMock.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
