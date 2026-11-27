import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDesktopEntry,
  createLinuxLauncher,
  desktopEntryExecArg,
  desktopEntryFileName,
  desktopEntryString,
  linuxWmClass,
} from "../../desktop/src/main/installed-apps/linux-launcher";

const ID = "6f1c2a4e-2b7d-4c1a-9f3e-1a2b3c4d5e6f";

describe("Linux desktop entry", () => {
  it("names the file and the window class after the install id only", () => {
    expect(desktopEntryFileName(ID)).toBe(`matrix-app-${ID}.desktop`);
    expect(linuxWmClass(ID)).toBe(`matrix-app-${ID}`);
    expect(() => desktopEntryFileName("../notes")).toThrow();
  });

  it("escapes string values so a name cannot add keys or lines", () => {
    expect(desktopEntryString("Notes\nExec=evil")).toBe("Notes\\nExec=evil");
    expect(desktopEntryString(" lead\tc\\r\r")).toBe("\\slead\\tc\\\\r\\r");
  });

  it("quotes Exec arguments with reserved characters and escapes field codes", () => {
    expect(desktopEntryExecArg("/opt/Matrix/matrix-os")).toBe("/opt/Matrix/matrix-os");
    expect(desktopEntryExecArg("/opt/Matrix OS/matrix os")).toBe('"/opt/Matrix OS/matrix os"');
    // Quoting escapes `"`, `` ` ``, `$` and `\`; the string rule then doubles each backslash.
    expect(desktopEntryExecArg('/a"b$c`d\\e')).toBe('"/a\\\\"b\\\\$c\\\\`d\\\\\\\\e"');
    expect(desktopEntryExecArg("/opt/100%/app")).toBe("/opt/100%%/app");
    expect(() => desktopEntryExecArg("/bin/a\nb")).toThrow();
    expect(() => desktopEntryExecArg("")).toThrow();
  });

  it("builds an entry that opens the install through the Matrix executable", () => {
    const entry = buildDesktopEntry({
      installId: ID,
      name: "Notes",
      exec: ["/opt/Matrix OS/matrix-os", `matrixos://app/${ID}`],
      iconPath: "/home/me/.config/Matrix OS/installed-app-icons/x.png",
    });
    expect(entry).toBe([
      "[Desktop Entry]",
      "Type=Application",
      "Version=1.5",
      "Name=Notes",
      "Comment=A Matrix app",
      `Exec="/opt/Matrix OS/matrix-os" matrixos://app/${ID}`,
      "Icon=/home/me/.config/Matrix OS/installed-app-icons/x.png",
      "Terminal=false",
      "Categories=Utility;",
      "StartupNotify=false",
      `StartupWMClass=matrix-app-${ID}`,
      `X-Matrix-Install-Id=${ID}`,
      "",
    ].join("\n"));
  });

  it("leaves the icon to the theme when there is none", () => {
    const entry = buildDesktopEntry({ installId: ID, name: "Notes", exec: ["/opt/matrix"], iconPath: null });
    expect(entry).not.toContain("Icon=");
  });
});

describe("Linux launcher files", () => {
  let root: string;
  let applications: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-linux-launcher-"));
    applications = join(root, "share", "applications");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const launcher = () => createLinuxLauncher({ applicationsDir: applications, exec: ["/opt/matrix os/matrix-os"], scheme: "matrixos" });

  it("writes the entry atomically into the applications folder and leaves no temp file", async () => {
    const path = await launcher().write({ installId: ID, name: "Notes", iconPath: null });
    expect(path).toBe(join(applications, desktopEntryFileName(ID)));
    const text = await readFile(path, "utf8");
    expect(text).toContain(`Exec="/opt/matrix os/matrix-os" matrixos://app/${ID}`);
    expect(await readdir(applications)).toEqual([desktopEntryFileName(ID)]);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  });

  it("never overwrites an existing entry", async () => {
    await mkdir(applications, { recursive: true });
    await writeFile(join(applications, desktopEntryFileName(ID)), "owner's file");
    await expect(launcher().write({ installId: ID, name: "Notes", iconPath: null })).rejects.toThrow();
    expect(await readFile(join(applications, desktopEntryFileName(ID)), "utf8")).toBe("owner's file");
    expect(await readdir(applications)).toEqual([desktopEntryFileName(ID)]);
  });

  it("removes only its own entries in the applications folder", async () => {
    const path = await launcher().write({ installId: ID, name: "Notes", iconPath: null });
    const outside = join(root, "elsewhere.desktop");
    await writeFile(outside, "keep");
    await expect(launcher().remove(outside)).rejects.toThrow();
    await expect(launcher().remove(join(applications, "firefox.desktop"))).rejects.toThrow();
    await expect(launcher().remove(join(applications, "..", "applications", "..", "x", desktopEntryFileName(ID)))).rejects.toThrow();
    await launcher().remove(path);
    await expect(lstat(path)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("keep");
    // Already gone is fine.
    await launcher().remove(path);
  });

  it("does not follow a symlink planted at the entry path", async () => {
    await mkdir(applications, { recursive: true });
    const target = join(root, "target.txt");
    await writeFile(target, "keep");
    const path = join(applications, desktopEntryFileName(ID));
    await symlink(target, path);
    await expect(launcher().remove(path)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("keep");
  });
});
