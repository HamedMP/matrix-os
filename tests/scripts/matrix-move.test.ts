import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const execFile = promisify(execFileCallback);
const script = resolve("skills/matrix/move/scripts/snapshot.mjs");
const temporary: string[] = [];
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "matrix-move-test-"));
  temporary.push(path);
  await mkdir(join(path, "source"));
  return { path, source: join(path, "source") };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Matrix move workspace snapshot", () => {
  it("does not traverse ignored dependency directories", async () => {
    const { source } = await fixture();
    await execFile("git", ["init", "-q"], { cwd: source });
    await writeFile(join(source, ".gitignore"), "vendor/\n");
    await writeFile(join(source, "main.ts"), "selected source");
    const ignored = join(source, "vendor", ...Array.from({ length: 66 }, () => "dependency"));
    await mkdir(ignored, { recursive: true });
    await writeFile(join(ignored, "generated.txt"), "ignored content");
    const { stdout } = await execFile(process.execPath, [script, source]);
    const result = JSON.parse(stdout); temporary.push(result.directory);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([".gitignore", "main.ts"]);
  });
  it("captures dirty and untracked files, excludes secrets/ignored files/symlinks, and verifies archive bytes", async () => {
    const { path, source } = await fixture();
    await execFile("git", ["init", "-q"], { cwd: source });
    await writeFile(join(source, "code.ts"), "old");
    await writeFile(join(source, ".env"), "PRIVATE_VALUE=hidden");
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await execFile("git", ["add", "."], { cwd: source });
    await writeFile(join(source, "code.ts"), "current");
    await writeFile(join(source, "new.txt"), "new work");
    await writeFile(join(source, "ignored.txt"), "ignored");
    await writeFile(join(source, "run.sh"), "#!/bin/sh\ntrue\n");
    await chmod(join(source, "run.sh"), 0o755);
    await symlink(join(source, "code.ts"), join(source, "link"));
    const { stdout } = await execFile(process.execPath, [script, source]);
    const result = JSON.parse(stdout);
    temporary.push(result.directory);
    expect(result.projectPath).toMatch(/^projects\/source-[a-f0-9-]+$/);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([".gitignore", "code.ts", "new.txt", "run.sh"]);
    expect(manifest.skipped).toEqual(expect.arrayContaining([
      { path: ".env", reason: "excluded" }, { path: "link", reason: "symlink" },
    ]));
    const archive = Buffer.concat(await Promise.all(result.parts.map((part: string) => readFile(part))));
    expect(createHash("sha256").update(archive).digest("hex")).toBe(result.sha256);
    const output = join(path, "extracted"); await mkdir(output);
    const localArchive = join(path, "snapshot.tgz"); await writeFile(localArchive, archive);
    await execFile("tar", ["-xzf", localArchive, "-C", output]);
    expect(await readFile(join(output, "code.ts"), "utf8")).toBe("current");
    expect(await readFile(join(output, "new.txt"), "utf8")).toBe("new work");
    expect(JSON.parse(await readFile(join(output, ".matrix-move/manifest.json"), "utf8")).files).toEqual(manifest.files);
    expect(await execFile("tar", ["-tzf", localArchive])).toMatchObject({ stdout: expect.not.stringContaining(".env") });
  }, 30_000);

  it("supports folders without Git and preserves a continuation brief", async () => {
    const { path, source } = await fixture();
    await mkdir(join(source, "nested"));
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "nested/notes.md"), "project notes");
    await writeFile(join(source, "node_modules/secret"), "excluded");
    const brief = join(path, "brief.md"); await writeFile(brief, "Continue the selected task.");
    const { stdout } = await execFile(process.execPath, [script, source, "--brief", brief]);
    const result = JSON.parse(stdout); temporary.push(result.directory);
    const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["nested/notes.md"]);
    expect(manifest.git).toBeNull();
    expect(manifest.briefIncluded).toBe(true);
    expect(manifest.brief).toEqual({ bytes: 27, sha256: createHash("sha256").update("Continue the selected task.").digest("hex") });
  });

  it("rejects nonexistent roots and pre-existing handoff metadata instead of overwriting", async () => {
    const { source } = await fixture();
    await expect(execFile(process.execPath, [script, join(source, "missing")])).rejects.toThrow();
    await mkdir(join(source, ".matrix-move"));
    await writeFile(join(source, ".matrix-move/manifest.json"), "owner data");
    await expect(execFile(process.execPath, [script, source])).rejects.toMatchObject({ stderr: expect.stringContaining("reserved") });
    expect(await readFile(join(source, ".matrix-move/manifest.json"), "utf8")).toBe("owner data");
  });

  it("splits incompressible content into bounded upload parts without losing source bytes", async () => {
    const { path, source } = await fixture();
    const bytes = randomBytes(9 * 1024 * 1024);
    await writeFile(join(source, "asset.bin"), bytes);
    // Exercise the self-contained plugin distribution as well as the canonical helper.
    const packaged = resolve("plugins/matrix-os/skills/matrix-move/scripts/snapshot.mjs");
    const { stdout } = await execFile(process.execPath, [packaged, source]);
    const result = JSON.parse(stdout); temporary.push(result.directory);
    const parts = await Promise.all(result.parts.map((part: string) => readFile(part)));
    expect(parts).toHaveLength(2);
    expect(parts.every(part => part.length <= 8 * 1024 * 1024)).toBe(true);
    const archive = join(path, "reconstructed.tgz"); await writeFile(archive, Buffer.concat(parts));
    const restored = join(path, "restored"); await mkdir(restored);
    await execFile("tar", ["-xzf", archive, "-C", restored]);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(digest(await readFile(join(restored, "asset.bin")))).toBe(digest(bytes));
    expect(digest(await readFile(join(source, "asset.bin")))).toBe(digest(bytes));
  }, 30_000);
});
