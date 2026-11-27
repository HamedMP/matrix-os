// Linux launcher for an installed app (spec 2711, layer 4): a Desktop Entry
// in `~/.local/share/applications/matrix-app-<installId>.desktop` that runs the
// Matrix executable with `matrixos://app/<installId>`. Every value is escaped
// per the Desktop Entry Specification 1.5, so an app name cannot add keys.
//
// Electron has no per-window WM_CLASS or Wayland app_id (app.setDesktopName is
// app-wide), so app windows still group under Matrix. StartupWMClass is per
// app so the entry never claims Matrix's own windows, and StartupNotify is off
// so no launch spinner waits for a class that never maps.
import { randomBytes } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linkExclusive, removeOwnedFile, removeTemp } from "./launcher-files";
import { InstallIdSchema } from "./record";

const ENTRY_NAME = /^matrix-app-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.desktop$/;
// Characters that force an Exec argument into double quotes.
const EXEC_RESERVED = /[\s"'\\><~|&;$*?#()`]/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ENTRY_BYTES = 64 * 1024;

export function desktopEntryFileName(installId: string): string {
  return `matrix-app-${InstallIdSchema.parse(installId)}.desktop`;
}

export function linuxWmClass(installId: string): string {
  return `matrix-app-${InstallIdSchema.parse(installId)}`;
}

/** A `string`/`localestring` value: `\s` for a leading space, `\n`, `\t`, `\r` and `\\`. */
export function desktopEntryString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/^ /, "\\s");
}

/** One Exec argument: quoted when needed, `%` doubled, then string-escaped. Control characters are refused. */
export function desktopEntryExecArg(arg: string): string {
  if (arg.length === 0 || CONTROL.test(arg)) throw new RangeError("invalid Exec argument");
  const fieldSafe = arg.replace(/%/g, "%%");
  const quoted = EXEC_RESERVED.test(fieldSafe) ? `"${fieldSafe.replace(/["`$\\]/g, (char) => `\\${char}`)}"` : fieldSafe;
  return quoted.replace(/\\/g, "\\\\");
}

export interface DesktopEntryInput {
  installId: string;
  name: string;
  exec: readonly string[];
  iconPath: string | null;
}

export function buildDesktopEntry(input: DesktopEntryInput): string {
  const installId = InstallIdSchema.parse(input.installId);
  if (input.iconPath !== null && CONTROL.test(input.iconPath)) throw new RangeError("invalid icon path");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.5",
    `Name=${desktopEntryString(input.name)}`,
    "Comment=A Matrix app",
    `Exec=${input.exec.map(desktopEntryExecArg).join(" ")}`,
    ...(input.iconPath ? [`Icon=${desktopEntryString(input.iconPath)}`] : []),
    "Terminal=false",
    "Categories=Utility;",
    "StartupNotify=false",
    `StartupWMClass=${linuxWmClass(installId)}`,
    `X-Matrix-Install-Id=${installId}`,
    "",
  ].join("\n");
}

/** True when an entry's text opens exactly this install: its own id key and an Exec ending in its link. */
export function desktopEntryOpensInstall(text: string, installId: string): boolean {
  const id = InstallIdSchema.parse(installId);
  const lines = text.split(/\r?\n/);
  const exec = lines.find((line) => line.startsWith("Exec="));
  return lines.includes(`X-Matrix-Install-Id=${id}`) && exec !== undefined && exec.endsWith(`://app/${id}`);
}

async function readEntry(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_ENTRY_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface LinuxLauncherOptions {
  /** `$XDG_DATA_HOME/applications`, normally `~/.local/share/applications`. */
  applicationsDir: string;
  /** The Matrix executable, plus the app path for an unpackaged run. */
  exec: readonly string[];
  /** This channel's deep-link scheme. */
  scheme: string;
}

export function createLinuxLauncher(options: LinuxLauncherOptions) {
  const dir = options.applicationsDir;
  return {
    iconExtension: "png" as const,
    encodeIcon: (png: Uint8Array) => png,

    /** Writes the entry; fails, writing nothing, when one already exists. */
    async write(input: { installId: string; name: string; iconPath: string | null }): Promise<string> {
      const finalPath = join(dir, desktopEntryFileName(input.installId));
      const entry = buildDesktopEntry({
        installId: input.installId,
        name: input.name,
        exec: [...options.exec, `${options.scheme}://app/${input.installId}`],
        iconPath: input.iconPath,
      });
      await mkdir(dir, { recursive: true });
      const tempPath = join(dir, `.matrix-app-${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(tempPath, entry, { encoding: "utf8", flag: "wx", mode: 0o644 });
        if (!(await linkExclusive(tempPath, finalPath))) throw new Error("Launcher already exists");
        return finalPath;
      } finally {
        await removeTemp(tempPath);
      }
    },

    /** Deletes the entry only when it still opens this install; true when deleted. */
    remove(path: string, installId: string): Promise<boolean> {
      return removeOwnedFile(dir, path, (name) => ENTRY_NAME.test(name),
        async (target) => desktopEntryOpensInstall(await readEntry(target), installId));
    },
  };
}
