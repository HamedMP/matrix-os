import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commitCodexKey, CodexKeyRollbackFailedError } from "../../packages/gateway/src/ai-providers/codex-key-transaction.js";
import { NativeProviderWriteRestoredError } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(original: string | null = "previous", mode = 0o600) {
  const root = await mkdtemp(join(tmpdir(), "codex-key-transaction-")); roots.push(root);
  const directory = join(root, ".codex"), staging = join(root, "stage");
  await mkdir(directory, { mode: 0o700 }); await mkdir(staging, { mode: 0o700 });
  const target = join(directory, "auth.json"), backup = join(staging, "previous-auth");
  if (original !== null) { await writeFile(target, original, { mode }); await chmod(target, mode); }
  await writeFile(join(staging, "auth.json"), "replacement", { mode: 0o600 });
  return { directory, directoryIdentity: await lstat(directory), staging, target, backup };
}
it("publishes only the staged credential before the Settings commit and preserves success", async () => {
  const f = await fixture(); const commit = vi.fn(async () => { expect(await readFile(f.target, "utf8")).toBe("replacement"); });
  await commitCodexKey({ ...f, commit }); expect(commit).toHaveBeenCalledOnce();
  expect(await readFile(f.target, "utf8")).toBe("replacement");
});
it.each([0o600, 0o400])("restores exact bytes and safe original mode %i after failed Settings commit", async mode => {
  const f = await fixture("previous\n", mode);
  await expect(commitCodexKey({ ...f, commit: async () => { throw new Error("CAS failed"); } })).rejects.toBeInstanceOf(NativeProviderWriteRestoredError);
  expect(await readFile(f.target, "utf8")).toBe("previous\n"); expect((await lstat(f.target)).mode & 0o777).toBe(mode);
});
it("restores original absence after failed Settings commit", async () => {
  const f = await fixture(null);
  await expect(commitCodexKey({ ...f, commit: async () => { throw new Error("CAS failed"); } })).rejects.toBeInstanceOf(NativeProviderWriteRestoredError);
  await expect(lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["symlink", "oversize", "public-mode", "hardlink"])("rejects unsafe prior auth %s before replacement or Settings commit", async kind => {
  const f = await fixture();
  if (kind === "symlink") { await rename(f.target, join(f.directory, "private-auth")); await symlink("private-auth", f.target); }
  if (kind === "oversize") await writeFile(f.target, "x".repeat(65_537));
  if (kind === "public-mode") await chmod(f.target, 0o644);
  if (kind === "hardlink") { const { link } = await import("node:fs/promises"); await link(f.target, join(f.directory, "alias")); }
  const before = await lstat(f.target); const commit = vi.fn();
  await expect(commitCodexKey({ ...f, commit })).rejects.toThrow("unavailable"); expect(commit).not.toHaveBeenCalled();
  expect((await lstat(f.target)).ino).toBe(before.ino);
});
it("never overwrites an externally replaced inode and retains exact backup for recovery", async () => {
  const f = await fixture(); const foreign = join(f.directory, "foreign");
  await writeFile(foreign, "foreign", { mode: 0o600 });
  await expect(commitCodexKey({ ...f, commit: async () => { await rename(foreign, f.target); throw new Error("CAS failed"); } })).rejects.toBeInstanceOf(CodexKeyRollbackFailedError);
  expect(await readFile(f.target, "utf8")).toBe("foreign"); expect(await readFile(f.backup, "utf8")).toBe("previous");
});
it("retains recovery backup when rollback cannot restore it", async () => {
  const f = await fixture();
  await expect(commitCodexKey({ ...f, commit: async () => { await unlink(f.target); throw new Error("CAS failed"); } })).rejects.toBeInstanceOf(CodexKeyRollbackFailedError);
  expect(await readFile(f.backup, "utf8")).toBe("previous");
});
