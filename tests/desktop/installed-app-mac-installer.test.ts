import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacInstaller } from "@desktop/main/installed-apps/mac-installer";
import { createInstalledAppStore, MAX_INSTALLED_APPS } from "@desktop/main/installed-apps/record-store";

const CDHASH = "70319dee84e8125748db84fee5a36fceda50e82b";
// A stand-in for codesign's per-bundle hash: it follows the sealed Info.plist, so it
// is unique per install and unchanged by the move into place.
const cdHashOf = (text: string) => createHash("sha1").update(text).digest("hex");
const bundleHash = async (bundle: string) => cdHashOf(await readFile(join(bundle, "Contents/Info.plist"), "utf8"));

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
  let fail: { sign?: boolean; verify?: boolean; noHash?: boolean; otherHash?: boolean };
  let livePids: Set<number>;

  const installer = () => createMacInstaller({
    isProcessAlive: (pid) => livePids.has(pid),
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
    livePids = new Set([process.pid]);
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
      if (args[0] === "-dvvv") {
        if (fail.noHash) return { stdout: "", stderr: "code object is not signed at all" };
        const hash = fail.otherHash ? cdHashOf("another bundle") : await bundleHash(target);
        return { stdout: "", stderr: `Identifier=x\nCDHash=${hash}\n` };
      }
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
    expect(record).toMatchObject({ name: "Notes", slug: "notes", bundlePath: bundle, cdHashes: [await bundleHash(bundle)],
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
    // The temp folder names its owner (channel server and pid), so other channels' sweeps leave it alone.
    expect(temp).toMatch(new RegExp(`/\\.matrix-app-tmp-matrix-stable-${process.pid}-[^/]+/Shim\\.app$`));
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

  it("checks the bundle on disk is this install before deleting it", async () => {
    const record = await installer().install(app());
    signCalls = [];
    expect(await installer().uninstall(record.installId)).toBe(true);
    expect(signCalls.map((call) => call.args)).toEqual([["-dvvv", record.bundlePath!]]);
  });

  it.each([
    ["another install's bundle identifier", async (bundle: string, installId: string) => {
      const plist = join(bundle, "Contents/Info.plist");
      await writeFile(plist, (await readFile(plist, "utf8")).replace(installId, "0b6f7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"));
    }],
    ["another bundle's code signature", async () => { fail.otherHash = true; }],
    ["no Info.plist", async (bundle: string) => { await rm(join(bundle, "Contents/Info.plist")); }],
  ])("keeps a bundle at the recorded path that has %s, and drops only the stale record", async (_label, change) => {
    const record = await installer().install(app());
    await change(record.bundlePath!, record.installId);
    expect(await installer().uninstall(record.installId)).toBe(true);
    expect((await stat(join(record.bundlePath!, "Contents"))).isDirectory()).toBe(true);
    expect(await records.get(record.installId)).toBeNull();
    expect(forgetWindowState).toHaveBeenCalledWith(record.installId);
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

  it("sweeps only temp folders that cannot be another channel's install in progress", async () => {
    await installer().install(app());
    const target = join(root, "target");
    await mkdir(target);
    const old = new Date(Date.now() - 20 * 60_000);
    const temp = async (name: string, stale = false) => {
      await mkdir(join(appsDir, name, "Shim.app"), { recursive: true });
      if (stale) await utimes(join(appsDir, name), old, old);
    };
    livePids.add(4242);
    await temp(".matrix-app-tmp-matrix-stable-999991-crashA");      // ours, left by a crashed run
    await temp(`.matrix-app-tmp-matrix-stable-${process.pid}-liveAB`); // ours, this process: in flight
    await temp(".matrix-app-tmp-matrix-canary-4242-freshA");         // Canary, running, fresh
    await temp(".matrix-app-tmp-matrix-canary-4242-oldAAA", true);   // Canary, running, slow
    await temp(".matrix-app-tmp-matrix-canary-999992-newAAA");       // Canary, dead, but fresh
    await temp(".matrix-app-tmp-matrix-canary-999993-deadAA", true); // Canary, dead and stale
    await temp(".matrix-app-tmp-legacy", true);                      // no owner, stale
    await temp(".matrix-app-tmp-legac2");                            // no owner, fresh
    await symlink(target, join(appsDir, ".matrix-app-tmp-matrix-stable-999994-linkAA"));
    await mkdir(join(appsDir, "Empty.app"));
    await mkdir(join(appsDir, "Folder"));
    await installer().sweep();
    expect((await readdir(appsDir)).sort()).toEqual([
      ".matrix-app-tmp-legac2",
      ".matrix-app-tmp-matrix-canary-4242-freshA",
      ".matrix-app-tmp-matrix-canary-4242-oldAAA",
      ".matrix-app-tmp-matrix-canary-999992-newAAA",
      `.matrix-app-tmp-matrix-stable-${process.pid}-liveAB`,
      ".matrix-app-tmp-matrix-stable-999994-linkAA",
      "Folder",
      "Notes.app",
    ].sort());
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("sweeps nothing when the Matrix Apps folder does not exist", async () => {
    await expect(installer().sweep()).resolves.toBeUndefined();
  });

  it("prunes a record whose path now holds another install's bundle, keeping that bundle", async () => {
    const moved = await installer().install(app());
    await rename(moved.bundlePath!, join(root, "Moved Notes.app"));
    const current = await installer().install(app());
    expect(current.bundlePath).toBe(moved.bundlePath);
    expect(await installer().prune()).toEqual([moved.installId]);
    expect((await records.list()).map((record) => record.installId)).toEqual([current.installId]);
    expect(forgetWindowState).toHaveBeenCalledWith(moved.installId);
    expect((await stat(join(current.bundlePath!, "Contents"))).isDirectory()).toBe(true);
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
