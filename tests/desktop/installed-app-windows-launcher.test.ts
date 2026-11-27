import { readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_APPS_FOLDER,
  createWindowsLauncher,
  pngToIco,
  windowsAppUserModelId,
  windowsCommandLineArg,
  windowsShortcutName,
  windowsTaskbarDetails,
} from "../../desktop/src/main/installed-apps/windows-launcher";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";
const OTHER = "0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("Windows shortcut values", () => {
  it("gives each install its own AppUserModelID", () => {
    expect(windowsAppUserModelId(ID)).toBe(`com.matrix-os.app.${ID}`);
    expect(() => windowsAppUserModelId("notes")).toThrow();
  });

  it("makes shortcut names safe Windows file names that cannot spoof Matrix", () => {
    expect(windowsShortcutName("Notes", 1)).toBe("Notes.lnk");
    expect(windowsShortcutName("Notes", 2)).toBe("Notes 2.lnk");
    expect(windowsShortcutName('a<b>c:"d"/e\\f|g?h*', 1)).toBe("a b c d e f g h.lnk");
    expect(windowsShortcutName("CON", 1)).toBe("CON app.lnk");
    expect(windowsShortcutName("nul.txt", 1)).toBe("nul.txt app.lnk");
    expect(windowsShortcutName("Notes. . ", 1)).toBe("Notes.lnk");
    expect(windowsShortcutName("Matrix OS", 1)).toBe("Matrix OS (Matrix App).lnk");
  });

  it("quotes arguments the way CommandLineToArgvW reads them", () => {
    expect(windowsCommandLineArg("matrixos://app/x")).toBe("matrixos://app/x");
    expect(windowsCommandLineArg("C:\\Program Files\\Matrix\\resources\\app")).toBe('"C:\\Program Files\\Matrix\\resources\\app"');
    expect(windowsCommandLineArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsCommandLineArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(windowsCommandLineArg("")).toBe('""');
  });

  it("describes the window's taskbar identity and relaunch command", () => {
    expect(windowsTaskbarDetails({
      installId: ID, name: "Notes", exePath: "C:\\Program Files\\Matrix OS\\Matrix OS.exe", baseArgs: [], scheme: "matrixos",
      iconPath: "C:\\Users\\me\\AppData\\Roaming\\Matrix OS\\installed-app-icons\\x.ico",
    })).toEqual({
      appId: `com.matrix-os.app.${ID}`,
      appIconPath: "C:\\Users\\me\\AppData\\Roaming\\Matrix OS\\installed-app-icons\\x.ico",
      appIconIndex: 0,
      relaunchCommand: `"C:\\Program Files\\Matrix OS\\Matrix OS.exe" matrixos://app/${ID}`,
      relaunchDisplayName: "Notes",
    });
  });

  it("falls back to the Matrix executable's icon", () => {
    expect(windowsTaskbarDetails({ installId: ID, name: "Notes", exePath: "C:\\m.exe", baseArgs: [], scheme: "matrixos", iconPath: null }).appIconPath)
      .toBe("C:\\m.exe");
  });

  it("wraps a PNG in a single-image ICO", () => {
    const icon = png(512, 512);
    const ico = pngToIco(icon);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 1]);
    // 256 px and larger are stored as 0.
    expect([ico[6], ico[7]]).toEqual([0, 0]);
    expect(view.getUint32(14, true)).toBe(icon.byteLength);
    expect(view.getUint32(18, true)).toBe(22);
    expect(Array.from(ico.subarray(22))).toEqual(Array.from(icon));
    expect([pngToIco(png(48, 32))[6], pngToIco(png(48, 32))[7]]).toEqual([48, 32]);
    expect(() => pngToIco(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("Windows Start Menu shortcuts", () => {
  let root: string;
  let programs: string;
  let folder: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-win-launcher-"));
    programs = join(root, "Programs");
    folder = join(programs, WINDOWS_APPS_FOLDER);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Stands in for shell.writeShortcutLink: writes the details it was given.
  const writeShortcutLink = vi.fn((path: string, operation: string, details: object) => {
    void operation;
    writeFileSync(path, JSON.stringify(details), { flag: "wx" });
    return true;
  });
  // Stands in for shell.readShortcutLink: reads back what the fake writer stored.
  const readShortcutLink = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Electron.ShortcutDetails;
  const launcher = (write: typeof writeShortcutLink = writeShortcutLink, read: (path: string) => Electron.ShortcutDetails = readShortcutLink) => createWindowsLauncher({
    programsDir: programs,
    exePath: "C:\\Matrix\\Matrix OS.exe",
    baseArgs: [],
    scheme: "matrixos",
    writeShortcutLink: write,
    readShortcutLink: read,
  });

  it("writes a shortcut in the Matrix Apps folder that opens the install", async () => {
    const path = await launcher().write({ installId: ID, name: "Notes", iconPath: "C:\\icons\\x.ico" });
    expect(path).toBe(join(folder, "Notes.lnk"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      target: "C:\\Matrix\\Matrix OS.exe",
      args: `matrixos://app/${ID}`,
      appUserModelId: `com.matrix-os.app.${ID}`,
      icon: "C:\\icons\\x.ico",
      iconIndex: 0,
      description: "Notes, a Matrix app",
    });
    expect(writeShortcutLink.mock.calls.at(-1)?.[1]).toBe("create");
    expect(await readdir(folder)).toEqual(["Notes.lnk"]);
  });

  it("never overwrites an existing shortcut; it takes the next free name", async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "Notes.lnk"), "owner's shortcut");
    const path = await launcher().write({ installId: ID, name: "Notes", iconPath: null });
    expect(path).toBe(join(folder, "Notes 2.lnk"));
    expect(await readFile(join(folder, "Notes.lnk"), "utf8")).toBe("owner's shortcut");
    expect(JSON.parse(await readFile(path, "utf8")).icon).toBe("C:\\Matrix\\Matrix OS.exe");
    expect((await readdir(folder)).sort()).toEqual(["Notes 2.lnk", "Notes.lnk"]);
  });

  it("fails cleanly when Windows refuses the shortcut", async () => {
    const refuse = vi.fn(() => false);
    await expect(launcher(refuse).write({ installId: ID, name: "Notes", iconPath: null })).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });

  it("removes only shortcuts directly in the Matrix Apps folder", async () => {
    const path = await launcher().write({ installId: ID, name: "Notes", iconPath: null });
    await writeFile(join(programs, "Other.lnk"), "keep");
    await expect(launcher().remove(join(programs, "Other.lnk"), ID)).rejects.toThrow();
    await expect(launcher().remove(join(folder, "notes.txt"), ID)).rejects.toThrow();
    await expect(launcher().remove(path, ID)).resolves.toBe(true);
    await expect(lstat(path)).rejects.toThrow();
    expect(await readFile(join(programs, "Other.lnk"), "utf8")).toBe("keep");
  });

  it("keeps a shortcut at the recorded path that opens another install", async () => {
    const path = await launcher().write({ installId: OTHER, name: "Notes", iconPath: null });
    await expect(launcher().remove(path, ID)).resolves.toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).appUserModelId).toBe(`com.matrix-os.app.${OTHER}`);
  });

  it("keeps a shortcut the owner made, or one that cannot be read", async () => {
    await mkdir(folder, { recursive: true });
    const mine = join(folder, "Notes.lnk");
    await writeFile(mine, JSON.stringify({ target: "C:\\Windows\\notepad.exe", args: "" }));
    await expect(launcher().remove(mine, ID)).resolves.toBe(false);
    await expect(launcher(writeShortcutLink, () => { throw new Error("not a shortcut"); }).remove(mine, ID)).resolves.toBe(false);
    expect(await readFile(mine, "utf8")).toContain("notepad");
  });

  it("recognizes its own shortcut by target and arguments, ignoring path case", async () => {
    const path = await launcher().write({ installId: ID, name: "Notes", iconPath: null });
    const read = () => ({ target: "c:\\matrix\\MATRIX OS.EXE", args: `matrixos://app/${ID}` });
    await expect(launcher(writeShortcutLink, read).remove(path, ID)).resolves.toBe(true);
  });
});
