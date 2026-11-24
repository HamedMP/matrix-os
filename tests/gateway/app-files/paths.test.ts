import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { encodeAppFileBase64 } from "../../../packages/contracts/src/app-files";
import { createHarness, errorCode, type AppFileHarness } from "./helpers";

let harness: AppFileHarness | null = null;
afterEach(async () => { await harness?.cleanup(); harness = null; });

const bytes = encodeAppFileBase64(new TextEncoder().encode("payload"));
async function code(response: Response): Promise<[number, string]> {
  return [response.status, response.status === 200 ? "ok" : await errorCode(response)];
}

describe("app file path security", () => {
  it.each(["system/app-capabilities.json", ".ssh/id_ed25519", "agents/custom.md", ".hermes/state.json"])(
    "refuses to read, stat or list the protected path %s",
    async (path) => {
      harness = await createHarness();
      await mkdir(join(harness.home, path, ".."), { recursive: true });
      await writeFile(join(harness.home, path), "secret");
      expect(await code(await harness.post({ kind: "files.read", path }))).toEqual([403, "forbidden"]);
      expect(await code(await harness.post({ kind: "files.stat", path }))).toEqual([403, "forbidden"]);
      expect(await code(await harness.post({ kind: "files.list", dir: path.split("/")[0] }))).toEqual([403, "forbidden"]);
    },
  );

  it.each(["system/evil.txt", ".bashrc", "agents/x/y.md", ".trash/f.txt"])("refuses to write or mkdir the protected path %s", async (path) => {
    harness = await createHarness();
    expect(await code(await harness.post({ kind: "files.write", path, contentBase64: bytes, ifVersion: null, createParents: true }))).toEqual([403, "forbidden"]);
    expect(await code(await harness.post({ kind: "files.mkdir", path }))).toEqual([403, "forbidden"]);
    await expect(lstat(join(harness.home, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hides the denied data subtrees as not found", async () => {
    harness = await createHarness();
    await mkdir(join(harness.home, "data/browser-profiles/p1"), { recursive: true });
    await writeFile(join(harness.home, "data/browser-profiles/p1/cookies"), "c");
    expect(await code(await harness.post({ kind: "files.read", path: "data/browser-profiles/p1/cookies" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.list", dir: "data/browser-profiles" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.write", path: "data/browser-profiles/p1/new", contentBase64: bytes, ifVersion: null }))).toEqual([404, "not_found"]);
    const listing = await (await harness.post({ kind: "files.list", dir: "data" })).json();
    expect(listing.entries).toEqual([]);
  });

  it("rejects traversal and malformed paths at the schema", async () => {
    harness = await createHarness();
    for (const path of ["../outside.txt", "a/../../outside.txt", "./a", "a//b", "a/", "a\\b", "a\u0000b"]) {
      expect(await code(await harness.post({ kind: "files.read", path }))).toEqual([400, "invalid_request"]);
      expect(await code(await harness.post({ kind: "files.write", path, contentBase64: bytes, ifVersion: null }))).toEqual([400, "invalid_request"]);
    }
  });

  it("refuses a symlinked file for every operation and never writes through it", async () => {
    harness = await createHarness();
    const outsideDir = await mkdtemp(join(tmpdir(), "app-files-outside-"));
    onTestFinished(() => rm(outsideDir, { recursive: true, force: true }));
    const outside = join(outsideDir, "outside.txt");
    await writeFile(outside, "outside");
    await writeFile(join(harness.home, "inside.txt"), "inside");
    await symlink(outside, join(harness.home, "out-link.txt"));
    await symlink(join(harness.home, "inside.txt"), join(harness.home, "in-link.txt"));
    for (const path of ["out-link.txt", "in-link.txt"]) {
      expect(await code(await harness.post({ kind: "files.read", path }))).toEqual([403, "forbidden"]);
      expect(await code(await harness.post({ kind: "files.stat", path }))).toEqual([403, "forbidden"]);
      expect((await harness.post({ kind: "files.write", path, contentBase64: bytes, ifVersion: null })).status).toBe(403);
    }
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readFile(join(harness.home, "inside.txt"), "utf8")).toBe("inside");
    expect((await lstat(join(harness.home, "out-link.txt"))).isSymbolicLink()).toBe(true);
  });

  it("refuses a path through a symlinked directory, even one that stays inside home", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "system/secret.json"), "{}");
    await symlink(join(harness.home, "system"), join(harness.home, "sys-alias"));
    await mkdir(join(harness.home, "real"));
    await writeFile(join(harness.home, "real/a.txt"), "a");
    await symlink(join(harness.home, "real"), join(harness.home, "alias"));
    expect((await harness.post({ kind: "files.read", path: "sys-alias/secret.json" })).status).toBe(403);
    expect((await harness.post({ kind: "files.read", path: "alias/a.txt" })).status).toBe(403);
    expect((await harness.post({ kind: "files.list", dir: "alias" })).status).toBe(403);
    expect((await harness.post({ kind: "files.write", path: "alias/b.txt", contentBase64: bytes, ifVersion: null })).status).toBe(403);
    expect((await harness.post({ kind: "files.mkdir", path: "alias/sub" })).status).toBe(403);
    await expect(lstat(join(harness.home, "real/b.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("omits symlinks and protected entries from listings", async () => {
    harness = await createHarness();
    await writeFile(join(harness.home, "visible.txt"), "v");
    await writeFile(join(harness.home, ".hidden"), "h");
    await symlink(join(harness.home, "visible.txt"), join(harness.home, "link.txt"));
    const listing = await (await harness.post({ kind: "files.list", dir: "" })).json();
    const names = listing.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain("visible.txt");
    expect(names).toContain("apps");
    for (const hidden of ["system", ".hidden", "link.txt"]) expect(names).not.toContain(hidden);
  });

  it("replies not_found for missing paths and missing parents", async () => {
    harness = await createHarness();
    expect(await code(await harness.post({ kind: "files.read", path: "nope.docx" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.list", dir: "nope" }))).toEqual([404, "not_found"]);
    expect(await code(await harness.post({ kind: "files.write", path: "nope/a.docx", contentBase64: bytes, ifVersion: null }))).toEqual([404, "not_found"]);
  });
});
