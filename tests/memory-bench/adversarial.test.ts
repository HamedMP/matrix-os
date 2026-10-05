import { describe, expect, it } from "vitest";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "../../scripts/memory-bench/baselines.js";
import { suiteSchema } from "../../packages/kernel/src/memory-evaluation/contracts.js";
import type { MemoryAdapter, Retrieval } from "../../packages/kernel/src/memory-evaluation/contracts.js";

const suite = createSuite({ distractors: 0 });
const one = (id: string) => structuredClone({ ...suite, cases: [suite.cases.find((c) => c.id === id)!] });
const adapter = (hits: Retrieval["hits"], status: Retrieval["status"] = "evidence"): MemoryAdapter => ({
  ...createBaseline("none"), async retrieve() { return { hits, status }; },
});

describe("memory benchmark adversarial behavior", () => {
  it.each([
    ["invalid-citation", { sourceId: "preference", text: "fabricated", start: 0, end: 10 }],
    ["invalid-citation", { sourceId: "preference", text: "I", start: 0, end: 10000 }],
  ])("rejects %s without showing unsupported evidence", async (violation, hit) => {
    const report = await runBenchmark(one("preference"), () => adapter([hit]));
    expect(report.cases[0].queries[0].violations).toContain(violation);
    expect(report.cases[0].queries[0].context).toBe("");
  });
  it("does not award recall for the right file with the wrong evidence span", async () => {
    const report = await runBenchmark(one("preference"), () => adapter([{ sourceId: "preference", text: "I prefer", start: 0, end: 8 }]));
    expect(report.summary.recall).toBe(0);
    expect(report.summary.hardFailures).toBe(0);
  });
  it("keeps invalid candidates in precision and rank denominators", async () => {
    const input = one("preference");
    const step = input.cases[0].steps[0];
    if (step.type !== "ingest") throw new Error("fixture");
    const report = await runBenchmark(input, () => adapter([
      { sourceId: "invented", text: "fake", start: 0, end: 4 },
      { sourceId: step.source.id, text: step.source.text, start: 0, end: step.source.text.length },
    ]));
    expect(report.summary.recall).toBe(1);
    expect(report.summary.precision).toBe(0.5);
    expect(report.summary.mrr).toBe(0.5);
    expect(report.passed).toBe(false);
  });
  it("flags a context budget overrun before filtering", async () => {
    const input = one("preference");
    const query = input.cases[0].steps[1];
    if (query.type !== "query") throw new Error("fixture");
    query.query.budgetTokens = 1;
    const source = input.cases[0].steps[0];
    if (source.type !== "ingest") throw new Error("fixture");
    const report = await runBenchmark(input, () => adapter([{ sourceId: source.source.id, text: source.source.text, start: 0, end: source.source.text.length }]));
    expect(report.cases[0].queries[0].violations).toContain("context-budget-exceeded");
    expect(report.passed).toBe(false);
  });
  it("detects deleted sources even when the adapter acknowledges forgetting", async () => {
    const input = one("deletion");
    const step = input.cases[0].steps[0];
    if (step.type !== "ingest") throw new Error("fixture");
    const report = await runBenchmark(input, () => adapter([{ sourceId: step.source.id, text: step.source.text, start: 0, end: step.source.text.length }]));
    expect(report.cases[0].queries[0].violations).toContain("deleted-source");
    expect(report.cases[0].queries[0].context).not.toContain("vault");
  });
  it("detects future knowledge rather than counting it as recall", async () => {
    const input = one("knowledge-time");
    const step = input.cases[0].steps[1];
    if (step.type !== "ingest") throw new Error("fixture");
    const report = await runBenchmark(input, () => adapter([{ sourceId: step.source.id, text: step.source.text, start: 0, end: step.source.text.length }]));
    expect(report.cases[0].queries[0].violations).toContain("future-source");
  });
  it("aborts timed-out work, skips the rest of the case and closes once", async () => {
    let signal: AbortSignal | undefined;
    let closed = 0;
    const report = await runBenchmark(one("preference"), () => ({
      ...createBaseline("none"),
      async ingest(_, s) { signal = s; return new Promise(() => {}); },
      async close() { closed++; },
    }), { timeoutMs: 5 });
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(1);
    expect(report.summary.operationErrors).toBe(1);
    expect(report.cases[0].queries).toHaveLength(0);
    expect(report.passed).toBe(false);
  });
  it("reports cleanup errors and preserves orchestration usage", async () => {
    const report = await runBenchmark(one("boilerplate"), () => ({
      ...createBaseline("none"),
      async ingest() { return { action: "skip", placements: [], telemetry: { costUsd: 0.01, inputTokens: 20, outputTokens: 4,
        calls: [{ id: "v1", parentId: "r1", role: "verifier", model: "test", latencyMs: 2, costUsd: 0.01 }] } }; },
      async close() { throw new Error("synthetic private provider details"); },
    }));
    expect(report.summary.operationErrors).toBe(1);
    expect(report.cases[0].operations[0].telemetry?.calls?.[0].role).toBe("verifier");
    expect(JSON.stringify(report)).not.toContain("private provider details");
  });
  it("rejects malformed adapter output, invalid timeouts and configuration drift", async () => {
    await expect(runBenchmark(one("preference"), () => createBaseline("none"), { timeoutMs: 0 })).rejects.toThrow();
    const invalid = await runBenchmark(one("preference"), () => ({ ...createBaseline("none"), async ingest() { return { action: "skip", placements: ["invented"] } as never; } }));
    expect(invalid.summary.operationErrors).toBe(1);
    let sequence = 0; let closed = 0;
    await expect(runBenchmark({ ...suite, cases: suite.cases.slice(0, 2) }, () => ({
      ...createBaseline("none"), metadata: { name: "drift", version: String(sequence++), configuration: {} }, async close() { closed++; },
    }))).rejects.toThrow(/changed/);
    expect(closed).toBe(2);
  });
  it("supports unusual group names without prototype mutation", async () => {
    const input = one("preference"); input.cases[0].group = "__proto__";
    const report = await runBenchmark(input, () => createBaseline("none"));
    expect(Object.keys(report.groups)).toContain("__proto__");
    expect(report.groups["__proto__"].queryCount).toBe(1);
  });
  it("rejects duplicate case IDs, future labels and conflicting source revisions", async () => {
    expect(() => suiteSchema.parse({ ...suite, cases: [suite.cases[0], suite.cases[0]] })).toThrow();
    const input = one("preference");
    const query = input.cases[0].steps[1];
    if (query.type !== "query") throw new Error("fixture");
    query.expected.relevant = ["future"];
    expect(() => suiteSchema.parse(input)).toThrow();
    const retry = one("retry");
    const second = retry.cases[0].steps[1];
    if (second.type !== "ingest") throw new Error("fixture");
    second.source.text = "conflicting revision";
    const report = await runBenchmark(retry, () => createBaseline("raw-lexical"));
    expect(report.summary.operationErrors).toBe(1);
  });
});
