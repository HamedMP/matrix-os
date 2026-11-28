import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealMacVerificationArchive } from "../../scripts/release/prepare-mac-verification-support.mjs";
import {
  checkVerificationStore, clearVerificationStoreProjects, createMacVerificationSourceProvider,
} from "@desktop/main/chat-electron-preview/source-provider";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const paths = { checkout: "source.tar", node: "toolchain/node/bin/node", pnpm: "toolchain/pnpm/bin/pnpm.cjs",
  electron: "runtime/Electron.app/Contents/MacOS/Electron" };
// Developer machines may run with umask 002; strip the group-write bits the
// product correctly rejects so the fixture models a default 022 checkout.
async function withoutGroupWrite(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.mode & 0o7755);
  if (info.isDirectory()) for (const name of await readdir(path)) await withoutGroupWrite(join(path, name));
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "matrix-source-provider-"))); roots.push(root);
  const kit = join(root, "resources", "mac-verification-support");
  const profile = join(root, "profile");
  const source = join(root, "original-source");
  await mkdir(source, { recursive: true });
  await mkdir(kit, { recursive: true });
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
  await withoutGroupWrite(root);
  const archives = { checkout: await sealMacVerificationArchive(source, join(kit, paths.checkout), { allowSymlinks: true }) };
  const manifest = { version: 3, baseSha: git("rev-parse", "HEAD"), nodeVersion: "24.18.0", pnpmVersion: "10.33.4",
    platform: "darwin", arch: "arm64", lockfileSha256: createHash("sha256").update(await readFile(join(source, "pnpm-lock.yaml"))).digest("hex"), paths, archives };
  await writeFile(join(kit, "manifest.json"), JSON.stringify(manifest));
  const expectedManifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const provider = createMacVerificationSourceProvider({ resourcesPath: join(root, "resources"), userData: profile,
    platform: "darwin", arch: "arm64", expectedManifestSha256 });
  async function setManifest(next: unknown) {
    const bytes = JSON.stringify(next); await writeFile(join(kit, "manifest.json"), bytes);
    return createMacVerificationSourceProvider({ resourcesPath: dirname(kit), userData: profile,
      platform: "darwin", arch: "arm64", expectedManifestSha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { kit, profile, source, manifest, provider, expectedManifestSha256, signal: new AbortController().signal,
    setManifest,
    async repack() {
      await rm(join(kit, paths.checkout));
      manifest.archives.checkout = await sealMacVerificationArchive(source, join(kit, paths.checkout), { allowSymlinks: true });
      return setManifest(manifest);
    },
  };
}

// A hostile fixture exercises the actual OS tar boundary; product code does
// not parse this or accept user-selected archives.
function hostileTar(name: string, contents: string) {
  const header = Buffer.alloc(512); const payload = Buffer.from(contents);
  header.write(name, 0, 100, "utf8");
  for (const [offset, width, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, payload.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
  }
  header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512), Buffer.alloc(1024)]);
}

