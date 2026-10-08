import { describe, expect, it } from "vitest";
import { pageOf, queryFingerprint } from "../../packages/gateway/src/brain/brief/paging.js";
import { needsRebuild } from "../../packages/gateway/src/brain/brief/service.js";
import {
  briefSummaryEnabled, createBrainBriefSummaryProvider,
} from "../../packages/gateway/src/brain/brief/index.js";
import { summarizeBrief, summaryLines } from "../../packages/gateway/src/brain/brief/summary.js";
import {
  closedStatus, commitmentState, commitmentWords, contradiction, cutUnits, draftStatusLine, lineText, overlap,
  shapeOf, statementClauses,
} from "../../packages/gateway/src/brain/brief/text.js";
import { CALENDAR_DATE, briefWindow, parseUtcDate } from "../../packages/gateway/src/brain/brief/time.js";

const clash = (a: string, b: string) => contradiction(statementClauses(a), statementClauses(b));

describe("text rules", () => {
  it("cuts lines and quotes without splitting surrogate pairs", () => {
    expect(lineText("  a\n\tb\u0000c  ")).toBe("a b c");
    expect(lineText("x".repeat(500))).toBe(`${"x".repeat(397)}...`);
    expect(cutUnits("ab\u{1F600}", 3)).toBe("ab");
    expect(cutUnits("abc", 5)).toBe("abc");
  });

  it("reads clause shapes with negation, antonyms, values and stop words", () => {
    expect(shapeOf("The cache isn't enabled for 1,000 users")).toEqual({
      words: ["cache", "enabled", "users"], values: ["1000"], all: ["1000", "cache", "enabled", "users"], negated: true,
    });
    expect(shapeOf("Uploads are disabled").negated).toBe(true);
    expect(statementClauses("A is ready; B is off. ")).toHaveLength(2);
    expect(statementClauses("Ten parts. ".repeat(10))).toHaveLength(8);
    expect(overlap([], [])).toBe(0);
    expect(overlap(["a", "c"], ["b", "c"])).toBeCloseTo(1 / 3);
  });

  it("detects contradictions by negation or values only on matching clauses", () => {
    expect(clash("Tokens are stored in Postgres.", "Tokens are never stored in Postgres.")).toBe("polarity");
    expect(clash("At most 8 runs per owner.", "At most 16 runs per owner.")).toBe("values");
    expect(clash("Auth stays in main; no provider keys are kept.", "Auth stays in main; mobile uses the client.")).toBeNull();
    expect(clash("No release.", "Release.")).toBeNull();
    expect(clash("At most 8 runs.", "At most 8 runs.")).toBeNull();
    expect(clash("Runs 8.", "Jobs 16.")).toBeNull();
    expect(clash("Tokens never stored.", "Keys are rotated weekly.")).toBeNull();
  });

  it("reads commitment states from words, then from the status ref", () => {
    expect(commitmentState("Export API later", null)).toBe("deferred");
    expect(commitmentState("Export API shipped", null)).toBe("done");
    expect(commitmentState("Export API not shipped", null)).toBe("deferred");
    expect(commitmentState("Shipped part, deferred the rest", null)).toBeNull();
    expect(commitmentState("Export API", "completed")).toBe("done");
    expect(commitmentState("Export API", "backlog")).toBe("deferred");
    expect(commitmentState("Export API", "started")).toBeNull();
    expect(commitmentState("Export API", null)).toBeNull();
    expect(commitmentWords("Export API shipped later")).toEqual(["api", "export"]);
    expect([closedStatus("canceled"), closedStatus("cancelled"), closedStatus("done"), closedStatus("open"), closedStatus(null)])
      .toEqual([true, true, true, false, false]);
  });

  it("finds a Draft status line near the top of a spec", () => {
    expect(draftStatusLine("# T\n\n**Status**: Draft  \r\n", 300)).toBe("**Status**: Draft");
    expect(draftStatusLine("- Status: draft for review", 10)).toBe("- Status: ");
    expect(draftStatusLine("Status: Approved\nStatus: Draft", 300)).toBeNull();
    expect(draftStatusLine(`${"\n".repeat(45)}Status: Draft`, 300)).toBeNull();
    expect(draftStatusLine("Status: Drafted", 300)).toBeNull();
  });
});

