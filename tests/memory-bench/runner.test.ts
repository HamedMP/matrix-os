import { describe, expect, it } from "vitest";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "../../scripts/memory-bench/baselines.js";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { suiteSchema, LIMITS } from "../../packages/kernel/src/memory-evaluation/contracts.js";

const suite = createSuite({ distractors: 20, seed: 7 });

describe("memory evaluation replay", () => {
  it("aborts capped case collections and drains instead of evicting scored sources", async () => {
    const input = structuredClone({ ...suite, cases: [suite.cases[0]] });
    const ingest = input.cases[0].steps[0];
    if (ingest.type !== "ingest") throw new Error("fixture");
    input.cases[0].steps.splice(1, 0, { ...structuredClone(ingest), source: { ...ingest.source, id: "second", path: "second.md" } });
    const report = await runBenchmark(input, () => createBaseline("none"), { collectionLimit: 1 });
    expect(report.passed).toBe(false);
    expect(report.cases[0].operations.at(-1)?.error).toBe("collection-limit");
    expect(report.cases[0].queries).toHaveLength(0);
    const baseline = createBaseline("raw-lexical", { collectionLimit: 1 });
    await baseline.ingest(ingest.source, AbortSignal.timeout(1000));
    await expect(baseline.ingest({ ...ingest.source, id: "second" }, AbortSignal.timeout(1000))).rejects.toThrow(/collection limit/);
    const query = input.cases[0].steps.at(-1);
    if (query?.type !== "query") throw new Error("fixture");
    await expect(baseline.retrieve(query.query, AbortSignal.timeout(1000))).rejects.toThrow(/closed/);
    await baseline.close();
  });
  it("retains only extracted candidates, not unrelated text from the original message", async () => {
    const baseline = createBaseline("matrix-local");
    const text = "Unrelated launch code ORANGE.\nI prefer green tea.";
    await baseline.ingest({ id: "s", scope: "personal", path: "notes/s.md", text, role: "user", observedAt: "2026-01-01T00:00:00Z" }, AbortSignal.timeout(1000));
    const query = { text: "ORANGE", scopes: ["personal"], at: "2026-01-01T00:00:00Z", budgetTokens: 1000, limit: 10, session: "test" };
    expect((await baseline.retrieve(query, AbortSignal.timeout(1000))).hits).toHaveLength(0);
    const response = await baseline.retrieve({ ...query, text: "green tea" }, AbortSignal.timeout(1000));
    expect(response.hits).toEqual([{ sourceId: "s", text: "green tea", start: text.indexOf("green tea"), end: text.indexOf("green tea") + 9 }]);
    await baseline.close();
  });
  it("records rejecting and timed-out factories as per-case failures", async () => {
    const input = { ...suite, cases: suite.cases.slice(0, 2) };
    const rejected = await runBenchmark(input, () => { throw new Error("private-key-details"); });
    expect(rejected.cases).toHaveLength(2);
    expect(rejected.summary.operationErrors).toBe(2);
    expect(rejected.passed).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain("private-key-details");
    const timedOut = await runBenchmark(input, () => new Promise(() => {}), { timeoutMs: 5 });
    expect(timedOut.cases.every(c => c.operations[0].error === "timeout")).toBe(true);
    expect(timedOut.adapter.name).toBe("uninitialized-adapter");
  });
  it("closes an adapter whose factory resolves after the timeout", async () => {
    let closed = 0;
    const report = await runBenchmark({ ...suite, cases: [suite.cases[0]] }, async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ...createBaseline("none"), async close() { closed++; } };
    }, { timeoutMs: 2 });
    expect(report.summary.operationErrors).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(closed).toBe(1);
  });
  it("bounds evidence previews while scoring the complete returned text", async () => {
    const text = "x".repeat(99000) + " required evidence";
    const input = { ...suite, cases: [{ id: "large", group: "large", steps: [
      { type: "ingest", source: { id: "large", scope: "personal", path: "large.md", text, role: "document", observedAt: "2026-01-01T00:00:00Z" }, expected: { action: "retain", placements: ["source"] } },
      { type: "query", query: { text: "evidence", scopes: ["personal"], at: "2026-01-01T00:00:00Z", budgetTokens: 32000, limit: 100, session: "test" }, expected: { relevant: ["large"], status: "evidence", requiredText: { large: "required evidence" } } },
    ] }] } as unknown as Parameters<typeof runBenchmark>[0];
    const report = await runBenchmark(input, () => ({ ...createBaseline("none"), async retrieve() { return { status: "evidence", hits: [{ sourceId: "large", text, start: 0, end: text.length }] }; } }));
    const query = report.cases[0].queries[0];
    expect(query.recall).toBe(1);
    expect(query.estimatedTokens).toBeGreaterThan(24000);
    expect(query.evidence[0].text.length).toBeLessThanOrEqual(LIMITS.evidenceHitChars);
    expect(query.context).toContain("Evidence preview truncated");
    expect(query.evidenceTruncated).toBe(true);
    expect(query.evidence[0].end).toBe(query.evidence[0].text.length);
  });
  it("caps aggregate multi-hit previews without changing recall or precision", async () => {
    const text = "a".repeat(6000) + " evidence";
    const sources = Array.from({ length: 5 }, (_, index) => ({ id: `source-${index}`, scope: "personal", path: `notes/${index}.md`, text, role: "document" as const, observedAt: "2026-01-01T00:00:00Z" }));
    const input = suiteSchema.parse({ ...suite, cases: [{ id: "multi", group: "multi", steps: [
      ...sources.map(source => ({ type: "ingest", source, expected: { action: "retain", placements: ["source"] } })),
      { type: "query", query: { text: "evidence", scopes: ["personal"], at: "2026-01-01T00:00:00Z", budgetTokens: 32000, limit: 5, session: "test" }, expected: { relevant: sources.map(source => source.id), status: "evidence" } },
    ] }] });
    const report = await runBenchmark(input, () => ({ ...createBaseline("none"), async retrieve() { return { status: "evidence", hits: sources.map(source => ({ sourceId: source.id, text, start: 0, end: text.length })) }; } }));
    const query = report.cases[0].queries[0];
    expect(query.recall).toBe(1);
    expect(query.precision).toBe(1);
    expect(query.evidenceTruncated).toBe(true);
    expect(query.evidence.reduce((sum, hit) => sum + hit.text.length, 0)).toBeLessThanOrEqual(LIMITS.evidenceQueryChars);
    expect(query.retrievedIds).toHaveLength(5);
  });
  it("stops with an explicit report limit error instead of accumulating unbounded traces", async () => {
    const input = structuredClone({ ...suite, cases: [suite.cases[0]] });
    const ingest = input.cases[0].steps[0];
    const query = input.cases[0].steps[1];
    if (ingest.type !== "ingest" || query.type !== "query") throw new Error("fixture");
    ingest.source.text += "x".repeat(90000);
    input.cases[0].steps.push(...Array.from({ length: 200 }, () => structuredClone(query)));
    const report = await runBenchmark(input, () => ({ ...createBaseline("none"), async retrieve() { return { status: "evidence", hits: [{ sourceId: ingest.source.id, text: ingest.source.text, start: 0, end: ingest.source.text.length }] }; } }), { maxReportBytes: 1024 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(1024 * 1024);
    expect(report.resourceLimits.stoppedEarly).toBe(true);
    expect(report.cases[0].operations.some(o => o.error === "report-limit")).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.summary.queryCount).toBeLessThan(200);
  });
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
