import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, buildArtifacts } from "../../scripts/memory-bench/cli.js";
import { renderReport } from "../../scripts/memory-bench/report.js";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "../../scripts/memory-bench/baselines.js";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";
import { viewerScript } from "../../scripts/memory-bench/viewer.js";

describe("memory benchmark CLI and explorer", () => {
  it("labels clipped context honestly and prevents copying an incomplete scored context", async () => {
    const report = await runBenchmark(createSuite({ distractors: 0 }), () => createBaseline("raw-lexical"));
    const query = report.cases[0].queries[0];
    query.evidenceTruncated = true;
    Object.assign(query.evidence[0], { truncated: false });
    report.cases[0].queries.push({ ...query, evidenceTruncated: false });
    class Element {
      textContent = ""; value = ""; className = ""; disabled = false;
      children: Element[] = []; events: Record<string, () => unknown> = {};
      append(...elements: Element[]) { this.children.push(...elements); }
      replaceChildren(...elements: Element[]) { this.children = elements; }
      addEventListener(type: string, callback: () => unknown) { this.events[type] = callback; }
    }
    const elements: Record<string, Element> = {};
    for (const id of ["data", "cards", "metadata", "groups", "cases", "filter", "detail", "context", "contextStatus", "copy", "adapter"]) elements[id] = new Element();
    elements.data.textContent = JSON.stringify([report]);
    const writeText = vi.fn();
    runInNewContext(viewerScript, { document: { getElementById: (id: string) => elements[id], createElement: () => new Element() }, navigator: { clipboard: { writeText } } });
    const descendants = (element: Element): Element[] => element.children.flatMap(child => [child, ...descendants(child)]);
    const clipped = descendants(elements.detail).find(e => e.textContent === "Preview clipped context (copy unavailable)")!;
    expect(clipped).toBeDefined();
    clipped.events.click();
    expect(elements.copy.disabled).toBe(true);
    expect(elements.contextStatus.textContent).toContain("may omit text credited by the score");
    await elements.copy.events.click();
    expect(writeText).not.toHaveBeenCalled();
    const intact = descendants(elements.detail).find(e => e.textContent === "Preview source excerpt")!;
    intact.events.click();
    expect(elements.copy.disabled).toBe(false);
    await elements.copy.events.click();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(query.evidence[0].text));
    const complete = descendants(elements.detail).find(e => e.textContent === "Preview complete retrieved context");
    expect(complete).toBeDefined();
    complete!.events.click();
    expect(elements.copy.disabled).toBe(false);
    await elements.copy.events.click();
    expect(writeText).toHaveBeenCalled();
  });
  it("renders a truthful diagnostic when no run fits the aggregate budget", () => {
    expect(renderReport([], { status: "incomplete", reason: "aggregate-report-limit", retainedRuns: 0, plannedRuns: 1 })).toContain("Benchmark run incomplete");
  });
  it("bounds the combined retained artifacts before any files are written", async () => {
    const suite = createSuite({ distractors: 0 });
    const report = await runBenchmark(suite, () => createBaseline("none"));
    const artifacts = buildArtifacts([report], suite);
    const bytes = Object.values(artifacts).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
    expect(() => buildArtifacts([report], suite, bytes - 1)).toThrow(/byte limit/);
    expect(Object.keys(buildArtifacts([report], suite, bytes))).toHaveLength(4);
  });
  it("validates arguments and requires explicit opt-in for custom executable adapters", () => {
    expect(parseArgs(["--distractors", "10000", "--seed", "8", "--repeat", "2"]).distractors).toBe(10000);
    expect(() => parseArgs(["--distractors", "NaN"])).toThrow();
    expect(() => parseArgs(["--adapter", "./adapter.ts"])).toThrow(/trust/);
    expect(parseArgs(["--adapter", "./adapter.ts", "--trust-adapter"]).adapter).toBe("./adapter.ts");
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(() => parseArgs(["--repeat", "0"])).toThrow();
  });
  it("escapes malicious source content and renders navigable evidence and context preview", async () => {
    const report = await runBenchmark(createSuite({ distractors: 0 }), () => createBaseline("raw-lexical"));
    report.adapter.name = "</script><script>alert(1)</script>";
    const html = renderReport([report]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Evidence navigator");
    expect(html).toContain("New Chat context preview");
    expect(html).toContain("application/json");
    expect(html).toContain("Content-Security-Policy");
  });
});
