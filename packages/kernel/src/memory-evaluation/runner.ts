import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { admissionSchema, LIMITS, metadataSchema, retrievalSchema, suiteSchema, telemetrySchema } from "./contracts.js";
import type { AdapterFactory, MemoryAdapter, Metadata, Source, Suite } from "./contracts.js";
import { contextText, estimateTokens } from "./context.js";
import { scoreQuery, summarize } from "./metrics.js";
import type { AdmissionScore, Operation, QueryScore } from "./metrics.js";

export interface QueryResult extends QueryScore {
  text: string; expectedIds: string[]; retrievedIds: string[];
  latencyMs: number; estimatedTokens: number; context: string; evidenceTruncated: boolean;
  evidence: Array<{ sourceId: string; path: string; text: string; start: number; end: number; truncated?: boolean }>;
}
export interface CaseResult {
  id: string; group: string; queries: QueryResult[]; admissions: AdmissionScore[]; operations: Operation[];
}
export interface BenchmarkReport {
  formatVersion: "1"; suite: { name: string; seed: number; split: string; sha256: string; cases: number };
  runtime: { node: string; bun: string | null; platform: string; arch: string };
  adapter: Metadata; createdAt: string; passed: boolean; cases: CaseResult[];
  resourceLimits: { maxReportBytes: number; evidenceHitChars: number; evidenceQueryChars: number; stoppedEarly: boolean; collectionLimit: number };
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
export async function runBenchmark(input: Suite, factory: AdapterFactory, options: { timeoutMs?: number; maxReportBytes?: number; collectionLimit?: number } = {}): Promise<BenchmarkReport> {
  const suite = suiteSchema.parse(input);
  const timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid operation timeout");
  const maxReportBytes = options.maxReportBytes ?? LIMITS.reportBytes;
  // Reserve bounded metadata, case headers, group summaries and final error receipts.
  const overhead = 256 * 1024 + suite.cases.length * 1024 + new Set(suite.cases.map(c => c.group)).size * 4096;
  if (!Number.isInteger(maxReportBytes) || maxReportBytes < Math.max(1024 * 1024, overhead) || maxReportBytes > LIMITS.reportBytes) throw new Error("Invalid report byte limit for this suite");
  const collectionLimit = options.collectionLimit ?? LIMITS.sources;
  if (!Number.isInteger(collectionLimit) || collectionLimit < 1 || collectionLimit > LIMITS.sources) throw new Error("Invalid collection limit");
  const checkCapacity = (collection: Map<string, unknown> | Set<string>, key: string) => {
    if (!collection.has(key) && collection.size >= collectionLimit) throw new Error("Benchmark collection limit exceeded");
  };
  let traceBytes = 0;
  let stoppedEarly = false;
  const retain = (...records: unknown[]) => {
    const bytes = records.reduce<number>((total, record) => total + Buffer.byteLength(JSON.stringify(record)) + 2, 0);
    if (traceBytes + bytes > maxReportBytes - overhead) throw new Error("Benchmark report limit exceeded");
    traceBytes += bytes;
  };
  const cases: CaseResult[] = [];
  let metadata: Metadata | undefined;
  for (const c of suite.cases) {
    const result: CaseResult = { id: c.id, group: c.group, queries: [], admissions: [], operations: [] };
    cases.push(result);
    const sources = new Map<string, Source>(); // Abort on capacity; finally drains the entire case without score-changing eviction.
    const deleted = new Set<string>();
    const revoked = new Set<string>();
    let adapter: MemoryAdapter | undefined;
    const initializedAt = performance.now();
    try {
      adapter = await bounded(async (signal) => {
        const created = await factory(signal);
        if (signal.aborted) {
          // A cooperative factory may finish after its caller's deadline. The late
          // instance never runs steps; close it without mutating a returned report.
          try { await bounded(() => created.close(), timeoutMs); }
          catch { console.error("[memory-bench] late adapter cleanup failed"); }
          throw new Error("Benchmark operation timed out");
        }
        return created;
      }, timeoutMs);
      const activeAdapter = adapter;
      const currentMetadata = metadataSchema.parse(adapter.metadata);
      if (metadata && JSON.stringify(metadata) !== JSON.stringify(currentMetadata)) throw new Error("Adapter configuration changed across cases");
      metadata = currentMetadata;
      for (const step of c.steps) {
        const started = performance.now();
        try {
          if (step.type === "ingest") {
            const existing = sources.get(step.source.id);
            if (existing && JSON.stringify(existing) !== JSON.stringify(step.source)) throw new Error("Source revisions require distinct IDs");
            checkCapacity(sources, step.source.id);
            sources.set(step.source.id, structuredClone(step.source));
            const admitted = admissionSchema.parse(await bounded((signal) => activeAdapter.ingest(structuredClone(step.source), signal), timeoutMs));
            const admission = { group: c.group, sourceId: step.source.id, path: step.source.path, expectedPlacements: step.expected.placements, placements: admitted.placements, expectedRetain: step.expected.action === "retain", retained: admitted.action === "retain",
              violations: !step.expected.retentionAllowed && admitted.action === "retain" ? ["retention-policy-violation"] : [],
              placementCorrect: admitted.placements.length === step.expected.placements.length && step.expected.placements.every((p) => admitted.placements.includes(p)),
            };
            const operation = { kind: "ingest", latencyMs: performance.now() - started, costUsd: admitted.telemetry?.costUsd ?? null, telemetry: admitted.telemetry, calls: admitted.telemetry?.calls?.length };
            retain(admission, operation); result.admissions.push(admission); result.operations.push(operation);
          } else if (step.type === "query") {
            const response = retrievalSchema.parse(await bounded((signal) => activeAdapter.retrieve(structuredClone(step.query), signal), timeoutMs));
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
            const score = scoreQuery(step.expected, scoreIds, response.status, step.query.limit);
            if (violations.length) score.complete = false;
            const latencyMs = performance.now() - started;
            // Scores and token estimates above use complete validated responses. Only
            // the retained viewer preview is clipped, with exact adjusted citation spans.
            let previewRemaining = LIMITS.evidenceQueryChars as number;
            let evidenceTruncated = false;
            const evidence = valid.flatMap(hit => {
              const text = hit.text.slice(0, Math.min(LIMITS.evidenceHitChars, previewRemaining));
              previewRemaining -= text.length;
              const truncated = text.length < hit.text.length;
              if (truncated) evidenceTruncated = true;
              return text ? [{ ...hit, text, truncated, end: hit.start + text.length, path: sources.get(hit.sourceId)!.path }] : [];
            });
            const context = (evidenceTruncated ? "[Evidence preview truncated; metrics use the full response.]\n" : "") + contextText(evidence);
            const query: QueryResult = { ...score, group: c.group, violations, text: step.query.text, expectedIds: step.expected.relevant,
              retrievedIds: response.hits.map((h) => h.sourceId), estimatedTokens, latencyMs, context, evidence, evidenceTruncated };
            const operation = { kind: "query", latencyMs, costUsd: response.telemetry?.costUsd ?? null, telemetry: response.telemetry, calls: response.telemetry?.calls?.length };
            retain(query, operation); result.queries.push(query); result.operations.push(operation);
          } else {
            checkCapacity(step.type === "forget" ? deleted : revoked, step.type === "forget" ? step.sourceId : step.scope);
            const response = step.type === "forget"
              ? await bounded((signal) => activeAdapter.forget(step.sourceId, signal), timeoutMs)
              : await bounded((signal) => activeAdapter.revoke(step.scope, signal), timeoutMs);
            const telemetry = response?.telemetry ? telemetrySchema.parse(response.telemetry) : undefined;
            if (step.type === "forget") deleted.add(step.sourceId); else revoked.add(step.scope);
            const operation = { kind: step.type, latencyMs: performance.now() - started, costUsd: telemetry?.costUsd ?? null, telemetry, calls: telemetry?.calls?.length };
            retain(operation); result.operations.push(operation);
          }
        } catch (error) {
          // Reports must not carry provider errors, credentials or private paths.
          stoppedEarly = error instanceof Error && error.message === "Benchmark report limit exceeded";
          result.operations.push({ kind: step.type, latencyMs: performance.now() - started, costUsd: null,
            error: stoppedEarly ? "report-limit" : error instanceof Error && error.message === "Benchmark collection limit exceeded" ? "collection-limit" : error instanceof Error && error.message === "Benchmark operation timed out" ? "timeout" : "operation-failed" });
          break; // An aborted adapter must not continue mutating the same namespace.
        }
      }
    } catch (error) {
      result.operations.push({ kind: "initialize", latencyMs: performance.now() - initializedAt, costUsd: null,
        error: error instanceof Error && error.message === "Benchmark operation timed out" ? "timeout" : "initialization-failed" });
    } finally {
      try { if (adapter) await bounded(() => adapter!.close(), timeoutMs); }
      catch (error) { result.operations.push({ kind: "close", latencyMs: 0, costUsd: null, error: error instanceof Error ? "cleanup-failed" : "cleanup-failed" }); }
      sources.clear(); deleted.clear(); revoked.clear();
    }
    if (stoppedEarly) break;
  }
  const summary = summarize(cases.flatMap((c) => c.queries), cases.flatMap((c) => c.operations), cases.flatMap((c) => c.admissions));
  const groups: BenchmarkReport["groups"] = Object.create(null);
  for (const group of [...new Set(cases.map((c) => c.group))]) {
    const selected = cases.filter((c) => c.group === group);
    groups[group] = summarize(selected.flatMap((c) => c.queries), selected.flatMap((c) => c.operations), selected.flatMap((c) => c.admissions));
  }
  return { formatVersion: "1", runtime: { node: process.versions.node, bun: process.versions.bun ?? null, platform: process.platform, arch: process.arch }, adapter: metadata ?? { name: "uninitialized-adapter", version: "unknown", configuration: {} }, createdAt: new Date().toISOString(),
    suite: { name: suite.name, seed: suite.seed, split: suite.split, sha256: createHash("sha256").update(JSON.stringify(suite)).digest("hex"), cases: suite.cases.length },
    passed: summary.hardFailures === 0 && summary.operationErrors === 0, cases, summary, groups,
    resourceLimits: { maxReportBytes, evidenceHitChars: LIMITS.evidenceHitChars, evidenceQueryChars: LIMITS.evidenceQueryChars, stoppedEarly, collectionLimit },
  };
}
