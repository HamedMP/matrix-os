import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { suiteSchema, LIMITS } from "../../packages/kernel/src/memory-evaluation/contracts.js";
import type { AdapterFactory, Suite } from "../../packages/kernel/src/memory-evaluation/contracts.js";
import type { BenchmarkReport } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "./baselines.js";
import type { BaselineName } from "./baselines.js";
import { pairedRecall } from "../../packages/kernel/src/memory-evaluation/statistics.js";
import { renderReport } from "./report.js";

export function buildArtifacts(reports: BenchmarkReport[], suite: Suite, maxBytes: number = LIMITS.artifactBytes) {
  const artifacts: Record<string, string> = {};
  let bytes = 0;
  const add = (name: string, content: string) => {
    bytes += Buffer.byteLength(content);
    if (bytes > maxBytes) throw new Error("Benchmark artifact byte limit exceeded");
    artifacts[name] = content;
  };
  add("results.json", JSON.stringify(reports, null, 2));
  add("suite.json", JSON.stringify(suite, null, 2));
  add("comparisons.json", JSON.stringify(reports.slice(1).map(r => pairedRecall(reports[0], r, suite.seed)), null, 2));
  add("report.html", renderReport(reports));
  return artifacts;
}

export function parseArgs(args: string[]) {
  const options = { distractors: 1000, seed: 42, repeat: 1, timeoutMs: 30000, baseline: "none,raw-lexical,matrix-local", out: "output/memory-bench", suite: "", adapter: "", trustAdapter: false, help: false, minRecall: 0, noBaselines: false };
  const numeric = { "--distractors": ["distractors", 0, 100000], "--seed": ["seed", 0, 0xffffffff], "--repeat": ["repeat", 1, 10], "--timeout-ms": ["timeoutMs", 1, 120000], "--min-recall": ["minRecall", 0, 1] } as const;
  const strings = { "--baseline": "baseline", "--out": "out", "--suite": "suite", "--adapter": "adapter" } as const;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") { options.help = true; continue; }
    if (flag === "--no-baselines") { options.noBaselines = true; continue; }
    if (flag === "--trust-adapter") { options.trustAdapter = true; continue; }
    if (flag in numeric) {
      const [key, min, max] = numeric[flag as keyof typeof numeric];
      const raw = args[++i]; const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(value) || value < min || value > max || (key !== "minRecall" && !Number.isInteger(value))) throw new Error(`Invalid ${flag}`);
      options[key] = value;
    } else if (flag in strings) {
      const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing ${flag}`);
      options[strings[flag as keyof typeof strings]] = value;
    } else throw new Error(`Unknown option ${flag}`);
  }
  const baselines = options.baseline.split(",");
  if (baselines.some((b) => !["none", "raw-lexical", "matrix-local"].includes(b))) throw new Error("Invalid baseline");
  if (options.adapter && !options.trustAdapter) throw new Error("Custom adapters execute code: pass --trust-adapter after reviewing the module");
  if (options.noBaselines && !options.adapter) throw new Error("--no-baselines requires a custom adapter");
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    process.stdout.write("Matrix memory benchmark\n\nbun run bench:memory [--distractors 10000] [--seed 42] [--repeat 3]\n  --baseline none,raw-lexical,matrix-local\n  --suite reviewed-suite.json\n  --adapter ./trusted-adapter.ts --trust-adapter\n  --out output/memory-bench --timeout-ms 30000 --min-recall 0.9\n\nOutputs JSON results, dataset manifest and an interactive HTML evidence report.\nExit 2: hard violations, operation errors or configured recall gate failed.\n");
    return 0;
  }
  let suite = createSuite({ seed: opts.seed, distractors: opts.distractors });
  if (opts.suite) {
    const info = await lstat(resolve(opts.suite));
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("Suite must be a regular JSON file under 128 MiB");
    suite = suiteSchema.parse(JSON.parse(await readFile(resolve(opts.suite), "utf8")));
  }
  const factories: Array<{ factory: AdapterFactory; baseline?: BaselineName }> = opts.noBaselines ? [] : opts.baseline.split(",").map((name) => ({ factory: () => createBaseline(name as BaselineName), baseline: name as BaselineName }));
  if (opts.adapter) {
    const plugin = await import(pathToFileURL(resolve(opts.adapter)).href);
    if (typeof plugin.default !== "function") throw new Error("Adapter must export a default factory");
    factories.push({ factory: plugin.default as AdapterFactory });
  }
  const operationCount = suite.cases.reduce((sum, c) => sum + c.steps.length, 0) * factories.length * opts.repeat;
  if (operationCount > 2000000) throw new Error("Run exceeds the two-million operation cap; reduce repeats or split the suite");
  const reports: BenchmarkReport[] = [];
  const evaluated: BenchmarkReport[] = [];
  let reportBytes = 0;
  // Leave room for pretty JSON, HTML escaping and the separately retained dataset.
  const maxDataBytes = LIMITS.artifactBytes / 16;
  for (const { factory, baseline } of factories) {
    for (let i = 0; i < opts.repeat; i++) {
      const remaining = maxDataBytes - reportBytes;
      if (remaining < 1024 * 1024) throw new Error("Aggregate benchmark report byte limit exceeded");
      const report = await runBenchmark(suite, factory, { timeoutMs: opts.timeoutMs, maxReportBytes: Math.min(LIMITS.reportBytes, Math.floor(remaining)) });
      reportBytes += Buffer.byteLength(JSON.stringify(report)) + 2;
      if (reportBytes > maxDataBytes) throw new Error("Aggregate benchmark report byte limit exceeded");
      reports.push(report);
      if (opts.adapter ? baseline === undefined : baseline !== "none") evaluated.push(report);
    }
  }
  const artifacts = buildArtifacts(reports, suite);
  // A unique retained artifact directory, never a temporary file or overwrite.
  const destination = join(resolve(opts.out), `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(destination, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) await writeFile(join(destination, name), content, { flag: "wx", mode: 0o600 });
  for (const r of reports) process.stdout.write(`${r.adapter.name}: recall=${r.summary.recall?.toFixed(3) ?? "unmeasured"}, admission precision=${r.summary.admissionPrecision?.toFixed(3) ?? "unmeasured"}, hard violations=${r.summary.hardFailures}, errors=${r.summary.operationErrors}\n`);
  process.stdout.write(`Report: ${join(destination, "report.html")}\n`);
  const gated = evaluated.length ? evaluated : reports;
  return gated.every((r) => r.passed && (opts.minRecall === 0 || (r.summary.recall !== null && r.summary.recall >= opts.minRecall))) ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? `Memory benchmark failed: ${error.name}. Check inputs and adapter configuration.\n` : "Memory benchmark failed.\n");
    process.exitCode = 1;
  });
}
