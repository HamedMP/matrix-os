import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { DownloadUpdateOptions } from "../../desktop/node_modules/electron-updater/out/AppUpdater";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUpdater } from "@desktop/main/updates";

const loaded = vi.hoisted(() => ({ updater: null as unknown }));
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({ get autoUpdater() { return loaded.updater; } }));

// Exercise the installed library's actual GenericProvider, SemVer comparison,
// event order, and autoDownload behavior. Only network and installer I/O are fake.
const requireDesktop = createRequire(resolve("desktop/package.json"));
const { AppUpdater } = requireDesktop("electron-updater/out/AppUpdater.js") as typeof import("../../desktop/node_modules/electron-updater/out/AppUpdater");

class FeedUpdater extends AppUpdater {
  target = "1.0.1";
  downloads: string[] = [];
  requests: string[] = [];
  quitAndInstall = vi.fn();
  constructor(directory: string) {
    super(undefined, {
      version: "1.0.0", name: "fixture", isPackaged: true,
      appUpdateConfigPath: "unused", userDataPath: directory, baseCachePath: directory,
      whenReady: async () => undefined, relaunch() {}, quit() {}, onQuit() {},
    });
    this.logger = null;
    this.httpExecutor = {
      request: async (request: { path: string }) => {
        this.requests.push(request.path);
        return `version: ${this.target}\nfiles:\n  - url: release.zip\n    sha512: fixture\npath: release.zip\nsha512: fixture\n`;
      },
    } as never;
  }
  protected async doDownloadUpdate(options: DownloadUpdateOptions) {
    const info = options.updateInfoAndProvider.info;
    this.downloads.push(info.version);
    this.dispatchUpdateDownloaded({ ...info, downloadedFile: "fixture.zip" });
    return ["fixture.zip"];
  }
}

describe("latest-channel selection with real electron-updater", () => {
  it("replaces a staged N+1 with N+3 and installs it in one restart", async () => {
    vi.stubEnv("OPERATOR_UPDATE_FEED", "https://updates.example.com/");
    vi.stubEnv("MATRIX_DESKTOP_UPDATE_CHANNEL", "stable");
    const directory = await mkdtemp(resolve(tmpdir(), "matrix-update-feed-"));
    const feed = new FeedUpdater(directory);
    loaded.updater = feed;
    const updater = createUpdater({ onAvailable: vi.fn(), onReady: vi.fn() });
    try {
      await updater.check();
      await vi.waitFor(() => expect(updater.snapshot()).toMatchObject({ status: "ready", version: "1.0.1" }));
      feed.target = "1.0.3";
      // A check can finish after the new download is already ready. Either
      // outcome must never install the superseded 1.0.1 package.
      await updater.install();
      await vi.waitFor(() => expect(updater.snapshot()).toMatchObject({ status: "ready", version: "1.0.3" }));
      if (!updater.isInstallStarted()) expect(await updater.install()).toBe(true);
      expect(feed.downloads).toEqual(["1.0.1", "1.0.3"]);
      expect(feed.quitAndInstall).toHaveBeenCalledOnce();
      expect(feed.requests.every((path) => path.includes("latest"))).toBe(true);
    } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
  });
});
