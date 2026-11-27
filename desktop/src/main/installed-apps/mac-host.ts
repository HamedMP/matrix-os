// What a shim bundle needs to know about the running Matrix app on macOS: its
// `.app`, bundle id, signing team, `app_shim_loader` and fallback icon. Uses
// the system `plutil` and `codesign` through execFile (no shell, timed out).
// Electron-free, so the Mac end-to-end test can drive the installer directly.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { appShimLoaderPath, hostAppBundlePath, parseCdHashes, parseTeamId } from "./mac-bundle";

const TOOL_TIMEOUT_MS = 10_000;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,255}$/;
const ICON_FILE = /^[A-Za-z0-9 ._-]{1,128}$/;

export type RunTool = (file: string, args: readonly string[], options: { signal: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

/** execFile without a shell; output capped at 1 MiB. */
export const runTool: RunTool = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], { signal: options.signal, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

export interface MacShimHost {
  appPath: string;
  bundleId: string;
  /** Null for ad-hoc or unsigned builds: the trust check then pins the cdhash only. */
  teamId: string | null;
  loaderPath: string;
  fallbackIcnsPath: string;
  hostArguments: string[];
}

function logFailure(label: string, error: unknown): void {
  console.warn(`[installed-apps] ${label}:`, error instanceof Error ? error.name : "UnknownError");
}

async function plistValue(run: RunTool, plist: string, key: string): Promise<string> {
  const { stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  return stdout.trim();
}

/** `codesign -dvvv` writes its details to stderr. */
export async function readCdHashes(run: RunTool, path: string): Promise<string[]> {
  const { stdout, stderr } = await run("/usr/bin/codesign", ["-dvvv", path], { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  return parseCdHashes(`${stdout}\n${stderr}`);
}

async function readTeamId(run: RunTool, appPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await run("/usr/bin/codesign", ["-dv", appPath], { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
    return parseTeamId(`${stdout}\n${stderr}`);
  } catch (error: unknown) {
    // Unsigned code makes codesign exit non-zero; the cdhash pin still applies.
    logFailure("could not read Matrix's signing team", error);
    return null;
  }
}

/** Null when Matrix is not running from an app bundle that ships the shim loader. */
export async function detectMacShimHost(options: {
  execPath: string;
  /** `app.getAppPath()`: the unpacked app directory in development. */
  appPath: string;
  isPackaged: boolean;
  run?: RunTool;
}): Promise<MacShimHost | null> {
  const run = options.run ?? runTool;
  const hostApp = hostAppBundlePath(options.execPath);
  if (!hostApp) return null;
  const loaderPath = appShimLoaderPath(hostApp);
  try {
    if (!(await stat(loaderPath)).isFile()) return null;
    const plist = join(hostApp, "Contents/Info.plist");
    const bundleId = await plistValue(run, plist, "CFBundleIdentifier");
    if (!BUNDLE_ID.test(bundleId)) return null;
    let fallbackIcnsPath = join(options.appPath, "build", "icon.icns");
    if (options.isPackaged) {
      const iconFile = await plistValue(run, plist, "CFBundleIconFile");
      if (!ICON_FILE.test(iconFile) || iconFile.startsWith(".")) return null;
      fallbackIcnsPath = join(hostApp, "Contents/Resources", iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`);
    }
    return {
      appPath: hostApp,
      bundleId,
      teamId: await readTeamId(run, hostApp),
      loaderPath,
      fallbackIcnsPath,
      // An unpacked Electron needs the app directory to start Matrix rather than its default app.
      hostArguments: options.isPackaged ? [] : [options.appPath],
    };
  } catch (error: unknown) {
    logFailure("app shims unavailable", error);
    return null;
  }
}
