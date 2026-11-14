import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createHash } from "node:crypto";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.doUnmock("node:fs/promises"); });

async function cli(args: string[]) {
  const argv = process.argv; const exitCode = process.exitCode;
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.argv = [process.execPath, resolve("skills/matrix/collaborative-app-builder/scripts/schema-digest.mjs"), ...args];
    process.exitCode = 0;
    vi.resetModules();
    await import("../../skills/matrix/collaborative-app-builder/scripts/schema-digest.mjs");
    return { output: output.mock.calls.map(([value]) => value), error: error.mock.calls.map(([value]) => value), code: process.exitCode };
  } finally { process.argv = argv; process.exitCode = exitCode; output.mockRestore(); error.mockRestore(); }
}

describe("shipped schema digest command", () => {
  it("prints the canonical digest without writing and updates only compatibility on --write", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-digest-cli-"));
    try {
      const tables = { tasks: { columns: { title: "text", done: "boolean" } } };
      const manifest = { slug: "keep-identity", storage: { tables }, collaboration: { compatibility: { runtimeAbi: "matrix-runtime-v1" } } };
      const path = join(root, "matrix.json"); const original = JSON.stringify(manifest);
      await writeFile(path, original);
      const expected = createHash("sha256").update(canonicalJson(tables)).digest("hex");
      expect(await cli([root])).toEqual({ output: [expected], error: [], code: 0 });
      expect(await readFile(path, "utf8")).toBe(original);
      expect(await cli([root, "--write"])).toEqual({ output: [expected], error: [], code: 0 });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...manifest, collaboration: { compatibility: { runtimeAbi: "matrix-runtime-v1", schemaDigest: expected } } });
      expect(await readdir(root)).toEqual(["matrix.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([[], ["app", "--unknown"], ["app", "--write", "extra"]])("rejects invalid invocation %j without success output", async (...args) => {
    const result = await cli(args as string[]);
    expect(result.code).toBe(1); expect(result.output).toEqual([]);
    expect(result.error).toEqual([expect.stringContaining("Usage:")]);
  });

  it("rejects a missing declaration and oversized manifests without changing the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-digest-invalid-"));
    try {
      const path = join(root, "matrix.json");
      const missing = JSON.stringify({ storage: { tables: { tasks: { columns: { title: "text" } } } } });
      await writeFile(path, missing);
      expect((await cli([root, "--write"])).error).toEqual(["Declare collaboration.compatibility first"]);
      expect(await readFile(path, "utf8")).toBe(missing);
      const oversized = " ".repeat(1024 * 1024 + 1); await writeFile(path, oversized);
      expect((await cli([root, "--write"])).code).toBe(1);
      expect(await readFile(path, "utf8")).toBe(oversized);
      await writeFile(path, "{}");
      expect((await cli([root])).error).toEqual([expect.stringContaining("storage.tables")]);
      await writeFile(path, "{");
      expect((await cli([root])).code).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("keeps the original manifest when atomic replacement fails (cleanup fails: %s)", async (cleanupFails) => {
    const root = await mkdtemp(join(tmpdir(), "matrix-digest-write-failure-"));
    try {
      const path = join(root, "matrix.json");
      const original = JSON.stringify({ storage: { tables: { tasks: { columns: { title: "text" } } } }, collaboration: { compatibility: { schemaDigest: "original" } } });
      await writeFile(path, original);
      vi.doMock("node:fs/promises", async () => {
        const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        return { ...fs, rename: async () => { throw new Error("Replacement unavailable"); }, unlink: cleanupFails
          ? async () => { throw Object.assign(new Error("Cleanup unavailable"), { code: "EACCES" }); } : fs.unlink };
      });
      const result = await cli([root, "--write"]);
      expect(result).toEqual({ output: [], error: [cleanupFails ? "Cleanup unavailable" : "Replacement unavailable"], code: 1 });
      expect(await readFile(path, "utf8")).toBe(original);
      if (!cleanupFails) expect(await readdir(root)).toEqual(["matrix.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
