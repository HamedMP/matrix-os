import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "../../scripts/memory-bench/cli.js";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function temp() { const dir = await mkdtemp(join(tmpdir(), "matrix-memory-bench-test-")); dirs.push(dir); return dir; }
describe("memory benchmark CLI lifecycle", () => {
  it("writes retained reproducible artifacts and returns a separate quality-gate exit", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await temp();
    expect(await main(["--out", dir, "--baseline", "none", "--distractors", "0"])).toBe(0);
    expect(await main(["--out", dir, "--baseline", "none", "--distractors", "0", "--min-recall", "0.9"])).toBe(2);
    const runs = await readdir(dir);
    expect(runs).toHaveLength(2);
    expect(await readdir(join(dir, runs[0]))).toEqual(["comparisons.json", "report.html", "results.json", "suite.json"]);
    const report = JSON.parse(await readFile(join(dir, runs[0], "results.json"), "utf8"));
    expect(report[0].suite.sha256).toHaveLength(64);
  });
  it("loads a reviewed dataset without silently replacing its seed or split", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await temp(); const path = join(dir, "suite.json");
    await writeFile(path, JSON.stringify({ ...createSuite({ seed: 8, distractors: 0 }), split: "test" }));
    expect(await main(["--suite", path, "--baseline", "none", "--out", join(dir, "reports")])).toBe(0);
    const [run] = await readdir(join(dir, "reports"));
    const report = JSON.parse(await readFile(join(dir, "reports", run, "results.json"), "utf8"));
    expect(report[0].suite.seed).toBe(8);
    expect(report[0].suite.split).toBe("test");
  });
  it("rejects symbolic input files and supports help without running a benchmark", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["--help"])).toBe(0);
    expect(write).toHaveBeenCalled();
    const dir = await temp(); await writeFile(join(dir, "target"), "{}"); await symlink(join(dir, "target"), join(dir, "link"));
    await expect(main(["--suite", join(dir, "link")])).rejects.toThrow(/regular/);
  });
  it.each([["--baseline", "invalid"], ["--seed", ""], ["--out"], ["--no-baselines"]])("rejects malformed flags %s", (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
});
