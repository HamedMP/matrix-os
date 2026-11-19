import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareMacVerificationSupport } from "../../scripts/release/prepare-mac-verification-support.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-support-build-test-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "matrix-os", packageManager: "pnpm@10.33.4" }));
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const baseSha = git("rev-parse", "HEAD");
  // Dirty checkout bytes and local secrets must not enter the shipped source.
  await writeFile(join(repo, "package.json"), "uncommitted build override");
  await writeFile(join(repo, ".env"), "PRIVATE_TEST_VALUE=never-package\n");
  const pnpm = join(root, "pnpm"); await mkdir(join(pnpm, "bin"), { recursive: true });
  await writeFile(join(pnpm, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.4" }));
  await writeFile(join(pnpm, "bin/pnpm.cjs"), "// fixture\n");
  const electron = join(root, "Electron.app"); await mkdir(join(electron, "Contents/MacOS"), { recursive: true });
  await writeFile(join(electron, "Contents/MacOS/Electron"), "fixture");
  const framework = join(electron, "Contents/Frameworks/Electron Framework.framework");
  await mkdir(join(framework, "Versions/A/Resources"), { recursive: true });
  await writeFile(join(framework, "Versions/A/Resources/icudtl.dat"), "fixture ICU");
  await symlink("A", join(framework, "Versions/Current"));
  await symlink("Versions/Current/Resources", join(framework, "Resources"));
  return { root, repo, pnpm, electron, baseSha };
}
test("packages exact committed source and pinned private tools, never dirty source or secrets", async () => {
  const f = await fixture(); const calls: string[][] = [];
  const out = join(f.root, "kit");
  await prepareMacVerificationSupport({ repository: f.repo, output: out, nodePath: process.execPath,
    pnpmEntry: join(f.pnpm, "bin/pnpm.cjs"), electronApp: f.electron, platform: "darwin", arch: process.arch,
    install: async (node: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      calls.push([node, ...args]);
      expect(options.env.npm_config_userconfig).toBe("/dev/null");
      await mkdir(join(options.cwd, "node_modules"));
      const { symlink } = await import("node:fs/promises");
      const store = args[args.indexOf("--store-dir") + 1];
      await mkdir(join(store, "v10/projects"), { recursive: true });
      await symlink("../../../source", join(store, "v10/projects/build-checkout"));
      await mkdir(join(store, "v10/files"), { recursive: true });
      await writeFile(join(store, "v10/files/offline-package"), "retained package bytes");
    } });
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ version: 1, baseSha: f.baseSha, pnpmVersion: "10.33.4", platform: "darwin" });
  expect(await readFile(join(out, "source/package.json"), "utf8")).toContain('"matrix-os"');
  await expect(readFile(join(out, "source/.env"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(out, "source/node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(out, "pnpm-store/v10/projects/build-checkout"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(out, "pnpm-store/v10/files/offline-package"), "utf8")).toBe("retained package bytes");
  expect(await readlink(join(out, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current"))).toBe("A");
  expect(await readlink(join(out, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Resources"))).toBe("Versions/Current/Resources");
  expect(await readFile(join(out, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat"), "utf8")).toBe("fixture ICU");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(expect.arrayContaining(["--frozen-lockfile", "--ignore-scripts", "--store-dir"]));
  expect(await readFile(join(out, manifest.paths.pnpm), "utf8")).toContain("fixture");
});
test("refuses an unpinned package manager before installing or publishing a kit", async () => {
  const f = await fixture(); await writeFile(join(f.pnpm, "package.json"), JSON.stringify({ name: "pnpm", version: "11.0.0" }));
  await expect(prepareMacVerificationSupport({ repository: f.repo, output: join(f.root, "kit"), nodePath: process.execPath,
    pnpmEntry: join(f.pnpm, "bin/pnpm.cjs"), electronApp: f.electron, platform: "darwin", arch: process.arch,
    install: async () => { throw new Error("must not install"); } })).rejects.toThrow(/pnpm/);
});

test("failed dependency preparation leaves no published kit or partial checkout", async () => {
  const f = await fixture();
  const out = join(f.root, "kit");
  await expect(prepareMacVerificationSupport({ repository: f.repo, output: out, nodePath: process.execPath,
    pnpmEntry: join(f.pnpm, "bin/pnpm.cjs"), electronApp: f.electron, platform: "darwin", arch: process.arch,
    install: async () => { throw new Error("bounded preparation failed"); } })).rejects.toThrow("bounded preparation failed");
  const { readdir } = await import("node:fs/promises");
  expect((await readdir(f.root)).filter(name => name === "kit" || name.startsWith(".mac-verification-support-"))).toEqual([]);
});
test("manifest pin distinguishes missing development support from changed or symlinked resources", async () => {
  const { readMacVerificationSupportPin } = await import("../../scripts/release/mac-verification-support-pin.mjs");
  const { symlink } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "matrix-support-pin-test-")); roots.push(root);
  expect(readMacVerificationSupportPin(root)).toBeNull();
  const path = join(root, "manifest.json"); await writeFile(path, '{"version":1}');
  const before = readMacVerificationSupportPin(root);
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(path, '{"version":2}'); expect(readMacVerificationSupportPin(root)).not.toBe(before);
  await rm(path); await writeFile(join(root, "other"), "{}"); await symlink(join(root, "other"), path);
  expect(() => readMacVerificationSupportPin(root)).toThrow();
});
