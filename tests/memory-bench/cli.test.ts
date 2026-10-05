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
  it("retains completed runs and a truthful failure receipt when the aggregate limit is reached", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await temp();
    expect(await main(["--baseline", "none", "--repeat", "2", "--distractors", "0", "--out", dir], { maxDataBytes: 1024 * 1024 })).toBe(2);
    const [run] = await readdir(dir);
    const reports = JSON.parse(await readFile(join(dir, run, "results.json"), "utf8"));
    const failure = JSON.parse(await readFile(join(dir, run, "run-status.json"), "utf8"));
    expect(reports).toHaveLength(1);
    expect(failure).toMatchObject({ status: "incomplete", reason: "aggregate-report-limit", retainedRuns: 1, plannedRuns: 2 });
    expect(await readFile(join(dir, run, "report.html"), "utf8")).toContain("Benchmark run incomplete");
  });
  it("retains completed reports when the dataset makes full artifacts exceed their cap", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await temp();
    const sourceText = "x".repeat(100000);
    const suite = createSuite({ distractors: 0 });
    suite.cases = [{ id: "large-dataset", group: "large-dataset", steps: Array.from({ length: 50 }, (_, index) => ({ type: "ingest" as const, source: { id: `source-${index}`, scope: "personal", path: `notes/${index}.md`, text: sourceText, role: "document" as const, observedAt: "2026-01-01T00:00:00Z" }, expected: { action: "skip" as const, placements: [], retentionAllowed: true } })) }];
    const path = join(dir, "dataset.json");
    await writeFile(path, JSON.stringify(suite));
    expect(await main(["--suite", path, "--baseline", "none", "--out", join(dir, "runs")], { maxDataBytes: 1024 * 1024, maxArtifactBytes: 4 * 1024 * 1024 + 65536 })).toBe(2);
    const [run] = await readdir(join(dir, "runs"));
    const retained = join(dir, "runs", run);
    const reports = JSON.parse(await readFile(join(retained, "results.json"), "utf8"));
    expect(reports[0].summary.admissionCount).toBe(50);
    expect(JSON.parse(await readFile(join(retained, "run-status.json"), "utf8"))).toMatchObject({ reason: "artifact-limit", omittedArtifacts: ["suite.json", "comparisons.json", "report.html evidence explorer"] });
  });
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
