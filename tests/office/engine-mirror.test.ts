import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { OFFICE_ERROR_CODES, OfficeError, isOfficeError } from "../../packages/office/src/errors.js";
import * as mirroredErrors from "../../home/apps/_shared/office-engine/errors.js";

const root = process.cwd();
const script = join(root, "scripts/sync-office-engine.mjs");
const SOURCE = "packages/office/src";
const MIRROR = "home/apps/_shared/office-engine";

type Change = { path: string; action: "add" | "update" | "delete" };
type SyncModule = {
  syncOfficeEngine(options: { root: string; check?: boolean }): { changes: Change[] };
};
const load = (): Promise<SyncModule> => import(pathToFileURL(script).href);

const temporaryRoots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "office-engine-mirror-"));
  temporaryRoots.push(directory);
  for (const [path, content] of Object.entries(files)) write(directory, path, content);
  return directory;
}
function write(directory: string, path: string, content: string): void {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), content);
}
function listFiles(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? listFiles(directory, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("office engine mirror", () => {
  it("is up to date with packages/office/src (run: node scripts/sync-office-engine.mjs)", async () => {
    const { syncOfficeEngine } = await load();
    expect(syncOfficeEngine({ root, check: true }).changes).toEqual([]);
  });

  it("copies the source tree byte for byte and adds a generated notice", async () => {
    const { syncOfficeEngine } = await load();
    const crlf = "export const a = 1;\r\n// café\r\n";
    const directory = makeRoot({ [`${SOURCE}/index.ts`]: crlf, [`${SOURCE}/api/deep/types.ts`]: "export type T = 1;\n" });

    const { changes } = syncOfficeEngine({ root: directory });

    expect(changes).toEqual([
      { path: "README.md", action: "add" },
      { path: "api/deep/types.ts", action: "add" },
      { path: "index.ts", action: "add" },
    ]);
    expect(listFiles(join(directory, MIRROR))).toEqual(["README.md", "api/deep/types.ts", "index.ts"]);
    expect(readFileSync(join(directory, MIRROR, "index.ts"))).toEqual(Buffer.from(crlf));
    expect(readFileSync(join(directory, MIRROR, "README.md"), "utf8")).toMatch(/^<!-- GENERATED/);
    expect(syncOfficeEngine({ root: directory, check: true }).changes).toEqual([]);
  });

  it("reports changed, new and removed files in check mode without writing", async () => {
    const { syncOfficeEngine } = await load();
    const directory = makeRoot({ [`${SOURCE}/index.ts`]: "one\n", [`${SOURCE}/old.ts`]: "old\n" });
    syncOfficeEngine({ root: directory });

    write(directory, `${SOURCE}/index.ts`, "two\n");
    write(directory, `${SOURCE}/added.ts`, "added\n");
    rmSync(join(directory, SOURCE, "old.ts"));
    write(directory, `${MIRROR}/README.md`, "edited by hand\n");

    expect(syncOfficeEngine({ root: directory, check: true }).changes).toEqual([
      { path: "README.md", action: "update" },
      { path: "added.ts", action: "add" },
      { path: "index.ts", action: "update" },
      { path: "old.ts", action: "delete" },
    ]);
    expect(readFileSync(join(directory, MIRROR, "index.ts"), "utf8")).toBe("one\n");
    expect(listFiles(join(directory, MIRROR))).toEqual(["README.md", "index.ts", "old.ts"]);
  });

  it("deletes mirrored files whose source is gone and prunes empty directories", async () => {
    const { syncOfficeEngine } = await load();
    const directory = makeRoot({ [`${SOURCE}/index.ts`]: "one\n", [`${SOURCE}/gone/deep/file.ts`]: "gone\n" });
    syncOfficeEngine({ root: directory });
    rmSync(join(directory, SOURCE, "gone"), { recursive: true });

    expect(syncOfficeEngine({ root: directory }).changes).toEqual([{ path: "gone/deep/file.ts", action: "delete" }]);
    expect(listFiles(join(directory, MIRROR))).toEqual(["README.md", "index.ts"]);
    expect(readdirSync(join(directory, MIRROR)).sort()).toEqual(["README.md", "index.ts"]);
  });

  it("refuses symbolic links and a source file that collides with the generated notice", async () => {
    const { syncOfficeEngine } = await load();
    const linked = makeRoot({ [`${SOURCE}/index.ts`]: "one\n", "outside.ts": "secret\n" });
    symlinkSync(join(linked, "outside.ts"), join(linked, SOURCE, "link.ts"));
    expect(() => syncOfficeEngine({ root: linked })).toThrow(/symbolic link/);

    const colliding = makeRoot({ [`${SOURCE}/README.md`]: "notes\n" });
    expect(() => syncOfficeEngine({ root: colliding })).toThrow(/README\.md/);
  });

  it("exits 1 from the command line when the mirror is stale and 0 after a sync", () => {
    const directory = makeRoot({ [`${SOURCE}/index.ts`]: "one\n" });
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, "--root", directory, ...args], { encoding: "utf8", timeout: 30_000 });

    const stale = run("--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("index.ts");

    expect(run().status).toBe(0);
    expect(run("--check").status).toBe(0);
    expect(run("--bogus").status).toBe(2);
  });
});

describe("mirrored office engine", () => {
  it("exports the same error codes as the package source", () => {
    expect(mirroredErrors.OFFICE_ERROR_CODES).toEqual(OFFICE_ERROR_CODES);
  });

  it("recognises an OfficeError from the other copy of the class by shape", () => {
    const cause = new Error("inflate failed");
    const fromMirror = new mirroredErrors.OfficeError("zip_limit_exceeded", "entry too large", {
      cause,
      details: { entry: "word/document.xml", limit: 10 },
    });

    expect(fromMirror).toBeInstanceOf(Error);
    expect(fromMirror).not.toBeInstanceOf(OfficeError);
    expect(isOfficeError(fromMirror)).toBe(true);
    expect(isOfficeError(fromMirror, "zip_limit_exceeded")).toBe(true);
    expect(isOfficeError(fromMirror, "not_a_zip", "corrupt_package")).toBe(false);
    expect(fromMirror.cause).toBe(cause);
    expect(fromMirror.details).toEqual({ entry: "word/document.xml", limit: 10 });
    expect(Object.isFrozen(fromMirror.details)).toBe(true);
  });

  it("keeps messages and details out of the client-safe JSON form", () => {
    const error = new OfficeError("stale_reference", "block b12 no longer contains \"secret clause\"");
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: "OfficeError", code: "stale_reference" });
    expect(error.details).toEqual({});
  });

  it("does not mistake other errors for an OfficeError", () => {
    const impostor = Object.assign(new Error("x"), { name: "OfficeError", code: "made_up" });
    expect(isOfficeError(impostor)).toBe(false);
    expect(isOfficeError(Object.assign(new Error("x"), { code: "not_a_zip" }))).toBe(false);
    expect(isOfficeError({ name: "OfficeError", code: "not_a_zip" })).toBe(false);
    expect(isOfficeError(null)).toBe(false);
  });
});
