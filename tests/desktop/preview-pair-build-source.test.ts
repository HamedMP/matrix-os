import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as source from "../../scripts/release/build-source.mjs";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "matrix-pair-build-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, stdio: "pipe" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Pair fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "source.txt"), "controller"); git("add", "."); git("commit", "-m", "controller"); const controller = git("rev-parse", "HEAD");
  writeFileSync(join(root, "source.txt"), "candidate"); git("add", "."); git("commit", "-m", "candidate");
  return { root, controller, candidate: git("rev-parse", "HEAD") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = (root: string, env: Record<string,string>) => (source as any).readDesktopBuildSource?.(root, env);
describe("candidate desktop packaging source", () => {
  it("embeds the actual candidate checkout while execution stays on the reviewed controller", () => {
    const f = fixture(); expect(read(f.root, { GITHUB_SHA: f.controller, MATRIX_DESKTOP_SOURCE_SHA: f.candidate })).toEqual({ commit: f.candidate, ancestors: [f.controller] });
  });
  it("rejects a named candidate that differs from the checkout", () => {
    const f = fixture(); expect(() => read(f.root, { GITHUB_SHA: f.controller, MATRIX_DESKTOP_SOURCE_SHA: f.controller })).toThrow(/checkout/);
  });
  it("retains the ordinary release source contract", () => {
    const f = fixture(); expect(read(f.root, { GITHUB_SHA: f.candidate })?.commit).toBe(f.candidate);
    expect(() => read(f.root, { GITHUB_SHA: f.controller })).toThrow(/checkout/);
  });
  it("rejects branch selectors and dirty candidate bytes", () => {
    const f = fixture(); expect(() => read(f.root, { MATRIX_DESKTOP_SOURCE_SHA: "main" })).toThrow(/commit/);
    writeFileSync(join(f.root, "source.txt"), "unreviewed bytes");
    expect(() => read(f.root, { MATRIX_DESKTOP_SOURCE_SHA: f.candidate })).toThrow(/uncommitted/);
  });
  it("wires the producer into the real Electron build", () => {
    expect(readFileSync("desktop/electron.vite.config.ts", "utf8")).toContain('readDesktopBuildSource(resolve(__dirname, ".."), process.env)');
  });
});
