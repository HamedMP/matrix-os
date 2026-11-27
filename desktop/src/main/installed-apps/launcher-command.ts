// The command a Windows or Linux launcher runs (spec 2711, layer 4). Packaged
// Linux ships as an AppImage: `process.execPath` lies inside its temporary
// mount, which is gone once Matrix quits, so launchers run the AppImage file
// named by `APPIMAGE`. Without a usable one, Linux installs are unavailable
// rather than writing a launcher that cannot start.
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface LauncherCommand {
  exePath: string;
  /** The app path for an unpackaged run; empty when packaged. */
  baseArgs: string[];
}

export async function resolveLauncherCommand(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  appPath: string;
  /** `process.env.APPIMAGE`. */
  appImage: string | undefined;
}): Promise<LauncherCommand | null> {
  if (!options.isPackaged) return { exePath: options.execPath, baseArgs: [options.appPath] };
  if (options.platform !== "linux") return { exePath: options.execPath, baseArgs: [] };
  const appImage = options.appImage;
  if (!appImage || !isAbsolute(appImage)) return null;
  try {
    return (await stat(appImage)).isFile() ? { exePath: appImage, baseArgs: [] } : null;
  } catch (error: unknown) {
    console.warn("[installed-apps] AppImage unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
