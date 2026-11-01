import type { BenchmarkReport } from "./runner.js";
import { percentile } from "./metrics.js";

export function pairedRecall(reference: BenchmarkReport, candidate: BenchmarkReport, seed = 42) {
  if (reference.suite.sha256 !== candidate.suite.sha256) throw new Error("Paired comparisons require identical dataset manifests");
  const differences: number[] = [];
  for (const a of reference.cases) {
    const b = candidate.cases.find((c) => c.id === a.id);
    if (!b || a.operations.some((o) => o.error) || b.operations.some((o) => o.error)) continue;
    const scores = (c: typeof a) => c.queries.map((q) => q.recall).filter((x): x is number => x !== null);
    const x = scores(a); const y = scores(b);
    if (!x.length || x.length !== y.length) continue;
    differences.push(y.reduce((s, v) => s + v, 0) / y.length - x.reduce((s, v) => s + v, 0) / x.length);
  }
  const samples = 2000;
  const resampled: number[] = []; // Fixed sample count; case registry is bounded by suiteSchema.
  let state = seed >>> 0;
  if (differences.length) for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let j = 0; j < differences.length; j++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      sum += differences[state % differences.length];
    }
    resampled.push(sum / differences.length);
  }
  return { reference: reference.adapter.name, candidate: candidate.adapter.name, unit: "case" as const,
    cases: differences.length, samples, seed, delta: differences.length ? differences.reduce((s, x) => s + x, 0) / differences.length : null,
    low: percentile(resampled, 0.025), high: percentile(resampled, 0.975),
    note: "Exploratory paired 95% bootstrap over fixture cases. Use independent source-family cases for held-out data; synthetic cases do not establish population reliability.",
  };
}
