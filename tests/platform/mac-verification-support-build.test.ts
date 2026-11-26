import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, link, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { installFreshMacVerificationElectron, prepareMacVerificationSupport, sealMacVerificationArchive, validateMacVerificationElectron } from "../../scripts/release/prepare-mac-verification-support.mjs";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-support-build-test-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "matrix-os", packageManager: "pnpm@10.33.4" }));
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(repo, "README.md"), "committed source\n");
  await symlink("README.md", join(repo, "source-link"));
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const baseSha = git("rev-parse", "HEAD");
  // Dirty checkout bytes and local secrets must not enter the shipped source.
  await writeFile(join(repo, "package.json"), "uncommitted build override");
  await writeFile(join(repo, ".env"), "PRIVATE_TEST_VALUE=never-package\n");
  await mkdir(join(repo, "node_modules")); await writeFile(join(repo, "node_modules/native.node"), "untracked native dependency payload");
  const pnpm = join(root, "pnpm"); await mkdir(join(pnpm, "bin"), { recursive: true });
  await writeFile(join(pnpm, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.4" }));
  await writeFile(join(pnpm, "bin/pnpm.cjs"), "throw new Error('fixture package manager must not run at build time');\n");
  const electron = join(root, "Electron.app"); await mkdir(join(electron, "Contents/MacOS"), { recursive: true });
  const binary = async (destination: string) => {
    if (process.platform === "darwin" && execFileSync("/usr/bin/lipo", ["-archs", process.execPath], { encoding: "utf8" }).trim().includes(" ")) {
      execFileSync("/usr/bin/lipo", [process.execPath, "-thin", process.arch === "x64" ? "x86_64" : process.arch, "-output", destination]);
    } else await copyFile(process.execPath, destination);
  };
  await binary(join(electron, "Contents/MacOS/Electron"));
  const framework = join(electron, "Contents/Frameworks/Electron Framework.framework");
  await mkdir(join(framework, "Versions/A/Resources"), { recursive: true });
  await writeFile(join(framework, "Versions/A/Resources/icudtl.dat"), "fixture ICU");
  await binary(join(framework, "Versions/A/Electron Framework"));
  for (const name of ["Helpers", "Libraries"]) await mkdir(join(framework, "Versions/A", name));
  await symlink("A", join(framework, "Versions/Current"));
  for (const name of ["Electron Framework", "Resources", "Helpers", "Libraries"]) await symlink(`Versions/Current/${name}`, join(framework, name));
  const prepare = () => prepareMacVerificationSupport({ repository: repo, output: join(root, "kit"), nodePath: process.execPath,
    pnpmEntry: join(pnpm, "bin/pnpm.cjs"), electronApp: electron, platform: "darwin", arch: process.arch });
  return { root, repo, pnpm, electron, baseSha, prepare };
}
test("packages exact committed source and pinned private tools without dependency CAS, dirty source or secrets", async () => {
  const f = await fixture();
  const out = join(f.root, "kit");
  await f.prepare();
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ version: 3, baseSha: f.baseSha, pnpmVersion: "10.33.4", platform: "darwin", arch: process.arch,
    nodeVersion: process.versions.node });
  expect(manifest.paths).toEqual({ checkout: "source.tar", node: "toolchain/node/bin/node", pnpm: "toolchain/pnpm/bin/pnpm.cjs",
    electron: "runtime/Electron.app/Contents/MacOS/Electron" });
  expect(Object.keys(manifest.archives)).toEqual(["checkout"]);
  expect((await readdir(out)).sort()).toEqual(["manifest.json", "runtime", "source.tar", "toolchain"]);
  await expect(lstat(join(out, "source"))).rejects.toMatchObject({ code: "ENOENT" });
  const unpackedSource = join(f.root, "unpacked-source"); await mkdir(unpackedSource);
  const archive = await readFile(join(out, manifest.paths.checkout));
  expect(manifest.archives.checkout).toMatchObject({ sha256: createHash("sha256").update(archive).digest("hex"), sizeBytes: archive.length });
  execFileSync("/usr/bin/tar", ["-xf", join(out, manifest.paths.checkout), "-C", unpackedSource, "--no-same-owner", "--no-same-permissions"]);
  expect(await readFile(join(unpackedSource, "package.json"), "utf8")).toContain('"matrix-os"');
  expect(manifest.lockfileSha256).toBe(createHash("sha256").update(await readFile(join(unpackedSource, "pnpm-lock.yaml"))).digest("hex"));
  expect(await readlink(join(unpackedSource, "source-link"))).toBe("README.md");
  expect(execFileSync("/usr/bin/git", ["status", "--porcelain"], { cwd: unpackedSource, encoding: "utf8" })).toBe("");
  await expect(readFile(join(unpackedSource, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(unpackedSource, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readlink(join(out, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current"))).toBe("A");
  expect(await readlink(join(out, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Resources"))).toBe("Versions/Current/Resources");
  expect(await readFile(join(out, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat"), "utf8")).toBe("fixture ICU");
  expect(await readFile(join(out, manifest.paths.pnpm), "utf8")).toContain("fixture");
  expect(execFileSync(join(out, manifest.paths.node), ["-p", "process.versions.node"], { encoding: "utf8" }).trim()).toBe(process.versions.node);
});
test.each(["Electron Framework", "Versions/Current", "Resources"])("rejects pnpm's flattened framework alias %s", async name => {
  const f = await fixture(); const alias = join(f.electron, "Contents/Frameworks/Electron Framework.framework", name);
  await validateMacVerificationElectron(f.electron, process.arch);
  await rm(alias); if (name === "Electron Framework") await copyFile(process.execPath, alias); else await mkdir(alias);
  await expect(f.prepare()).rejects.toThrow(/framework alias/);
});

test("runs the normal installer in an empty private package, never overwriting the cached dependency", async () => {
  for (const name of ["ELECTRON_SKIP_BINARY_DOWNLOAD", "ELECTRON_OVERRIDE_DIST_PATH", "electron_use_remote_checksums"]) vi.stubEnv(name, "unsafe-inherited-setting");
  const f = await fixture(); const pkg = join(f.root, "modules/electron"); await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "electron", version: "41.10.7" }));
  await writeFile(join(pkg, "checksums.json"), "{}");
  await mkdir(join(pkg, "dist")); await writeFile(join(pkg, "dist/owner-marker"), "retained cached input");
  await writeFile(join(pkg, "install.js"), `const fs=require('node:fs/promises'),path=require('node:path');(async()=>{
    if(process.env.ELECTRON_SKIP_BINARY_DOWNLOAD||process.env.ELECTRON_OVERRIDE_DIST_PATH||process.env.electron_use_remote_checksums)throw Error('unsafe environment');
    await fs.cp(${JSON.stringify(f.electron)},path.join(__dirname,'dist/Electron.app'),{recursive:true,verbatimSymlinks:true});
    await fs.writeFile(path.join(__dirname,'dist/version'),'41.10.7');await fs.writeFile(path.join(__dirname,'path.txt'),'Electron.app/Contents/MacOS/Electron');
  })().catch(e=>{console.error(e);process.exitCode=1});`);
  const installed = await installFreshMacVerificationElectron({ packageRoot: pkg, temporaryParent: f.root, arch: process.arch });
  try {
    expect(installed.app).not.toContain(pkg);
    expect(await readFile(join(pkg, "dist/owner-marker"), "utf8")).toBe("retained cached input");
    await expect(lstat(join(pkg, "path.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await validateMacVerificationElectron(installed.app, process.arch);
  } finally { await installed.cleanup(); }
  await expect(lstat(installed.app)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(pkg, "install.js"), "process.exit(1);");
  await expect(installFreshMacVerificationElectron({ packageRoot: pkg, temporaryParent: f.root, arch: process.arch })).rejects.toThrow();
  expect((await readdir(f.root)).filter(name => name.startsWith(".mac-verification-electron-"))).toEqual([]);
});
test("refuses an unpinned package manager before installing or publishing a kit", async () => {
  const f = await fixture(); await writeFile(join(f.pnpm, "package.json"), JSON.stringify({ name: "pnpm", version: "11.0.0" }));
  await expect(f.prepare()).rejects.toThrow(/pnpm/);
});

test("failed source archiving leaves no published kit or partial checkout", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside"), "outside source"); await symlink(join(f.root, "outside"), join(f.repo, "bad-link"));
  execFileSync("/usr/bin/git", ["add", "bad-link"], { cwd: f.repo });
  execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "unsafe source"], { cwd: f.repo });
  await expect(f.prepare()).rejects.toThrow("Unsafe verification archive link");
  expect((await readdir(f.root)).filter(name => name === "kit" || name.startsWith(".mac-verification-support-"))).toEqual([]);
});
test("manifest pin distinguishes missing development support from changed or symlinked resources", async () => {
  const { readMacVerificationSupportPin } = await import("../../scripts/release/mac-verification-support-pin.mjs");
  const root = await mkdtemp(join(tmpdir(), "matrix-support-pin-test-")); roots.push(root);
  expect(readMacVerificationSupportPin(root)).toBeNull();
  const path = join(root, "manifest.json"); await writeFile(path, '{"version":1}');
  const before = readMacVerificationSupportPin(root);
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(path, '{"version":2}'); expect(readMacVerificationSupportPin(root)).not.toBe(before);
  await rm(path); await writeFile(join(root, "other"), "{}"); await symlink(join(root, "other"), path);
  expect(() => readMacVerificationSupportPin(root)).toThrow();
});

test("uses pnpm lifecycle's actual package entry instead of a self-update PATH wrapper", async () => {
  const { readPnpmEntry } = await import("../../scripts/release/prepare-mac-verification-support.mjs");
  const entry = "/build/node_modules/.tools/pnpm/10.33.4/bin/pnpm.cjs";
  expect(await readPnpmEntry({ args: ["node", "prepare.mjs"], env: { npm_execpath: entry } })).toBe(entry);
  expect(await readPnpmEntry({ args: ["node", "prepare.mjs", "--pnpm", "/explicit/pnpm.cjs"], env: { npm_execpath: entry } })).toBe("/explicit/pnpm.cjs");
  await expect(readPnpmEntry({ args: ["node", "prepare.mjs"], env: {} })).rejects.toThrow(/pnpm run/);
});

test("seals only bounded files, rejecting links and preserving an existing archive destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "matrix-store-archive-test-")); roots.push(root);
  const store = join(root, "store"); await mkdir(store);
  const file = join(store, "package"); await writeFile(file, "package bytes");
  const archive = join(root, "store.tar");
  await symlink("package", join(store, "link"));
  await expect(sealMacVerificationArchive(store, archive)).rejects.toThrow("regular files");
  await rm(join(store, "link")); await link(file, join(store, "hardlink"));
  await expect(sealMacVerificationArchive(store, archive)).rejects.toThrow("regular files");
  await rm(join(store, "hardlink"));
  await writeFile(archive, "existing owner bytes");
  await expect(sealMacVerificationArchive(store, archive)).rejects.toThrow("exists");
  expect(await readFile(archive, "utf8")).toBe("existing owner bytes");
});


test("the Mac release refreshes pinned Electron through the lifecycle before compiling the kit pin", async () => {
  const { jobs } = parse(await readFile(join(process.cwd(), ".github/workflows/desktop-build.yml"), "utf8"));
  const steps = jobs.mac.steps as Array<{ name?: string; run?: string; env?: Record<string, string> }>;
  expect(jobs.mac["timeout-minutes"]).toBe(75);
  expect(steps.find(step => step.name === "Package desktop app")?.env).toEqual({
    DEBUG: "electron-notarize,electron-notarize:staple", DEBUG_COLORS: "0", DEBUG_HIDE_DATE: "0",
  });
  const prepare = steps.findIndex(step => step.name === "Prepare pinned Mac Verification support");
  expect(prepare).toBeGreaterThanOrEqual(0);
  expect(steps[prepare].run).toBe("pnpm run prepare:mac-verification-support --refresh-electron");
  expect(prepare).toBeLessThan(steps.findIndex(step => step.name === "Build desktop app"));
  const project = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
  expect(project.scripts["prepare:mac-verification-support"]).toBe("node scripts/release/prepare-mac-verification-support.mjs");
});
