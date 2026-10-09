import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import {
  citeText, clean, composeAnswer, cutTo, freshnessClause, kindWord, linesLeftOut, oneLine, pagedLeftOut, permalinkLines,
} from "../../packages/kernel/src/tools/brain-read-format.js";
import {
  BRAIN_READ_IPC_TOOL_NAMES, brainReadIpcToolNames, brainReadToolDefinitions, type BrainAgentReadTools,
} from "../../packages/kernel/src/tools/brain-read-tools.js";

const CITE = {
  documentId: "d".repeat(64), kind: "pr", label: "#12", title: "Bound the manager", permalink: "https://x.test/pull/12",
  date: "2026-09-28T10:00:00.000Z",
} as const;
const EMPTY_FRESH = { caughtUp: true, pendingDocuments: 0, pendingCapped: false };

function allTools(): Required<BrainAgentReadTools> {
  return {
    search: vi.fn(async () => ({ status: "ok" as const, q: "x", mode: "text" as const, items: [], nextCursor: null, freshness: EMPTY_FRESH, notices: [] })),
    timeline: vi.fn(async () => ({ status: "not_found" as const })),
    claims: vi.fn(async () => ({ status: "invalid" as const })),
    brief: vi.fn(async () => ({ status: "not_configured" as const })),
    conflicts: vi.fn(async () => ({ status: "unavailable" as const })),
    impact: vi.fn(async () => { throw new TypeError("secret /home/path"); }),
  };
}

function handlerOf(tools: BrainAgentReadTools, name: string) {
  const definition = brainReadToolDefinitions(tools).find((entry) => entry.name === name);
  if (!definition) throw new Error(`missing ${name}`);
  return definition.handler;
}

afterEach(() => vi.restoreAllMocks());

describe("brain read tool definitions", () => {
  it("defines only the tools whose method exists, in a fixed order, with matching allowed names", () => {
    const tools = allTools();
    expect(brainReadToolDefinitions(tools).map((entry) => entry.name)).toEqual([
      "brain_search", "brain_timeline", "brain_claims", "brain_brief", "brain_conflicts", "brain_impact",
    ]);
    expect(brainReadIpcToolNames(tools)).toEqual([...BRAIN_READ_IPC_TOOL_NAMES]);
    expect(brainReadIpcToolNames({ claims: tools.claims, impact: tools.impact })).toEqual([
      "mcp__matrix-os-ipc__brain_claims", "mcp__matrix-os-ipc__brain_impact",
    ]);
    expect(brainReadIpcToolNames(undefined)).toEqual([]);
    expect(brainReadToolDefinitions({})).toEqual([]);
    for (const definition of brainReadToolDefinitions(tools)) {
      expect(definition.description.length).toBeGreaterThan(80);
      expect(/^[\x20-\x7e]+$/.test(definition.description)).toBe(true);
      expect(Object.keys(definition.inputShape)[0]).toBe("project");
    }
  });

  it("refuses arguments outside the shape before calling the gateway", async () => {
    const tools = allTools();
    for (const args of [{ project: "p", query: "x", ownerId: "other" }, { project: "../x", query: "x" }, null, "x"]) {
      const result = await handlerOf(tools, "brain_search")(args);
      expect(result.content[0]?.text).toBe("Those arguments are not valid for this Company Brain tool.");
    }
    expect(tools.search).not.toHaveBeenCalled();
  });

  it("passes the default limit, keeps an explicit one and never adds one where the tool has none", async () => {
    const tools = allTools();
    await handlerOf(tools, "brain_search")({ project: "p", query: "  alpha  " });
    expect(tools.search).toHaveBeenLastCalledWith({ project: "p", query: "alpha", limit: 8 });
    await handlerOf(tools, "brain_search")({ project: "p", query: "a", limit: 3 });
    expect(tools.search).toHaveBeenLastCalledWith({ project: "p", query: "a", limit: 3 });
    await handlerOf(tools, "brain_timeline")({ project: "p", entity: "file:a.ts" });
    expect(tools.timeline).toHaveBeenLastCalledWith({ project: "p", entity: "file:a.ts", limit: 10 });
    await handlerOf(tools, "brain_claims")({ project: "p" });
    expect(tools.claims).toHaveBeenLastCalledWith({ project: "p", limit: 10 });
    await handlerOf(tools, "brain_conflicts")({ project: "p" });
    expect(tools.conflicts).toHaveBeenLastCalledWith({ project: "p", limit: 10 });
    await handlerOf(tools, "brain_brief")({ project: "p" });
    expect(tools.brief).toHaveBeenLastCalledWith({ project: "p" });
  });

  it("answers fixed texts for every status and one unavailable error for failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tools = allTools();
    const text = async (name: string, args: object) => (await handlerOf(tools, name)({ project: "p", ...args }));
    expect(await text("brain_timeline", { entity: "file:a" })).toEqual({
      content: [{ type: "text", text: expect.stringMatching(/^That project or entity was not found\./) }],
    });
    expect((await text("brain_claims", {})).content[0]?.text).toMatch(/^That path or cursor is not valid\./);
    expect((await text("brain_brief", {})).content[0]?.text).toBe("That Company Brain feature is turned off for this project.");
    const unavailable = { content: [{ type: "text", text: "Company Brain is temporarily unavailable." }], isError: true };
    expect(await text("brain_conflicts", {})).toEqual(unavailable);
    expect(await text("brain_impact", { head: "main" })).toEqual(unavailable);
    expect(error).toHaveBeenLastCalledWith("[brain-read] brain_impact failed:", "TypeError");
    tools.impact = vi.fn(() => Promise.reject("boom"));
    expect(await text("brain_impact", { head: "main" })).toEqual(unavailable);
    expect(error).toHaveBeenLastCalledWith("[brain-read] brain_impact failed:", "string");
    expect(JSON.stringify(error.mock.calls)).not.toContain("/home/path");
    tools.search = vi.fn(async () => ({ status: "not_configured" as const }));
    expect((await text("brain_search", { query: "x" })).content[0]?.text).toMatch(/^Meaning search is not available/);
  });

  it("validates project, path, date, cursor, entity and revision bounds", () => {
    const shape = (name: string) => z.object(brainReadToolDefinitions(allTools()).find((entry) => entry.name === name)!.inputShape).strict();
    const ok = (name: string, value: object) => shape(name).safeParse(value).success;
    expect(ok("brain_search", { project: "proj_A-1", query: "x", from: "2026-01-01", to: "2026-01-02T10:00:00.5+01:00" })).toBe(true);
    expect(ok("brain_search", { project: "Bad Slug", query: "x" })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "   " })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "a\0b" })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "x", from: "2026-01-01T10:00" })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "x", path: "a\0" })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "x", kinds: ["wiki"] })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "x", limit: 21 })).toBe(false);
    expect(ok("brain_search", { project: "p", query: "x", cursor: "a\nb" })).toBe(false);
    expect(ok("brain_claims", { project: "p", cursor: "c".repeat(640) })).toBe(true);
    expect(ok("brain_conflicts", { project: "p", cursor: "c".repeat(513) })).toBe(false);
    expect(ok("brain_timeline", { project: "p", entity: "file:a\tb" })).toBe(false);
    expect(ok("brain_timeline", { project: "p", entity: "x".repeat(601) })).toBe(false);
    expect(ok("brain_brief", { project: "p", date: "2026-1-1" })).toBe(false);
    expect(ok("brain_brief", { project: "p", date: "2026-10-01", window: "month" })).toBe(false);
    for (const head of ["main", "release/1.2", "abc1234", "a".repeat(40)]) expect(ok("brain_impact", { project: "p", head })).toBe(true);
    for (const head of ["HEAD", "refs/heads/main", "a..b", "-x", "a/", "x.lock", "a@{1}", ""]) {
      expect(ok("brain_impact", { project: "p", head })).toBe(false);
    }
    expect(ok("brain_impact", { project: "p", head: "main", depth: 3 })).toBe(false);
  });
});

