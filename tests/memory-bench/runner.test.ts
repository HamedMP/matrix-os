import { describe, expect, it } from "vitest";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "../../scripts/memory-bench/baselines.js";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { suiteSchema } from "../../packages/kernel/src/memory-evaluation/contracts.js";

const suite = createSuite({ distractors: 20, seed: 7 });

describe("memory evaluation replay", () => {
  it("runs deterministic baselines with admission, retrieval, lifecycle and transfer metrics", async () => {
    const report = await runBenchmark(suite, () => createBaseline("raw-lexical"));
    expect(report.cases.length).toBe(suite.cases.length);
    expect(report.summary.queryCount).toBeGreaterThan(15);
    expect(report.summary.recall).toBeGreaterThan(0);
    expect(report.groups.isolation.hardFailures).toBe(0);
    expect(report.groups.lifecycle.hardFailures).toBe(0);
    expect(report.summary.hardFailures).toBe(3); // Excluded retention and corrections remain unsafe in the raw baseline.
    expect(report.passed).toBe(false);
    expect(report.summary.costUsd).toBe(0);
    expect(report.groups["fresh-chat"].queryCount).toBeGreaterThan(0);
    expect(report.groups["learning-transfer"].queryCount).toBeGreaterThan(0);
  });

  it("reports no-memory misses without falsely claiming a security failure", async () => {
    const report = await runBenchmark(suite, () => createBaseline("none"));
    expect(report.summary.recall).toBe(0);
    expect(report.summary.hardFailures).toBe(0);
    expect(report.summary.admissionRecall).toBe(0);
  });

  it("exposes current extractor false admissions, rather than fixing it in the harness", async () => {
    const report = await runBenchmark(suite, () => createBaseline("matrix-local"));
    expect(report.summary.admissionPrecision).toBeLessThan(1);
    expect(report.summary.admissionRecall).toBeLessThan(1);
  });

  it("does not send expectations, case IDs, categories or future inputs to the adapter", async () => {
    const received: unknown[] = [];
    await runBenchmark(suite, () => ({
      metadata: { name: "spy", version: "1", configuration: {} },
      async ingest(event) { received.push(event); return { action: "skip", placements: [] }; },
      async retrieve(query) { received.push(query); return { hits: [], status: "unknown" }; },
      async forget() {}, async revoke() {}, async close() {},
    }));
    expect(JSON.stringify(received)).not.toMatch(/"expected"|"relevant"|"group"|"caseId"/);
    expect(received.length).toBeGreaterThan(20);
  });

  it("fails closed on invented citations, leaked sources and duplicate retrieval hits", async () => {
    const small = suiteSchema.parse({ ...suite, cases: [suite.cases.find((c) => c.id === "isolation")!] });
    const report = await runBenchmark(small, () => ({
      metadata: { name: "unsafe", version: "1", configuration: {} },
      async ingest() { return { action: "retain", placements: ["fact"] }; },
      async retrieve() { return { status: "evidence", hits: [
        { sourceId: "private", start: 0, end: 6, text: "secret" },
        { sourceId: "invented", start: 0, end: 4, text: "fake" },
        { sourceId: "invented", start: 0, end: 4, text: "fake" },
      ] }; },
      async forget() {}, async revoke() {}, async close() {},
    }));
    expect(report.summary.hardFailures).toBeGreaterThan(0);
    expect(report.summary.recall).toBeNull(); // This is an abstention case.
    expect(report.cases[0].queries[0].complete).toBe(false);
    expect(report.cases[0].queries[0].violations).toContain("unauthorized-source");
    expect(report.cases[0].queries[0].violations).toContain("unknown-source");
    expect(report.cases[0].queries[0].violations).toContain("duplicate-hit");
  });

  it("records timeouts/errors as failures and always closes adapters", async () => {
    let closed = 0;
    const report = await runBenchmark({ ...suite, cases: [suite.cases[0]] }, () => ({
      metadata: { name: "timeout", version: "1", configuration: {} },
      async ingest() { throw new Error("synthetic failure"); },
      async retrieve() { return { hits: [], status: "unknown" }; },
      async forget() {}, async revoke() {}, async close() { closed++; },
    }));
    expect(closed).toBe(1);
    expect(report.summary.operationErrors).toBeGreaterThan(0);
    expect(report.passed).toBe(false);
  });
});
