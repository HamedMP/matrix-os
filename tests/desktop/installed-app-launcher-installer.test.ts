import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLauncherInstaller, type LauncherPlatform } from "../../desktop/src/main/installed-apps/launcher-installer";
import { createInstalledAppStore, InstalledAppLimitError, MAX_INSTALLED_APPS } from "../../desktop/src/main/installed-apps/record-store";

const REQUEST = { appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name: "Notes" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe("installed app launcher installer (Windows and Linux)", () => {
  let root: string;
  let launchers: string;
  let icons: string;
  let forget: ReturnType<typeof vi.fn<(installId: string) => Promise<void>>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "matrix-launcher-installer-"));
    launchers = join(root, "launchers");
    icons = join(root, "icons");
    forget = vi.fn(async () => undefined);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // A launcher that writes `<installId>.launcher` files, like the real ones do.
  function fakeLauncher(overrides: Partial<LauncherPlatform> = {}): LauncherPlatform {
    return {
      iconExtension: "ico",
      encodeIcon: (png) => new Uint8Array([9, ...png]),
      async write({ installId, name, iconPath }) {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(launchers, { recursive: true });
        const path = join(launchers, `${installId}.launcher`);
        await writeFile(path, JSON.stringify({ name, iconPath }), { flag: "wx" });
        return path;
      },
      async remove(path) {
        await rm(path, { force: true });
      },
      ...overrides,
    };
  }

  const setup = (launcher = fakeLauncher(), icon: Uint8Array | null = PNG) => {
    const records = createInstalledAppStore({ dir: root });
    const installer = createLauncherInstaller({
      records, iconsDir: icons, launcher, fetchIcon: async () => icon, forgetWindowState: forget,
    });
    return { records, installer };
  };

  it("writes the icon, the launcher and the record", async () => {
    const { records, installer } = setup();
    const record = await installer.install(REQUEST);
    expect(record).toEqual(expect.objectContaining({ ...REQUEST, cdHashes: [] }));
    const iconPath = join(icons, `${record.installId}.ico`);
    expect(installer.iconPath(record)).toBe(iconPath);
    expect(Array.from(await readFile(iconPath))).toEqual([9, ...PNG]);
    expect(record.iconSha256).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(record.bundlePath).toBe(join(launchers, `${record.installId}.launcher`));
    expect(JSON.parse(await readFile(record.bundlePath!, "utf8"))).toEqual({ name: "Notes", iconPath });
    expect(await records.list()).toEqual([record]);
  });

  it("uses no icon file when the app has none", async () => {
    const { installer } = setup(fakeLauncher(), null);
    const record = await installer.install(REQUEST);
    expect(installer.iconPath(record)).toBeNull();
    expect(JSON.parse(await readFile(record.bundlePath!, "utf8")).iconPath).toBeNull();
    await expect(readdir(icons)).rejects.toThrow();
  });

  it("rolls back the icon when the launcher cannot be written", async () => {
    const { records, installer } = setup(fakeLauncher({ write: async () => { throw new Error("EACCES /secret/path"); } }));
    await expect(installer.install(REQUEST)).rejects.toThrow();
    expect(await readdir(icons)).toEqual([]);
    expect(await records.list()).toEqual([]);
  });

  it("rolls back the launcher and icon when the record cannot be written", async () => {
    const { records, installer } = setup();
    vi.spyOn(records, "create").mockRejectedValueOnce(new InstalledAppLimitError());
    await expect(installer.install(REQUEST)).rejects.toBeInstanceOf(InstalledAppLimitError);
    expect(await readdir(icons)).toEqual([]);
    expect(await readdir(launchers)).toEqual([]);
  });

  it("refuses past the install cap before writing anything", async () => {
    const { records, installer } = setup();
    vi.spyOn(records, "list").mockResolvedValueOnce(Array.from({ length: MAX_INSTALLED_APPS }, () => ({}) as never));
    await expect(installer.install(REQUEST)).rejects.toBeInstanceOf(InstalledAppLimitError);
    await expect(readdir(icons)).rejects.toThrow();
  });

  it("rejects a request that is not a catalog app", async () => {
    const { installer } = setup();
    await expect(installer.install({ ...REQUEST, slug: "../evil" })).rejects.toThrow();
  });

  it("uninstalls the launcher, its icon, the record and window state, and nothing else", async () => {
    const { records, installer } = setup();
    const kept = await installer.install({ ...REQUEST, slug: "pomodoro", appIdentity: "pomodoro", name: "Pomodoro" });
    const record = await installer.install(REQUEST);
    expect(await installer.uninstall(record.installId)).toBe(true);
    expect(await records.list()).toEqual([kept]);
    expect(await readdir(icons)).toEqual([`${kept.installId}.ico`]);
    expect(await readdir(launchers)).toEqual([`${kept.installId}.launcher`]);
    expect(forget).toHaveBeenCalledWith(record.installId);
    expect(await installer.uninstall(record.installId)).toBe(false);
    expect(await installer.uninstall("not-an-id")).toBe(false);
  });

  it("keeps the record when its launcher cannot be removed", async () => {
    const { records, installer } = setup(fakeLauncher({ remove: async () => { throw new Error("outside"); } }));
    const record = await installer.install(REQUEST);
    await expect(installer.uninstall(record.installId)).rejects.toThrow();
    expect(await records.list()).toEqual([record]);
  });

  it("prunes installs whose launcher the owner deleted", async () => {
    const { records, installer } = setup();
    const gone = await installer.install(REQUEST);
    const kept = await installer.install({ ...REQUEST, slug: "pomodoro", appIdentity: "pomodoro", name: "Pomodoro" });
    await rm(gone.bundlePath!);
    expect(await installer.prune()).toEqual([gone.installId]);
    expect(await records.list()).toEqual([kept]);
    expect(await readdir(icons)).toEqual([`${kept.installId}.ico`]);
    expect(forget).toHaveBeenCalledWith(gone.installId);
  });
});
