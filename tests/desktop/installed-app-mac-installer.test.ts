import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacInstaller } from "@desktop/main/installed-apps/mac-installer";
import { createInstalledAppStore, MAX_INSTALLED_APPS } from "@desktop/main/installed-apps/record-store";

const CDHASH = "70319dee84e8125748db84fee5a36fceda50e82b";
const ICON = new Uint8Array(Buffer.from("icns-bytes"));
const app = (name = "Notes") => ({ appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name });

describe("macOS installed-app installer", () => {
  let root: string;
  let appsDir: string;
  let loaderPath: string;
  let records: ReturnType<typeof createInstalledAppStore>;
  let forgetWindowState: ReturnType<typeof vi.fn>;
  let readCdHashes: ReturnType<typeof vi.fn>;

  const installer = () => createMacInstaller({
    appsDir,
    records,
    host: { appPath: "/Applications/Matrix OS.app", bundleId: "com.matrix-os.operator", serverName: "matrix-stable", hostArguments: [], loaderPath },
    makeIcon: async () => ICON,
    readCdHashes,
    forgetWindowState,
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Canonical, as recorded paths are: macOS's temp folder sits behind /var -> /private/var.
    root = await realpath(await mkdtemp(join(tmpdir(), "mac-installer-")));
    appsDir = join(root, "Applications", "Matrix Apps");
    loaderPath = join(root, "app_shim_loader");
    await writeFile(loaderPath, "loader-bytes", { mode: 0o755 });
    records = createInstalledAppStore({ dir: join(root, "userData") });
    forgetWindowState = vi.fn(async () => undefined);
    readCdHashes = vi.fn(async () => [CDHASH]);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("writes the whole bundle before moving it into place and records its path and cdhash", async () => {
    const record = await installer().install(app());
    const bundle = join(appsDir, "Notes.app");
    expect(record).toMatchObject({ name: "Notes", slug: "notes", bundlePath: bundle, cdHashes: [CDHASH],
      iconSha256: createHash("sha256").update(ICON).digest("hex") });
    expect(await records.get(record.installId)).toEqual(record);
    const plist = await readFile(join(bundle, "Contents/Info.plist"), "utf8");
    expect(plist).toContain(`<string>com.matrix-os.app.${record.installId}</string>`);
    expect(await readFile(join(bundle, "Contents/PkgInfo"), "utf8")).toBe("APPL????");
    expect(await readFile(join(bundle, "Contents/MacOS/app-shim"), "utf8")).toBe("loader-bytes");
    expect((await stat(join(bundle, "Contents/MacOS/app-shim"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(bundle, "Contents/Resources/app.icns"))).toEqual(Buffer.from(ICON));
    // The hash is read from the executable before the move, while the bundle is still private.
    expect(String(readCdHashes.mock.calls[0]![0])).toContain(".matrix-app-tmp-");
    expect(await readdir(appsDir)).toEqual(["Notes.app"]);
  });

  it("never overwrites an existing path: it numbers the next bundle instead", async () => {
    await mkdir(appsDir, { recursive: true });
    await writeFile(join(appsDir, "Notes.app"), "someone else's file");
    const first = await installer().install(app());
    const second = await installer().install(app());
    expect(first.bundlePath).toBe(join(appsDir, "Notes 2.app"));
    expect(second.bundlePath).toBe(join(appsDir, "Notes 3.app"));
    expect(await readFile(join(appsDir, "Notes.app"), "utf8")).toBe("someone else's file");
  });

  it("names a look-alike of Matrix or a system app as a Matrix App", async () => {
    const record = await installer().install(app("Mаtrix Settings"));
    expect(record.bundlePath).toBe(join(appsDir, "Mаtrix Settings (Matrix App).app"));
    expect(record.name).toBe("Mаtrix Settings");
  });

  it("refuses an install whose shim has no signature to pin, and leaves nothing behind", async () => {
    readCdHashes.mockResolvedValue([]);
    await expect(installer().install(app())).rejects.toThrow();
    expect(await readdir(appsDir)).toEqual([]);
    expect(await records.list()).toEqual([]);
  });

  it("removes the bundle and its reservation when the record cannot be written", async () => {
    for (let index = 0; index < MAX_INSTALLED_APPS; index += 1) {
      await records.create({ ...app(), iconSha256: "a".repeat(64), bundlePath: null, cdHashes: [] });
    }
    await expect(installer().install(app())).rejects.toThrow("Install limit reached");
    // Refused before the Matrix Apps folder is even created.
    await expect(readdir(appsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to install into a Matrix Apps folder that is a symlink", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(join(root, "Applications"));
    await symlink(elsewhere, appsDir);
    await expect(installer().install(app())).rejects.toThrow();
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("records the real bundle path, which is what a launched shim reports, behind a symlinked parent", async () => {
    // macOS: /tmp is /private/tmp, and a home folder can live behind a link too.
    const real = join(root, "real");
    await mkdir(join(real, "Matrix Apps"), { recursive: true });
    await symlink(real, join(root, "linked"));
    appsDir = join(root, "linked", "Matrix Apps");
    const record = await installer().install(app());
    expect(record.bundlePath).toBe(join(real, "Matrix Apps", "Notes.app"));
    expect(await installer().uninstall(record.installId)).toBe(true);
    expect(await readdir(join(real, "Matrix Apps"))).toEqual([]);
  });

  it("uninstalls the bundle, the record and the saved window state", async () => {
    const record = await installer().install(app());
    expect(await installer().uninstall(record.installId)).toBe(true);
    await expect(lstat(record.bundlePath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await records.get(record.installId)).toBeNull();
    expect(forgetWindowState).toHaveBeenCalledWith(record.installId);
    expect(await installer().uninstall(record.installId)).toBe(false);
  });

  it("uninstalls a record whose bundle the owner already deleted", async () => {
    const record = await installer().install(app());
    await rm(record.bundlePath!, { recursive: true });
    expect(await installer().uninstall(record.installId)).toBe(true);
    expect(await records.get(record.installId)).toBeNull();
  });

  it.each([
    ["outside the Matrix Apps folder", (dir: string) => join(dir, "..", "Notes.app")],
    ["nested inside another bundle", (dir: string) => join(dir, "Other.app", "Notes.app")],
    ["not a bundle", (dir: string) => join(dir, "Notes")],
  ])("refuses to delete a recorded path %s", async (_label, path) => {
    const target = path(appsDir);
    await mkdir(target, { recursive: true });
    const record = await records.create({ ...app(), iconSha256: "a".repeat(64), bundlePath: target, cdHashes: [CDHASH] });
    await expect(installer().uninstall(record.installId)).rejects.toThrow();
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await records.get(record.installId)).not.toBeNull();
  });

  it("refuses to follow a bundle path that became a symlink", async () => {
    const record = await installer().install(app());
    const victim = join(root, "victim");
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "data");
    await rm(record.bundlePath!, { recursive: true });
    await symlink(victim, record.bundlePath!);
    await expect(installer().uninstall(record.installId)).rejects.toThrow();
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("data");
  });

  it("sweeps leftover temp bundles and empty reservations, but nothing else", async () => {
    await installer().install(app());
    const target = join(root, "target");
    await mkdir(target);
    await mkdir(join(appsDir, ".matrix-app-tmp-abc", "Contents"), { recursive: true });
    await symlink(target, join(appsDir, ".matrix-app-tmp-link"));
    await mkdir(join(appsDir, "Empty.app"));
    await mkdir(join(appsDir, "Folder"));
    await installer().sweep();
    expect((await readdir(appsDir)).sort()).toEqual([".matrix-app-tmp-link", "Folder", "Notes.app"]);
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("sweeps nothing when the Matrix Apps folder does not exist", async () => {
    await expect(installer().sweep()).resolves.toBeUndefined();
  });

  it("prunes records whose bundle was moved or deleted", async () => {
    const kept = await installer().install(app());
    const gone = await installer().install(app("Weather"));
    const shortcutOnly = await records.create({ ...app("Plain"), iconSha256: "a".repeat(64), bundlePath: null, cdHashes: [] });
    await rm(gone.bundlePath!, { recursive: true });
    expect(await installer().prune()).toEqual([gone.installId]);
    expect((await records.list()).map((record) => record.installId).sort()).toEqual([kept.installId, shortcutOnly.installId].sort());
    expect(forgetWindowState).toHaveBeenCalledWith(gone.installId);
  });
});