describe("packaged Mac Verification source preparation", () => {
  it("keeps a valid-hash traversal tar inside the OS extraction boundary and cleans rejected staging", async () => {
    const f = await fixture(); const payload = "must not escape";
    const archive = hostileTar("../../../escaped.txt", payload);
    await writeFile(join(f.kit, paths.checkout), archive);
    const provider = await f.setManifest({ ...f.manifest, archives: { ...f.manifest.archives,
      checkout: { sha256: createHash("sha256").update(archive).digest("hex"), sizeBytes: archive.length,
        unpackedBytes: Buffer.byteLength(payload), fileCount: 1 } } });
    await expect(provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    await expect(lstat(join(f.profile, "escaped.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(f.profile, "mac-verification-support"))).toEqual([]);
  });

  it("rejects mismatched extraction counts without publishing a cache, then permits a clean retry", async () => {
    const f = await fixture();
    const mismatch = await f.setManifest({ ...f.manifest, archives: { ...f.manifest.archives,
      checkout: { ...f.manifest.archives.checkout, fileCount: f.manifest.archives.checkout.fileCount + 1 } } });
    await expect(mismatch.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    expect(await readdir(join(f.profile, "mac-verification-support"))).toEqual([]);
    const retry = await f.setManifest(f.manifest); const prepared = await retry.prepare(f.manifest.baseSha, f.signal);
    expect(await readdir(prepared.toolchain.store)).toEqual([]);
    await prepared.release();
  });

  it("rejects source archive tampering and declared oversize before publishing any support cache", async () => {
    const f = await fixture();
    const archive = join(f.kit, paths.checkout); const contents = await readFile(archive);
    contents[0] ^= 0xff; await writeFile(archive, contents);
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    const large = await f.setManifest({ ...f.manifest, archives: { ...f.manifest.archives,
      checkout: { ...f.manifest.archives.checkout, sizeBytes: 9 * 1024 ** 3 } } });
    await expect(large.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
  });

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
    await expect(f.provider.baseSha()).resolves.toBe(f.manifest.baseSha);
    expect(await readdir(f.profile)).toEqual([]);
    await writeFile(join(f.kit, "manifest.json"), JSON.stringify(f.manifest) + " ");
    await expect(f.provider.baseSha()).rejects.toThrow("support-unavailable");
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    await f.setManifest(f.manifest);
    await rm(join(f.kit, paths.node));
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
  });

  it.each([
    ["dead writer", JSON.stringify({ pid: 2147483647, token: "00000000-0000-4000-8000-000000000001", createdAt: 0 })],
    ["empty lock", ""],
    ["partial PID", '{"pid":21'],
    ["partial lock", '{"pid":2147483647,"token":'],
  ])("recovers disk space after %s and refuses live process records", async (_state, record) => {
    const f = await fixture();
    const workspace = join(f.profile, "mac-verification-support");
    await mkdir(workspace, { mode: 0o700 });
    const lock = join(workspace, "preparation.lock");
    await writeFile(lock, record, { mode: 0o600 });
    const abandoned = "request-00000000-0000-4000-8000-000000000003";
    await mkdir(join(workspace, abandoned));
    const free = await fs.statfs(workspace);
    const disk = vi.spyOn(fs, "statfs").mockImplementation(async () => ({
      ...free, bavail: (await readdir(workspace)).includes(abandoned) ? 0 : Number.MAX_SAFE_INTEGER,
    }));
    const prepare = () => f.provider.prepare(f.manifest.baseSha, f.signal);
    const attempts = await Promise.allSettled([prepare(), prepare()]);
    const winners = attempts.filter(attempt => attempt.status === "fulfilled");
    expect(winners, JSON.stringify(attempts)).toHaveLength(1);
    expect(attempts.find(attempt => attempt.status === "rejected")).toMatchObject({ reason: { code: "preparation-busy" } });
    const recovered = winners[0]!.value;
    expect(await readFile(lock, "utf8")).toContain(String(process.pid));
    await recovered.release();
    disk.mockResolvedValue({ ...free, bavail: 0 });
    await expect(prepare()).rejects.toMatchObject({ code: "insufficient-disk" });
    const active = JSON.stringify({ pid: process.pid, token: "00000000-0000-4000-8000-000000000002", createdAt: 0 });
    for (const protectedRecord of [active, `{"pid":${process.pid},"token":`, "{}"]) {
      await writeFile(lock, protectedRecord, { mode: 0o600 });
      await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("busy");
      expect(await readFile(lock, "utf8")).toBe(protectedRecord);
    }
  });

  it("prepares the exact candidate without a folder picker, network, or changes to the bundled source", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepare(f.manifest.baseSha, f.signal);
    expect(prepared.checkout).not.toBe(f.source);
    expect(prepared.toolchain.node).toBe(join(f.kit, paths.node));
    expect(prepared.toolchain.store).toContain(join(f.profile, "mac-verification-support", "store-"));
    expect((await lstat(prepared.toolchain.store)).mode & 0o777).toBe(0o700);
    expect(await readdir(prepared.toolchain.store)).toEqual([]);
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
    const changed = await f.repack();
    await expect(changed.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
  });

  it("rejects path escape, missing kit, architecture mismatch and external linked source", async () => {
    const f = await fixture();
    const badPath = await f.setManifest({ ...f.manifest, paths: { ...paths, checkout: "../source" } });
    await expect(badPath.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
    const badArch = await f.setManifest({ ...f.manifest, arch: "x64" });
    await expect(badArch.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support");
    await f.setManifest(f.manifest);
    await symlink(tmpdir(), join(f.source, "outside"));
    await expect(f.repack()).rejects.toThrow("archive");
  });

  it("refuses legacy bundled dependency stores and unsafe private-cache reuse", async () => {
    const f = await fixture();
    const legacy = await f.setManifest({ ...f.manifest, version: 2, paths: { ...paths, store: "pnpm-store.tar" },
      archives: { ...f.manifest.archives, store: f.manifest.archives.checkout } });
    await expect(legacy.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    await f.setManifest(f.manifest);
    const workspace = join(f.profile, "mac-verification-support");
    await mkdir(workspace, { mode: 0o700 });
    await symlink(f.source, join(workspace, `store-${f.expectedManifestSha256}`));
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("support-unavailable");
    expect(await readFile(join(f.source, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion");
  });

  it("bounds writable dependency bytes and only clears pnpm's direct private project links", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepare(f.manifest.baseSha, f.signal);
    const store = prepared.toolchain.store;
    try {
      const projects = join(store, "v10", "projects");
      await mkdir(projects, { recursive: true, mode: 0o755 });
      const link = join(projects, "a".repeat(32));
      await symlink(f.source, link);
      await checkVerificationStore(store, f.signal);
      await clearVerificationStoreProjects(store);
      expect(await readdir(projects)).toEqual([]);
      expect(await readFile(join(f.source, "pnpm-lock.yaml"), "utf8")).toContain("lockfileVersion");
      const unexpected = join(projects, "b".repeat(32));
      await mkdir(unexpected, { mode: 0o755 });
      await writeFile(join(unexpected, "keep"), "owned contents");
      await expect(clearVerificationStoreProjects(store)).rejects.toThrow("support-unavailable");
      expect(await readFile(join(unexpected, "keep"), "utf8")).toBe("owned contents");
      await rm(projects, { recursive: true });
      await symlink(f.source, projects);
      await expect(clearVerificationStoreProjects(store)).rejects.toThrow("support-unavailable");
      await rm(projects);
      const sparse = join(store, "oversized");
      await writeFile(sparse, "");
      await truncate(sparse, 4 * 1024 ** 3 + 1);
      await expect(checkVerificationStore(store, f.signal)).rejects.toThrow("support-unavailable");
      await rm(sparse);
      await chmod(store, 0o755);
      await expect(checkVerificationStore(store, f.signal)).rejects.toThrow("support-unavailable");
    } finally { await prepared.release(); }
  });

  it("tolerates a vanished pnpm temporary child only while monitoring an active install", async () => {
    const f = await fixture();
    const prepared = await f.provider.prepare(f.manifest.baseSha, f.signal);
    const volatile = join(prepared.toolchain.store, "temporary-package");
    await writeFile(volatile, "temporary");
    const original = vi.mocked(fs.lstat).getMockImplementation()!;
    vi.mocked(fs.lstat).mockImplementation((path, options) => {
      if (path === volatile) return Promise.reject(Object.assign(new Error("Package renamed during scan"), { code: "ENOENT" }));
      return original(path, options as never);
    });
    try {
      await expect(checkVerificationStore(prepared.toolchain.store, f.signal, true)).resolves.toBeUndefined();
      await expect(checkVerificationStore(prepared.toolchain.store, f.signal)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.mocked(fs.lstat).mockImplementation(original); await prepared.release(); }
  });

  it("supports sequential restart reuse but fences concurrent preparations and cancellation", async () => {
    const f = await fixture();
    const first = await f.provider.prepare(f.manifest.baseSha, f.signal);
    await expect(f.provider.prepare(f.manifest.baseSha, f.signal)).rejects.toThrow("busy");
    await writeFile(join(first.toolchain.store, "cache-probe"), "retained private dependency bytes", { mode: 0o600 });
    await first.release();
    const restarted = createMacVerificationSourceProvider({ resourcesPath: dirname(f.kit), userData: f.profile, platform: "darwin", arch: "arm64", expectedManifestSha256: f.expectedManifestSha256 });
    const second = await restarted.prepare(f.manifest.baseSha, f.signal);
    expect(second.toolchain.store).toBe(first.toolchain.store);
    expect(await readFile(join(second.toolchain.store, "cache-probe"), "utf8")).toBe("retained private dependency bytes");
    await second.release();
    await expect(restarted.prepare(f.manifest.baseSha, AbortSignal.abort())).rejects.toThrow();
  });
});
