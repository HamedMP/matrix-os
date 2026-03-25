import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listDirectory } from "../../packages/gateway/src/files-tree.js";

describe("listDirectory (extended)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-browser-test-${Date.now()}`);
    mkdirSync(join(testDir, "sub", "nested"), { recursive: true });
    writeFileSync(join(testDir, "readme.md"), "# Hello");
    writeFileSync(join(testDir, "config.json"), '{"key": "value"}');
    writeFileSync(join(testDir, "sub", "a.txt"), "a");
    writeFileSync(join(testDir, "sub", "b.txt"), "b");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns modified timestamp for files", async () => {
    const entries = await listDirectory(testDir, "");
    const readme = entries!.find((e) => e.name === "readme.md");
    expect(readme).toBeDefined();
    expect(readme!.modified).toBeDefined();
    expect(typeof readme!.modified).toBe("string");
    expect(new Date(readme!.modified!).getTime()).toBeGreaterThan(0);
  });

  it("returns created timestamp for files", async () => {
    const entries = await listDirectory(testDir, "");
    const readme = entries!.find((e) => e.name === "readme.md");
    expect(readme!.created).toBeDefined();
  });

  it("returns mime type for files", async () => {
    const entries = await listDirectory(testDir, "");
    const readme = entries!.find((e) => e.name === "readme.md");
    expect(readme!.mime).toBe("text/markdown");
    const config = entries!.find((e) => e.name === "config.json");
    expect(config!.mime).toBe("application/json");
  });

  it("returns children count for directories", async () => {
    const entries = await listDirectory(testDir, "");
    const sub = entries!.find((e) => e.name === "sub");
    expect(sub).toBeDefined();
    expect(sub!.type).toBe("directory");
    expect(sub!.children).toBe(3);
  });

  it("returns modified timestamp for directories", async () => {
    const entries = await listDirectory(testDir, "");
    const sub = entries!.find((e) => e.name === "sub");
    expect(sub!.modified).toBeDefined();
  });

  it("skips dotfiles and dotdirs", async () => {
    mkdirSync(join(testDir, ".hidden"));
    writeFileSync(join(testDir, ".env"), "SECRET=x");
    const entries = await listDirectory(testDir, "");
    const names = entries!.map((e) => e.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".env");
  });
});