describe("brain read text rules", () => {
  it("removes format characters, folds line breaks and joins one-line fields", () => {
    expect(clean("a\u200bb\r\nc\rd\u2028e\u0085f")).toBe("ab\nc\nd\ne\nf");
    expect(oneLine("a\n\nb\u2029c")).toBe("a b c");
    expect(oneLine("x".repeat(10), 8)).toBe("xxxxx...");
  });

  it("cuts without splitting a surrogate pair", () => {
    expect(cutTo("short", 10)).toBe("short");
    const cut = cutTo(`ab${"\u{1F600}".repeat(10)}`, 9);
    expect([cut.length <= 9, cut.isWellFormed(), cut.endsWith("...")]).toEqual([true, true, true]);
    expect(cutTo(`abc${"\u{1F600}".repeat(10)}`, 9).isWellFormed()).toBe(true);
  });

  it("writes cites in ASCII, once when the label is the title, and falls back to Document", () => {
    expect(citeText(CITE)).toBe("PR #12 - 2026-09-28 - Bound the manager");
    expect(citeText({ ...CITE, kind: "note", label: "Plan", title: "Plan" })).toBe("Note Plan - 2026-09-28");
    expect(kindWord("wiki")).toBe("Document");
    expect(permalinkLines({ permalink: "" })).toEqual([]);
    expect(permalinkLines(CITE, "  ")).toEqual(["  https://x.test/pull/12"]);
    expect(freshnessClause(EMPTY_FRESH)).toBe("");
    expect(freshnessClause({ caughtUp: false, pendingDocuments: 1000, pendingCapped: true }))
      .toBe(" The index is catching up (1000+ documents pending).");
  });

  it("keeps answers under the cap, cuts an oversized first block and reports what was left out", () => {
    const parts = {
      maxChars: 2_000, header: (shown: number) => `H ${shown}`, preface: ["P"], more: "More: m",
      leftOut: (left: number, shown: number) => `left ${left} shown ${shown}`,
    };
    expect(composeAnswer({ ...parts, blocks: ["a", "b"] })).toBe("H 2\nP\na\nb\nMore: m");
    const many = composeAnswer({ ...parts, maxChars: 1_900, blocks: ["x".repeat(600), "y".repeat(600), "z"] });
    expect(many.split("\n")).toEqual(["H 1", "P", "x".repeat(600), "left 2 shown 1"]);
    const huge = composeAnswer({ ...parts, preface: undefined, more: null, blocks: ["q".repeat(5_000)] });
    expect(huge.length).toBeLessThanOrEqual(2_000);
    expect(huge.split("\n")[1]?.endsWith("...")).toBe(true);
    expect(composeAnswer({ ...parts, more: null, blocks: [] })).toBe("H 0\nP");
    expect(pagedLeftOut("item", "items")(1, 2)).toBe(
      "1 more item was left out for length; call again with limit 2 for a cursor that continues after the items shown here.",
    );
    expect([linesLeftOut(1), linesLeftOut(2)]).toEqual([
      "1 more line was left out for length.", "2 more lines were left out for length.",
    ]);
  });
});
