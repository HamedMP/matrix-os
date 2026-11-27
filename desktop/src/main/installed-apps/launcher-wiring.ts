// Windows and Linux wiring for installed apps (spec 2711, layer 4): where
// launchers and icons live, which command they run, and each Windows app
// window's taskbar identity. Every Electron call is here; the installers it
// composes are Electron-free and unit-tested.
import { app, shell } from "electron";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fetchGatewayIcon } from "./mac-icon";
import { resolveLauncherCommand } from "./launcher-command";
import { createLauncherInstaller, type LauncherPlatform } from "./launcher-installer";
import { createLinuxLauncher } from "./linux-launcher";
import type { InstalledAppStore } from "./record-store";
import type { InstalledAppRecord } from "./record";
import { createWindowsLauncher, windowsTaskbarDetails } from "./windows-launcher";

export interface LauncherWiringOptions {
  platform: NodeJS.Platform;
  userData: string;
  records: InstalledAppStore;
  /** This channel's deep-link scheme, so a canary launcher never opens stable. */
  scheme: string;
  auth: { getGatewayOrigin(): string; getToken(): string | null };
  forgetWindowState(installId: string): Promise<void>;
}

function linuxApplicationsDir(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "applications");
}

/**
 * Null on platforms without launchers (macOS uses app shims), and when no
 * launcher could start Matrix again (packaged Linux without its AppImage).
 */
export async function createPlatformLaunchers(options: LauncherWiringOptions) {
  if (options.platform !== "win32" && options.platform !== "linux") return null;
  const command = await resolveLauncherCommand({
    platform: options.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    appImage: process.env.APPIMAGE,
  });
  if (!command) {
    console.warn("[installed-apps] no relaunchable Matrix command; installing apps is unavailable");
    return null;
  }
  const launcher: LauncherPlatform = options.platform === "win32"
    ? createWindowsLauncher({
      programsDir: join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs"),
      ...command,
      scheme: options.scheme,
      writeShortcutLink: (path, operation, details) => shell.writeShortcutLink(path, operation, details),
      readShortcutLink: (path) => shell.readShortcutLink(path),
    })
    : createLinuxLauncher({ applicationsDir: linuxApplicationsDir(), exec: [command.exePath, ...command.baseArgs], scheme: options.scheme });
  const installer = createLauncherInstaller({
    records: options.records,
    iconsDir: join(options.userData, "installed-app-icons"),
    launcher,
    fetchIcon: (slug) => fetchGatewayIcon({
      fetchFn: (url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) }),
      gatewayOrigin: options.auth.getGatewayOrigin(),
      token: options.auth.getToken(),
      slug,
    }),
    forgetWindowState: options.forgetWindowState,
  });

  return {
    platform: options.platform === "win32" ? "windows" as const : "linux" as const,
    installer,
    /** Windows: the app window's own taskbar group, icon and relaunch command. */
    appDetails(record: InstalledAppRecord): Electron.AppDetailsOptions | undefined {
      if (options.platform !== "win32") return undefined;
      return windowsTaskbarDetails({
        installId: record.installId,
        name: record.name,
        ...command,
        scheme: options.scheme,
        iconPath: installer.iconPath(record),
      });
    },
  };
}

export type PlatformLaunchers = NonNullable<Awaited<ReturnType<typeof createPlatformLaunchers>>>;