describe("dates, paging and cites", () => {
  it("parses real UTC days and builds day and week windows", () => {
    expect(parseUtcDate("2026-02-29")).toBeNull();
    expect(parseUtcDate("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    const now = new Date("2026-10-01T10:00:00.000Z");
    expect(briefWindow(undefined, "week", now)).toEqual({
      date: "2026-10-01", from: new Date("2026-09-25T00:00:00.000Z"), to: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(() => briefWindow("2026-10-02", "day", now)).toThrow();
  });

  it("gives SQL the same calendar rule as parseUtcDate", () => {
    const pad = (value: number, width: number) => String(value).padStart(width, "0");
    const years = [0, 4, 100, 400, 2400, 9996, ...Array.from({ length: 221 }, (_, index) => 1890 + index)];
    const differ = years.flatMap((year) => Array.from({ length: 14 * 33 }, (_, index) =>
      `${pad(year, 4)}-${pad(Math.floor(index / 33), 2)}-${pad(index % 33, 2)}`))
      .filter((value) => CALENDAR_DATE.test(value) !== (parseUtcDate(value) !== null));
    expect(differ).toEqual([]);
  });

  it("pages and fingerprints queries", () => {
    const key = queryFingerprint(["x"]);
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    const first = pageOf([1, 2, 3], 2, undefined, key);
    expect(first.items).toEqual([1, 2]);
    expect(pageOf([1, 2, 3], 2, first.nextCursor!, key)).toEqual({ items: [3], nextCursor: null });
    expect(() => pageOf([1], 1, first.nextCursor!, queryFingerprint(["y"]))).toThrow();
  });
});

describe("summary flag and rebuild rule", () => {
  it("reads the flag per call and only then asks for a model", async () => {
    expect(briefSummaryEnabled({})).toBe(false);
    expect(briefSummaryEnabled({ MATRIX_BRAIN_BRIEF_SUMMARY: " ON " })).toBe(true);
    expect(briefSummaryEnabled({ MATRIX_BRAIN_BRIEF_SUMMARY: "yes" })).toBe(false);
    const model = { summarize: async () => ({ text: "", modelId: "m", usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } }) };
    const env: NodeJS.ProcessEnv = {};
    const provider = createBrainBriefSummaryProvider({ env, resolveModel: async () => model });
    expect(await provider()).toBeNull();
    env.MATRIX_BRAIN_BRIEF_SUMMARY = "1";
    expect(await provider()).toBe(model);
    expect(briefSummaryEnabled()).toBe(false);
  });

  it("refuses model output that is not a summary", async () => {
    const empty = { sections: { changes: [], decisions: [], commitments: [], risks: [], attention: [] } } as never;
    const model = { summarize: async () => ({ text: "x" }) as never };
    await expect(summarizeBrief(model, empty, () => new Date())).rejects.toMatchObject({ code: "brain_unavailable" });
  });

  it("sends only lines citing git documents and caps them by count and characters", () => {
    const line = (text: string, ...provenances: string[]) =>
      ({ text, cites: (provenances.length > 0 ? provenances : ["git_pr"]).map((provenance) => ({ provenance })) }) as never;
    const sections = { changes: [{ items: [line("a", "git_commit"), line("chat", "matrix_chat")] }],
      decisions: [line("b", "git_spec"), line("mixed", "git_pr", "slack_thread")], commitments: [line("eng", "linear_issue")],
      risks: [], attention: Array.from({ length: 300 }, () => line("x".repeat(390))) };
    const lines = summaryLines({ sections } as never);
    expect(lines.slice(0, 3)).toEqual(["a", "b", "x".repeat(390)]);
    expect(lines.join("").length).toBeLessThanOrEqual(40_000);
    expect(lines).toHaveLength(104);
  });

  it("rebuilds a stored brief built before its window ended once the window ended or an hour passed", () => {
    const brief = { generatedAt: "2026-10-01T10:00:00.000Z", to: "2026-10-02T00:00:00.000Z" } as never;
    expect(needsRebuild(brief, new Date("2026-10-01T10:30:00.000Z"))).toBe(false);
    expect(needsRebuild(brief, new Date("2026-10-01T11:00:00.000Z"))).toBe(true);
    expect(needsRebuild(brief, new Date("2026-10-02T00:00:00.000Z"))).toBe(true);
    expect(needsRebuild({ generatedAt: "2026-10-02T01:00:00.000Z", to: "2026-10-02T00:00:00.000Z" } as never,
      new Date("2026-10-03T00:00:00.000Z"))).toBe(false);
  });
});
