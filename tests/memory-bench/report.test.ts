import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/memory-bench/cli.js";
import { renderReport } from "../../scripts/memory-bench/report.js";
import { runBenchmark } from "../../packages/kernel/src/memory-evaluation/runner.js";
import { createBaseline } from "../../scripts/memory-bench/baselines.js";
import { createSuite } from "../../packages/kernel/src/memory-evaluation/fixtures.js";

describe("memory benchmark CLI and explorer", () => {
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
