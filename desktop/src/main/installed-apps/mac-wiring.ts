// macOS wiring for installed apps (spec 2711, layer 3): host detection, the
// installer, the shim server and the shim's menu. Every Electron call is here;
// the logic it composes is Electron-free and unit-tested.
import { app, dialog, Menu, shell, type BrowserWindow } from "electron";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { appShimServerName, MATRIX_APPS_FOLDER } from "./mac-bundle";
import { detectMacShimHost, readCdHashes, runTool } from "./mac-host";
import { buildShimIcon, fetchGatewayIcon } from "./mac-icon";
import { createMacInstaller, type MacInstaller, type MacInstallRequest } from "./mac-installer";
import type { InstalledAppStore } from "./record-store";
import type { InstalledAppRecord } from "./record";
import { createAppShimHost, type AppShimHostController, type AppShimLike } from "./shim-host";
import { shimMenuTemplate } from "./shim-menu";
import type { InstalledAppOpenContext, InstalledAppOpenResult } from "./controller";
import type { DesktopReleaseChannel } from "../../shared/channel-identity";

export interface MacInstalledAppsOptions {
  records: InstalledAppStore;
  channel: DesktopReleaseChannel;
  previewHandle?: string;
  service: {
    open(installId: string, context: InstalledAppOpenContext): Promise<InstalledAppOpenResult>;
    window(installId: string): BrowserWindow | null;
    reload(installId: string): boolean;
    close(installId: string): void;
    saveNow(installId: string): void;
  };
  auth: { getGatewayOrigin(): string; getToken(): string | null };
  forgetWindowState(installId: string): Promise<void>;
  focusMain(): void;
  openUrl(url: string): void;
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

export function createMacInstalledApps(options: MacInstalledAppsOptions) {
  const { service } = options;
  // Unpacked runs never claim a release channel's shims.
  const serverName = appShimServerName({
    channel: app.isPackaged ? options.channel : "dev",
    ...(options.previewHandle ? { previewHandle: options.previewHandle } : {}),
  });
  let installer: MacInstaller | null = null;
  let shims: AppShimHostController | null = null;

  async function uninstall(installId: string): Promise<boolean> {
    if (!installer) throw new Error("Installed apps are unavailable");
    service.close(installId);
    shims?.quitShim(installId);
    return installer.uninstall(installId);
  }

  async function confirmUninstall(record: InstalledAppRecord): Promise<void> {
    const parent = service.window(record.installId);
    const prompt = {
      type: "warning" as const,
      message: `Uninstall ${record.name}?`,
      detail: "This removes the app from Applications. Its files and data stay in Matrix.",
      buttons: ["Uninstall", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, prompt) : await dialog.showMessageBox(prompt);
    if (response === 0) await uninstall(record.installId);
  }

  function buildMenu(record: InstalledAppRecord, shim: AppShimLike) {
    return Menu.buildFromTemplate(shimMenuTemplate(record.name, {
      reload: () => { if (!service.reload(record.installId)) void service.open(record.installId, { appShim: shim }); },
      openInMatrix: () => options.focusMain(),
      showInFinder: () => { if (record.bundlePath) shell.showItemInFolder(record.bundlePath); },
      uninstall: () => { void confirmUninstall(record).catch((error: unknown) => logFailure("uninstall failed", error)); },
    }));
  }

  async function confirmRestart(): Promise<boolean> {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Restart Matrix to finish updating",
      detail: "Installed apps open again after Matrix restarts.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    return response === 0;
  }

  return {
    serverName,

    /** After records load: sweep and prune bundles, then serve this channel's shims. */
    async start(): Promise<void> {
      const host = await detectMacShimHost({ execPath: process.execPath, appPath: app.getAppPath(), isPackaged: app.isPackaged });
      if (!host) return;
      installer = createMacInstaller({
        appsDir: join(homedir(), "Applications", MATRIX_APPS_FOLDER),
        records: options.records,
        host: { ...host, serverName },
        makeIcon: async (slug) => buildShimIcon({
          png: await fetchGatewayIcon({
            fetchFn: (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) }),
            gatewayOrigin: options.auth.getGatewayOrigin(),
            token: options.auth.getToken(),
            slug,
          }),
          fallbackIcnsPath: host.fallbackIcnsPath,
          execFile: runTool,
          tmpDir: join(tmpdir(), "matrix-app-icons"),
        }),
        readCdHashes: (path) => readCdHashes(runTool, path),
        forgetWindowState: options.forgetWindowState,
      });
      await installer.sweep().catch((error: unknown) => logFailure("bundle sweep failed", error));
      await installer.prune().catch((error: unknown) => logFailure("install prune failed", error));
      shims = createAppShimHost({
        app,
        platform: process.platform,
        serverName,
        records: options.records,
        teamId: host.teamId,
        service,
        buildMenu,
        openUrl: options.openUrl,
        confirmRestart,
      });
      shims.start();
    },

    install(request: MacInstallRequest): Promise<InstalledAppRecord> {
      if (!installer) return Promise.reject(new Error("Installed apps are unavailable"));
      return installer.install(request);
    },

    uninstall,

    /** Opens the install through its shim bundle, so the window gets its own Dock identity. False when it can't. */
    async launch(installId: string, launchOptions: { background?: boolean } = {}): Promise<boolean> {
      if (!shims?.running()) return false;
      const record = await options.records.get(installId);
      if (!record?.bundlePath) return false;
      try {
        await runTool("/usr/bin/open", [...(launchOptions.background ? ["-g"] : []), record.bundlePath], { signal: AbortSignal.timeout(10_000) });
        return true;
      } catch (error: unknown) {
        logFailure("could not launch an installed app", error);
        return false;
      }
    },

    stop(): void {
      shims?.stop();
    },
  };
}
