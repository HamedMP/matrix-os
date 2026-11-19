import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMacVerificationSourceProvider } from "@desktop/main/chat-electron-preview/source-provider";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const paths = { checkout: "source", node: "toolchain/node/bin/node", pnpm: "toolchain/pnpm/bin/pnpm.cjs",
  electron: "runtime/Electron.app/Contents/MacOS/Electron", store: "pnpm-store" };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-source-provider-"))); roots.push(root);
  const kit = join(root, "resources", "mac-verification-support");
  const profile = join(root, "profile");
  const source = join(kit, paths.checkout);
  await mkdir(source, { recursive: true });
  await mkdir(profile, { mode: 0o700 });
  await writeFile(join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: source, encoding: "utf8" }).trim();
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
  for (const path of [paths.node, paths.pnpm, paths.electron]) {
    await mkdir(dirname(join(kit, path)), { recursive: true });
    await writeFile(join(kit, path), path === paths.node
      ? '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.18.0; else echo 10.33.4; fi\n' : "fixture\n");
    await chmod(join(kit, path), 0o755);
  }
  await mkdir(join(kit, paths.store), { recursive: true });
  await writeFile(join(kit, paths.store, "package"), "offline content");
  const manifest = { version: 1, baseSha: git("rev-parse", "HEAD"), nodeVersion: "24.18.0", pnpmVersion: "10.33.4",
    platform: "darwin", arch: "arm64", lockfileSha256: createHash("sha256").update(await readFile(join(source, "pnpm-lock.yaml"))).digest("hex"), paths };
  await writeFile(join(kit, "manifest.json"), JSON.stringify(manifest));
  const expectedManifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const provider = createMacVerificationSourceProvider({ resourcesPath: join(root, "resources"), userData: profile,
    platform: "darwin", arch: "arm64", expectedManifestSha256 });
  return { kit, profile, source, manifest, provider, expectedManifestSha256, signal: new AbortController().signal,
    async setManifest(next: unknown) {
      const bytes = JSON.stringify(next); await writeFile(join(kit, "manifest.json"), bytes);
      return createMacVerificationSourceProvider({ resourcesPath: dirname(kit), userData: profile,
        platform: "darwin", arch: "arm64", expectedManifestSha256: createHash("sha256").update(bytes).digest("hex") });
    },
  };
}

describe("packaged Mac Verification source preparation", () => {
  it("rejects pnpm support-module links outside the packaged toolchain before executing pnpm", async () => {
    const f = await fixture();
    await symlink(tmpdir(), join(f.kit, "toolchain/pnpm/external"));
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
  });

  it("rejects a preview Electron framework link that escapes the packaged runtime bundle", async () => {
    const f = await fixture();
    const framework = join(f.kit, "runtime/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions");
    await mkdir(framework, { recursive: true });
    await symlink(tmpdir(), join(framework, "Current"));
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal).then(async prepared => {
      await prepared.release(); return prepared;
    })).rejects.toThrow("support-unavailable");
  });

  it("requires the manifest pin compiled into the app and reports missing runtime support safely", async () => {
    const f = await fixture();
    await writeFile(join(f.kit, "manifest.json"), JSON.stringify(f.manifest) + " ");
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    await f.setManifest(f.manifest);
    await rm(join(f.kit, paths.node));
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
  });

  it("recovers a dead preparation writer and refuses live process records", async () => {
    const f = await fixture();
    const workspace = join(f.profile, "mac-verification-support");
    await mkdir(workspace, { mode: 0o700 });
    const lock = join(workspace, "preparation.lock");
    await writeFile(lock, JSON.stringify({ pid: 2147483647, token: "00000000-0000-4000-8000-000000000001", createdAt: Date.now() - 1000 }), { mode: 0o600 });
    const recovered = await f.provider.prepare(f.manifest.baseSha, f.signal);
    expect(await readFile(lock, "utf8")).toContain(String(process.pid));
    await recovered.release();
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "00000000-0000-4000-8000-000000000002", createdAt: 0 }), { mode: 0o600 });
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("busy");
  });

  it("prepares the exact candidate without a folder picker, network, or changes to the bundled source", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepare(f.manifest.baseSha, f.signal);
    expect(prepared.checkout).not.toBe(f.source);
    expect(prepared.toolchain.node).toBe(join(f.kit, paths.node));
    expect(prepared.toolchain.store).not.toBe(join(f.kit, paths.store));
    await writeFile(join(prepared.checkout, "pnpm-lock.yaml"), "trial");
    expect(await readFile(join(f.source, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion");
    expect((await lstat(dirname(prepared.checkout))).mode & 0o077).toBe(0);
    await prepared.release();
    await expect(lstat(prepared.checkout)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unsupported version or changed lockfile before creating a writable checkout", async () => {
    const f = await fixture();
    await expect(f.provider.prepare("b".repeat(40), f.signal)).rejects.toThrow("version");
    await writeFile(join(f.source, "pnpm-lock.yaml"), "changed");
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
  });

  it("rejects path escape, missing kit, architecture mismatch and external linked source", async () => {
    const f = await fixture();
    const badPath = await f.setManifest({ ...f.manifest, paths: { ...paths, checkout: "../source" } });
    await expect(badPath.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
    const badArch = await f.setManifest({ ...f.manifest, arch: "x64" });
    await expect(badArch.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
    await f.setManifest(f.manifest);
    await symlink(tmpdir(), join(f.source, "outside"));
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
  });

  it("supports sequential restart reuse but fences concurrent preparations and cancellation", async () => {
    const f = await fixture();
    const first = await f.provider.prepare(f.manifest.baseSha, f.signal);
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("busy");
    await first.release();
    const restarted = createMacVerificationSourceProvider({ resourcesPath: dirname(f.kit), userData: f.profile, platform: "darwin", arch: "arm64", expectedManifestSha256: f.expectedManifestSha256 });
    const second = await restarted.prepare(f.manifest.baseSha, f.signal);
    await second.release();
    await expect(restarted.prepare(f.manifest.baseSha, AbortSignal.abort())).rejects.toThrow();
  });
});
