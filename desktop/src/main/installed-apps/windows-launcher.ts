// Windows launcher for an installed app (spec 2711, layer 4): a Start Menu
// shortcut in `Programs\Matrix Apps\<Name>.lnk` that runs the Matrix
// executable with `matrixos://app/<installId>` under the install's own
// AppUserModelID, so the shortcut and the app's window share a taskbar group.
// Unverified on a real Windows machine; the logic is unit-tested.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bundleDisplayName } from "./mac-bundle";
import { linkExclusive, removeOwnedFile, removeTemp } from "./launcher-files";
import { InstallIdSchema } from "./record";

export const WINDOWS_APPS_FOLDER = "Matrix Apps";
const MAX_NAME_ATTEMPTS = 50;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function windowsAppUserModelId(installId: string): string {
  return `com.matrix-os.app.${InstallIdSchema.parse(installId)}`;
}

/** `<Name>.lnk`, then `<Name> 2.lnk`…: a safe file name that cannot pass for Matrix or a device name. */
export function windowsShortcutName(rawName: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("invalid shortcut attempt");
  let name = bundleDisplayName(rawName.replace(/[<>:"/\\|?*]/g, " "));
  if (RESERVED_NAME.test(name)) name = `${name} app`;
  return attempt === 1 ? `${name}.lnk` : `${name} ${attempt}.lnk`;
}

/** Quotes one argument so CommandLineToArgvW reads it back unchanged. */
export function windowsCommandLineArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let quoted = "\"";
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += char === "\"" ? "\\".repeat(backslashes * 2 + 1) + char : "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/** A single-image ICO that embeds the PNG as is (Windows Vista and later read PNG entries). */
export function pngToIco(png: Uint8Array): Uint8Array {
  if (png.byteLength < 24 || !PNG_SIGNATURE.every((byte, index) => png[index] === byte)) throw new RangeError("not a PNG");
  const source = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const size = (value: number) => (value >= 256 ? 0 : value);
  const ico = new Uint8Array(22 + png.byteLength);
  const view = new DataView(ico.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  ico[6] = size(source.getUint32(16));
  ico[7] = size(source.getUint32(20));
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, png.byteLength, true);
  view.setUint32(18, 22, true);
  ico.set(png, 22);
  return ico;
}

export interface WindowsLaunchTarget {
  installId: string;
  name: string;
  exePath: string;
  /** The app path for an unpackaged run; empty when packaged. */
  baseArgs: readonly string[];
  scheme: string;
  iconPath: string | null;
}

function launchArgs(target: Pick<WindowsLaunchTarget, "baseArgs" | "scheme" | "installId">): string {
  return [...target.baseArgs, `${target.scheme}://app/${InstallIdSchema.parse(target.installId)}`]
    .map(windowsCommandLineArg).join(" ");
}

/** `BrowserWindow.setAppDetails` for an app window: its own taskbar group, icon and relaunch command. */
export function windowsTaskbarDetails(target: WindowsLaunchTarget) {
  return {
    appId: windowsAppUserModelId(target.installId),
    appIconPath: target.iconPath ?? target.exePath,
    appIconIndex: 0,
    relaunchCommand: `${windowsCommandLineArg(target.exePath)} ${launchArgs(target)}`,
    relaunchDisplayName: target.name,
  };
}

export interface WindowsLauncherOptions {
  /** The per-user Start Menu `Programs` folder. */
  programsDir: string;
  exePath: string;
  baseArgs: readonly string[];
  scheme: string;
  /** `shell.writeShortcutLink`. */
  writeShortcutLink(path: string, operation: "create", details: Electron.ShortcutDetails): boolean;
  /** `shell.readShortcutLink`; throws when the file is not a readable shortcut. */
  readShortcutLink(path: string): Electron.ShortcutDetails;
}

export function createWindowsLauncher(options: WindowsLauncherOptions) {
  const folder = join(options.programsDir, WINDOWS_APPS_FOLDER);
  return {
    iconExtension: "ico" as const,
    encodeIcon: pngToIco,

    /** Writes the shortcut under a temp name, then claims the first free `<Name>.lnk`; never overwrites. */
    async write(input: { installId: string; name: string; iconPath: string | null }): Promise<string> {
      await mkdir(folder, { recursive: true });
      const details: Electron.ShortcutDetails = {
        target: options.exePath,
        args: launchArgs({ ...options, installId: input.installId }),
        appUserModelId: windowsAppUserModelId(input.installId),
        icon: input.iconPath ?? options.exePath,
        iconIndex: 0,
        description: `${input.name}, a Matrix app`,
      };
      const tempPath = join(folder, `.matrix-app-${randomBytes(6).toString("hex")}.lnk`);
      try {
        if (!options.writeShortcutLink(tempPath, "create", details)) throw new Error("Shortcut could not be written");
        for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
          const finalPath = join(folder, windowsShortcutName(input.name, attempt));
          if (await linkExclusive(tempPath, finalPath)) return finalPath;
        }
        throw new Error("No free shortcut name");
      } finally {
        await removeTemp(tempPath);
      }
    },

    /**
     * Deletes the shortcut only when it opens this install: Matrix with this
     * install's link, or this install's AppUserModelID. The owner may have
     * deleted ours and a later install (or the owner) reused the name.
     */
    remove(path: string, installId: string): Promise<boolean> {
      const aumid = windowsAppUserModelId(installId);
      const args = launchArgs({ ...options, installId });
      return removeOwnedFile(folder, path, (name) => name.endsWith(".lnk") && !name.startsWith("."), async (target) => {
        let details: Electron.ShortcutDetails;
        try {
          details = options.readShortcutLink(target);
        } catch (error: unknown) {
          console.warn("[installed-apps] shortcut unreadable; keeping it:", error instanceof Error ? error.name : "UnknownError");
          return false;
        }
        const sameTarget = typeof details.target === "string" && details.target.toLowerCase() === options.exePath.toLowerCase();
        return (sameTarget && details.args === args) || details.appUserModelId === aumid;
      });
    },
  };
}
