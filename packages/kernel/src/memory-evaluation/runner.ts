import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { admissionSchema, LIMITS, metadataSchema, retrievalSchema, suiteSchema, telemetrySchema } from "./contracts.js";
import type { AdapterFactory, Metadata, Source, Suite } from "./contracts.js";
import { contextText, estimateTokens } from "./context.js";
import { scoreQuery, summarize } from "./metrics.js";
import type { AdmissionScore, Operation, QueryScore } from "./metrics.js";

export interface QueryResult extends QueryScore {
  text: string; expectedIds: string[]; retrievedIds: string[];
  latencyMs: number; estimatedTokens: number; context: string;
  evidence: Array<{ sourceId: string; path: string; text: string; start: number; end: number }>;
}
export interface CaseResult {
  id: string; group: string; queries: QueryResult[]; admissions: AdmissionScore[]; operations: Operation[];
}
export interface BenchmarkReport {
  formatVersion: "1"; suite: { name: string; seed: number; split: string; sha256: string; cases: number };
  runtime: { node: string; bun: string | null; platform: string; arch: string };
  adapter: Metadata; createdAt: string; passed: boolean; cases: CaseResult[];
  summary: ReturnType<typeof summarize>; groups: Record<string, ReturnType<typeof summarize>>;
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Benchmark operation timed out")); }, timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
export async function runBenchmark(input: Suite, factory: AdapterFactory, options: { timeoutMs?: number } = {}): Promise<BenchmarkReport> {
  const suite = suiteSchema.parse(input);
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid operation timeout");
  const cases: CaseResult[] = [];
  let metadata: Metadata | undefined;
  for (const c of suite.cases) {
    const result: CaseResult = { id: c.id, group: c.group, queries: [], admissions: [], operations: [] };
    cases.push(result);
    const sources = new Map<string, Source>(); // Bounded by validated step count; disposed after this case.
    const deleted = new Set<string>();
    const revoked = new Set<string>();
    const adapter = await bounded((signal) => Promise.resolve(factory(signal)), timeoutMs);
    try {
      const currentMetadata = metadataSchema.parse(adapter.metadata);
      if (metadata && JSON.stringify(metadata) !== JSON.stringify(currentMetadata)) throw new Error("Adapter configuration changed across cases");
      metadata = currentMetadata;
      for (const step of c.steps) {
        const started = performance.now();
        try {
          if (step.type === "ingest") {
            const existing = sources.get(step.source.id);
            if (existing && JSON.stringify(existing) !== JSON.stringify(step.source)) throw new Error("Source revisions require distinct IDs");
            sources.set(step.source.id, structuredClone(step.source));
            const admitted = admissionSchema.parse(await bounded((signal) => adapter.ingest(structuredClone(step.source), signal), timeoutMs));
            result.admissions.push({ group: c.group, sourceId: step.source.id, path: step.source.path, expectedPlacements: step.expected.placements, placements: admitted.placements, expectedRetain: step.expected.action === "retain", retained: admitted.action === "retain",
              violations: !step.expected.retentionAllowed && admitted.action === "retain" ? ["retention-policy-violation"] : [],
              placementCorrect: admitted.placements.length === step.expected.placements.length && step.expected.placements.every((p) => admitted.placements.includes(p)),
            });
            result.operations.push({ kind: "ingest", latencyMs: performance.now() - started, costUsd: admitted.telemetry?.costUsd ?? null, telemetry: admitted.telemetry, calls: admitted.telemetry?.calls?.length });
          } else if (step.type === "query") {
            const response = retrievalSchema.parse(await bounded((signal) => adapter.retrieve(structuredClone(step.query), signal), timeoutMs));
            const violations: string[] = [];
            const addViolation = (v: string) => { if (!violations.includes(v)) violations.push(v); };
            const seen = new Set<string>();
            const valid: typeof response.hits = [];
            const scoreIds = response.hits.map((_, rank) => `/invalid-hit/${rank}`);
            for (const [rank, hit] of response.hits.entries()) {
              const source = sources.get(hit.sourceId);
              if (seen.has(hit.sourceId)) { addViolation("duplicate-hit"); continue; }
              seen.add(hit.sourceId);
              if (!source) { addViolation("unknown-source"); continue; }
              if (!step.query.scopes.includes(source.scope) || revoked.has(source.scope)) { addViolation("unauthorized-source"); continue; }
              if (deleted.has(source.id)) { addViolation("deleted-source"); continue; }
              if (Date.parse(source.observedAt) > Date.parse(step.query.knownAt ?? step.query.at)) { addViolation("future-source"); continue; }
              if (step.expected.forbidden.includes(source.id)) { addViolation("forbidden-source"); continue; }
              // Offsets are UTF-16 code units in the exact normalized fixture buffer.
              if (hit.end <= hit.start || hit.end > source.text.length || source.text.slice(hit.start, hit.end) !== hit.text) { addViolation("invalid-citation"); continue; }
              valid.push(hit);
              const required = step.expected.requiredText && Object.hasOwn(step.expected.requiredText, hit.sourceId) ? step.expected.requiredText[hit.sourceId] : undefined;
              if (!required || hit.text.includes(required)) scoreIds[rank] = hit.sourceId;
            }
            const estimatedTokens = estimateTokens(response.hits);
            if (estimatedTokens > step.query.budgetTokens) addViolation("context-budget-exceeded");
            if (response.hits.length > step.query.limit) addViolation("candidate-limit-exceeded");
            const score = scoreQuery(step.expected, scoreIds, response.status);
            if (violations.length) score.complete = false;
            const latencyMs = performance.now() - started;
            result.queries.push({ ...score, group: c.group, violations, text: step.query.text, expectedIds: step.expected.relevant,
              retrievedIds: response.hits.map((h) => h.sourceId), estimatedTokens, latencyMs, context: contextText(valid),
              evidence: valid.map((h) => ({ ...h, path: sources.get(h.sourceId)!.path })),
            });
            result.operations.push({ kind: "query", latencyMs, costUsd: response.telemetry?.costUsd ?? null, telemetry: response.telemetry, calls: response.telemetry?.calls?.length });
          } else {
            const response = step.type === "forget"
              ? await bounded((signal) => adapter.forget(step.sourceId, signal), timeoutMs)
              : await bounded((signal) => adapter.revoke(step.scope, signal), timeoutMs);
            const telemetry = response?.telemetry ? telemetrySchema.parse(response.telemetry) : undefined;
            if (step.type === "forget") deleted.add(step.sourceId); else revoked.add(step.scope);
            result.operations.push({ kind: step.type, latencyMs: performance.now() - started, costUsd: telemetry?.costUsd ?? null, telemetry, calls: telemetry?.calls?.length });
          }
        } catch (error) {
          // Reports must not carry provider errors, credentials or private paths.
          result.operations.push({ kind: step.type, latencyMs: performance.now() - started, costUsd: null,
            error: error instanceof Error && error.message === "Benchmark operation timed out" ? "timeout" : "operation-failed" });
          break; // An aborted adapter must not continue mutating the same namespace.
        }
      }
    } finally {
      try { await bounded(() => adapter.close(), timeoutMs); }
      catch (error) { result.operations.push({ kind: "close", latencyMs: 0, costUsd: null, error: error instanceof Error ? "cleanup-failed" : "cleanup-failed" }); }
      sources.clear(); deleted.clear(); revoked.clear();
    }
  }
  const summary = summarize(cases.flatMap((c) => c.queries), cases.flatMap((c) => c.operations), cases.flatMap((c) => c.admissions));
  const groups: BenchmarkReport["groups"] = Object.create(null);
  for (const group of [...new Set(cases.map((c) => c.group))]) {
    const selected = cases.filter((c) => c.group === group);
    groups[group] = summarize(selected.flatMap((c) => c.queries), selected.flatMap((c) => c.operations), selected.flatMap((c) => c.admissions));
  }
  return { formatVersion: "1", runtime: { node: process.versions.node, bun: process.versions.bun ?? null, platform: process.platform, arch: process.arch }, adapter: metadata!, createdAt: new Date().toISOString(),
    suite: { name: suite.name, seed: suite.seed, split: suite.split, sha256: createHash("sha256").update(JSON.stringify(suite)).digest("hex"), cases: suite.cases.length },
    passed: summary.hardFailures === 0 && summary.operationErrors === 0, cases, summary, groups,
  };
}
