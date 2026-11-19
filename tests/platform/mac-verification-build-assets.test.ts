import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { installFreshMacVerificationElectron, sealMacVerificationArchive, validateMacVerificationElectron } from "../../scripts/release/mac-verification-build-assets.mjs";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "matrix-build-assets-")); roots.push(root);
  const app = join(root, "Electron.app"); await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
  await mkdir(join(framework, "Versions/A/Resources"), { recursive: true });
  const binary = async (path: string) => {
    if (process.platform === "darwin" && execFileSync("/usr/bin/lipo", ["-archs", process.execPath], { encoding: "utf8" }).trim().includes(" ")) {
      execFileSync("/usr/bin/lipo", [process.execPath, "-thin", process.arch === "x64" ? "x86_64" : process.arch, "-output", path]);
    } else await copyFile(process.execPath, path);
  };
  await binary(join(app, "Contents/MacOS/Electron")); await binary(join(framework, "Versions/A/Electron Framework"));
  for (const name of ["Helpers", "Libraries"]) await mkdir(join(framework, "Versions/A", name));
  await symlink("A", join(framework, "Versions/Current"));
  for (const name of ["Electron Framework", "Resources", "Helpers", "Libraries"]) await symlink(`Versions/Current/${name}`, join(framework, name));
  return { root, app, framework };
}

test.each(["Electron Framework", "Versions/Current", "Resources"])("rejects the flattened framework alias %s before copying/signing", async name => {
  const f = await fixture(); await validateMacVerificationElectron(f.app, process.arch);
  const path = join(f.framework, name); await rm(path);
  if (name === "Electron Framework") await copyFile(process.execPath, path); else await mkdir(path);
  await expect(validateMacVerificationElectron(f.app, process.arch)).rejects.toThrow("framework alias");
});

test("normal installer uses a disposable projection and ignores inherited binary overrides", async () => {
  const f = await fixture(); const pkg = join(f.root, "modules/electron"); await mkdir(join(pkg, "dist"), { recursive: true });
  for (const name of ["ELECTRON_SKIP_BINARY_DOWNLOAD", "ELECTRON_OVERRIDE_DIST_PATH", "electron_use_remote_checksums"]) vi.stubEnv(name, "untrusted");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "electron", version: "41.10.7" }));
  await writeFile(join(pkg, "checksums.json"), "{}"); await writeFile(join(pkg, "dist/owner"), "retained");
  await writeFile(join(pkg, "install.js"), `const fs=require('node:fs/promises'),path=require('node:path');(async()=>{
    if(process.env.ELECTRON_SKIP_BINARY_DOWNLOAD||process.env.ELECTRON_OVERRIDE_DIST_PATH||process.env.electron_use_remote_checksums)throw Error('unsafe');
    await fs.cp(${JSON.stringify(f.app)},path.join(__dirname,'dist/Electron.app'),{recursive:true,verbatimSymlinks:true});
    await fs.writeFile(path.join(__dirname,'dist/version'),'41.10.7');await fs.writeFile(path.join(__dirname,'path.txt'),'Electron.app/Contents/MacOS/Electron');
  })().catch(e=>{console.error(e);process.exitCode=1});`);
  const fresh = await installFreshMacVerificationElectron({ packageRoot: pkg, temporaryParent: f.root, arch: process.arch });
  try {
    expect(fresh.app).not.toContain(pkg); await validateMacVerificationElectron(fresh.app, process.arch);
    expect(await readFile(join(pkg, "dist/owner"), "utf8")).toBe("retained");
    await expect(lstat(join(pkg, "path.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fresh.cleanup(); }
  await expect(lstat(fresh.app)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(pkg, "install.js"), "process.exit(1);");
  await expect(installFreshMacVerificationElectron({ packageRoot: pkg, temporaryParent: f.root, arch: process.arch })).rejects.toThrow();
  expect((await readdir(f.root)).filter(name => name.startsWith(".mac-verification-electron-"))).toEqual([]);
});

test("archive validation rejects external links and preserves an exclusively owned destination", async () => {
  const f = await fixture(); const source = join(f.root, "source"); await mkdir(source);
  await writeFile(join(source, "file"), "source"); await symlink("../outside", join(source, "link"));
  await writeFile(join(f.root, "outside"), "owner");
  const destination = join(f.root, "source.tar");
  await expect(sealMacVerificationArchive(source, destination, { allowSymlinks: true })).rejects.toThrow("archive link");
  await rm(join(source, "link")); await writeFile(destination, "existing");
  await expect(sealMacVerificationArchive(source, destination)).rejects.toThrow("exists");
  expect(await readFile(destination, "utf8")).toBe("existing");
});
