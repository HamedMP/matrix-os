import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchRendererAsset,
  restoreRendererAsset,
} from "../../specs/124-organization-collaboration/evidence/S20-audience/renderer-asset.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "s20-asset-test-"));
  directories.push(directory);
  const file = join(directory, "renderer.js");
  writeFileSync(file, "original renderer bytes");
  return file;
}

describe("S20 Electron evidence renderer patch", () => {
  it("restores original bytes when a patch write truncates and fails", () => {
    const file = fixture();
    expect(() => patchRendererAsset(file, "replacement", (path, contents) => {
      writeFileSync(path, contents.slice(0, 4));
      throw new Error("simulated partial write");
    })).toThrow("simulated partial write");
    expect(readFileSync(file, "utf8")).toBe("original renderer bytes");
  });

  it("restores original bytes after a successful evidence run", () => {
    const file = fixture();
    const patch = patchRendererAsset(file, "replacement");
    expect(readFileSync(file, "utf8")).toBe("replacement");
    restoreRendererAsset(patch);
    expect(readFileSync(file, "utf8")).toBe("original renderer bytes");
  });
});
