import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacInstaller } from "@desktop/main/installed-apps/mac-installer";
import { createInstalledAppStore, MAX_INSTALLED_APPS } from "@desktop/main/installed-apps/record-store";

const CDHASH = "70319dee84e8125748db84fee5a36fceda50e82b";
// A stand-in for codesign's per-bundle hash: unique to the bundle that was signed.
const cdHashOf = (path: string) => createHash("sha1").update(path).digest("hex");

interface SignCall { args: string[]; files: string[]; entitlements: string | null; appsDirEntries: string[] }
const ICON = new Uint8Array(Buffer.from("icns-bytes"));
const app = (name = "Notes") => ({ appIdentity: "notes", slug: "notes", runtimeSlot: "primary", name });

describe("macOS installed-app installer", () => {
  let root: string;
  let appsDir: string;
  let loaderPath: string;
  let records: ReturnType<typeof createInstalledAppStore>;
  let forgetWindowState: ReturnType<typeof vi.fn>;
  let codesign: ReturnType<typeof vi.fn>;
  let signCalls: SignCall[];
  let fail: { sign?: boolean; verify?: boolean; noHash?: boolean };

  const installer = () => createMacInstaller({
    appsDir,
    records,
    host: { appPath: "/Applications/Matrix OS.app", bundleId: "com.matrix-os.operator", serverName: "matrix-stable", hostArguments: [], loaderPath },
    makeIcon: async () => ICON,
    codesign: codesign as never,
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
    signCalls = [];
    fail = {};
    codesign = vi.fn(async (file: string, args: string[], options: { signal: AbortSignal }) => {
      expect(file).toBe("/usr/bin/codesign");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const target = args.at(-1)!;
      const entitlementsAt = args.indexOf("--entitlements");
      signCalls.push({
        args,
        files: existsSync(target) ? await readdir(join(target, "Contents"), { recursive: true }) as string[] : [],
        entitlements: entitlementsAt >= 0 ? await readFile(args[entitlementsAt + 1]!, "utf8") : null,
        appsDirEntries: await readdir(appsDir),
      });
      if (args[0] === "--force" && fail.sign) throw new Error("codesign failed");
      if (args[0] === "--verify" && fail.verify) throw new Error("invalid signature");
      if (args[0] === "-dvvv") return { stdout: "", stderr: fail.noHash ? "code object is not signed at all" : `Identifier=x\nCDHash=${cdHashOf(target)}\n` };
      return { stdout: "", stderr: "" };
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("writes the whole bundle before moving it into place and records its path and cdhash", async () => {
    const record = await installer().install(app());
    const bundle = join(appsDir, "Notes.app");
    expect(record).toMatchObject({ name: "Notes", slug: "notes", bundlePath: bundle, cdHashes: [cdHashOf(signCalls[0]!.args.at(-1)!)],
      iconSha256: createHash("sha256").update(ICON).digest("hex") });
    expect(await records.get(record.installId)).toEqual(record);
    const plist = await readFile(join(bundle, "Contents/Info.plist"), "utf8");
    expect(plist).toContain(`<string>com.matrix-os.app.${record.installId}</string>`);
    expect(await readFile(join(bundle, "Contents/PkgInfo"), "utf8")).toBe("APPL????");
    expect(await readFile(join(bundle, "Contents/MacOS/app-shim"), "utf8")).toBe("loader-bytes");
    expect((await stat(join(bundle, "Contents/MacOS/app-shim"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(bundle, "Contents/Resources/app.icns"))).toEqual(Buffer.from(ICON));
    expect(await readdir(appsDir)).toEqual(["Notes.app"]);
  });

  it("signs the complete private bundle ad hoc with the hardened runtime, verifies it, then reads its hash, all before the move", async () => {
    const record = await installer().install(app());
    expect(signCalls.map((call) => call.args[0])).toEqual(["--force", "--verify", "-dvvv"]);
    const [sign, verify, describe] = signCalls;
    const temp = sign!.args.at(-1)!;
    expect(temp).toMatch(/\/\.matrix-app-tmp-[^/]+\/Shim\.app$/);
    expect(sign!.args.slice(0, 5)).toEqual(["--force", "--sign", "-", "--options", "runtime"]);
    // Only the entitlement that lets an ad-hoc shim load Matrix's team-signed framework.
    expect(sign!.entitlements).toContain("<key>com.apple.security.cs.disable-library-validation</key>");
    expect(sign!.entitlements!.match(/<key>/g)).toHaveLength(1);
    expect(sign!.files).toEqual(expect.arrayContaining(["Info.plist", "PkgInfo", "MacOS/app-shim", "Resources/app.icns"]));
    expect(verify!.args).toEqual(["--verify", "--strict", temp]);
    expect(describe!.args).toEqual(["-dvvv", temp]);
    // Nothing was in place, and nothing is signed after the move (macOS forbids edits after first launch).
    for (const call of signCalls) expect(call.appsDirEntries.every((name) => name.startsWith(".matrix-app-tmp-"))).toBe(true);
    expect(codesign).toHaveBeenCalledTimes(3);
    expect(signCalls.some((call) => call.args.includes(record.bundlePath!))).toBe(false);
  });

  it("records each bundle's own cdhash", async () => {
    const first = await installer().install(app());
    const second = await installer().install(app());
    expect(first.cdHashes).toHaveLength(1);
    expect(second.cdHashes).toHaveLength(1);
    expect(first.cdHashes[0]).not.toBe(second.cdHashes[0]);
  });

  it.each([["signing", "sign"], ["verification", "verify"]] as const)(
    "aborts the install and leaves nothing behind when %s fails", async (_label, step) => {
      fail[step] = true;
      await expect(installer().install(app())).rejects.toThrow();
      expect(await readdir(appsDir)).toEqual([]);
      expect(await records.list()).toEqual([]);
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
    fail.noHash = true;
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
