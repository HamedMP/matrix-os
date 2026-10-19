import { mkdir, mkdtemp, open, rename, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilesystemIncarnation, filesystemIncarnation } from "../../packages/gateway/src/collaboration/filesystem-incarnation.js";

function response(generation: number) {
  const bytes = Buffer.alloc(40);
  bytes.write("MFI2");
  bytes.writeUInt32BE(0xef53, 4);
  bytes.writeUInt32BE(1, 8); // Persistent filesystem identifier, not mount ID.
  bytes.writeUInt32BE(1, 24);
  bytes.writeUInt32BE(8, 28);
  bytes.writeUInt32BE(123, 32); // Same inode and exposed stat tuple.
  bytes.writeUInt32BE(generation, 36);
  return bytes;
}
describe("descriptor-bound filesystem incarnations", () => {
  it("distinguishes generations when every exposed stat field collides", () => {
    let current = response(1);
    const identity = createFilesystemIncarnation((fd) => { expect(fd).toBe(7); return current; });
    const original = identity(7);
    current = response(2);
    expect(identity(7)).not.toBe(original);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([undefined, "123", Buffer.alloc(0), Buffer.alloc(32), response(1).subarray(0, 31), Buffer.concat([response(1), Buffer.alloc(1)])])("rejects malformed native responses without a metadata fallback (%s)", (invalid) => {
    expect(() => createFilesystemIncarnation(() => invalid)(7)).toThrowError(expect.objectContaining({ code: "unavailable" }));
  });

  it("fails closed on native errors and invalid descriptors", () => {
    expect(() => createFilesystemIncarnation(() => { throw new Error("unsupported"); })(7)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    const readIdentity = vi.fn(() => { throw new Error("Native provider must not be called for invalid descriptors"); });
    const identity = createFilesystemIncarnation(readIdentity);
    for (const fd of [-1, 1.5, Number.NaN, 2 ** 32]) expect(() => identity(fd)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    expect(readIdentity).not.toHaveBeenCalled();
  });

  it("rejects unsupported filesystem, empty fsid and invalid handle metadata", () => {
    for (const offset of [4, 8, 24, 28]) {
      const bytes = response(1); bytes.writeUInt32BE(0, offset);
      expect(() => createFilesystemIncarnation(() => bytes)(7)).toThrowError(expect.objectContaining({ code: "unavailable" }));
    }
  });

});

// Platform-only guard: native build or filesystem failures must fail Linux CI.
describe.runIf(process.platform === "linux")("native filesystem incarnations (Linux)", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
  it("has the same persistent object identity in a fresh process", async () => {
    const base = await mkdtemp(join(tmpdir(), "matrix-generation-restart-")); roots.push(base);
    const path = join(base, "file"); await writeFile(path, "same object");
    const binary = fileURLToPath(new URL("../../packages/gateway/dist/collaboration/filesystem-identity.node", import.meta.url));
    const addon = createRequire(import.meta.url)(binary) as { readIdentity(fd: number): Buffer };
    const handle = await open(path, "r");
    let before: Buffer;
    try { before = addon.readIdentity(handle.fd); } finally { await handle.close(); }
    const after = execFileSync(process.execPath, ["--input-type=module", "-e", 'import {createRequire} from "node:module";import {openSync,closeSync} from "node:fs";const fd=openSync(process.argv[2],"r");try{process.stdout.write(createRequire(import.meta.url)(process.argv[1]).readIdentity(fd).toString("hex"));}finally{closeSync(fd);}', binary, path], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 });
    expect(after).toBe(before.toString("hex"));
  });

  it("preserves real file edits/metadata/rename and folder children, while replacing generations", async () => {
    const base = await mkdtemp(join(tmpdir(), "matrix-generation-")); roots.push(base);
    const identify = async (path: string) => {
      const handle = await open(path, "r");
      try { return filesystemIncarnation(handle.fd); } finally { await handle.close(); }
    };
    const path = join(base, "file");
    await writeFile(path, "original"); const before = await identify(path);
    await chmod(path, 0o600); await writeFile(path, "edited in place"); expect(await identify(path)).toBe(before);
    const moved = join(base, "moved"); await rename(path, moved); expect(await identify(moved)).toBe(before);
    await rm(moved); await writeFile(moved, "replacement"); expect(await identify(moved)).not.toBe(before);
    const folder = join(base, "folder"); await mkdir(folder); const root = await identify(folder);
    await writeFile(join(folder, "child"), "child"); expect(await identify(folder)).toBe(root);
    await rm(folder, { recursive: true }); await mkdir(folder); expect(await identify(folder)).not.toBe(root);
  });
});
