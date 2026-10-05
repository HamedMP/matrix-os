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
  it("gates the evaluated custom adapter while retaining comparison controls", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await temp();
    const suite = createSuite({ distractors: 0 });
    const suitePath = join(dir, "input.json");
    await writeFile(suitePath, JSON.stringify({ ...suite, cases: [suite.cases.find(c => c.id === "preference")] }));
    const adapterPath = join(dir, "adapter.mjs");
    await writeFile(adapterPath, `export default () => { let source; return { metadata: { name: 'evaluated', version: '1', configuration: {} }, async ingest(s) { source=s; return {action:'retain',placements:['preference']} }, async retrieve() { return {status:'evidence',hits:[{sourceId:source.id,text:source.text,start:0,end:source.text.length}]} }, async forget(){}, async revoke(){}, async close(){} }; };`);
    expect(await main(["--suite", suitePath, "--adapter", adapterPath, "--trust-adapter", "--out", join(dir, "runs"), "--min-recall", "0.9"])).toBe(0);
    const [run] = await readdir(join(dir, "runs"));
    const reports = JSON.parse(await readFile(join(dir, "runs", run, "results.json"), "utf8"));
    expect(reports.find((r: { adapter: { name: string } }) => r.adapter.name === "none").summary.recall).toBe(0);
    expect(await main(["--suite", suitePath, "--baseline", "none,raw-lexical", "--out", join(dir, "baseline-runs"), "--min-recall", "0.9"])).toBe(0);
  });
  it("retains failure artifacts when the evaluated factory cannot initialize", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await temp();
    const adapterPath = join(dir, "failed.mjs");
    await writeFile(adapterPath, `export default () => { throw new Error('private-extraction-key'); };`);
    expect(await main(["--adapter", adapterPath, "--trust-adapter", "--no-baselines", "--distractors", "0", "--out", join(dir, "runs")])).toBe(2);
    const [run] = await readdir(join(dir, "runs"));
    const json = await readFile(join(dir, "runs", run, "results.json"), "utf8");
    expect(json).not.toContain("private-extraction-key");
    expect(JSON.parse(json)[0].summary.operationErrors).toBeGreaterThan(0);
    expect(await readdir(join(dir, "runs", run))).toHaveLength(4);
  });
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
