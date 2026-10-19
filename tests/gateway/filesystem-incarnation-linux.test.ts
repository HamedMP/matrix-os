import { mkdir, mkdtemp, open, rename, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { filesystemIncarnation } from "../../packages/gateway/src/collaboration/filesystem-incarnation.js";

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
