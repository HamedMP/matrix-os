import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAIN_MCP_TOOL_NAMES, registerBrainTools } from "../../packages/integrations-mcp/src/brain-tools.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import { BRAIN_SEARCH_DESCRIPTION } from "../../packages/kernel/src/tools/brain-search.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";

const ID = "proj_test";
const CITE = { documentId: "doc_12", kind: "pr", label: "#12", title: "Bound it", permalink: "https://x.test/pull/12", date: "2026-09-28T10:00:00Z" };
/** A cite kind the kernel views do not know reads as "document". */
const BARE = { ...CITE, documentId: "doc_plan", kind: "wiki", label: "Plan", title: "Plan", permalink: "" };
const FRESH = { caughtUp: true, pendingDocuments: 0, pendingCapped: false };
const BEHIND = { caughtUp: false, pendingDocuments: 1000, pendingCapped: true };
const LINE = { text: "Bound lists", cites: [CITE, BARE], due: "2026-10-03", assignee: "ana", severity: "high" };
const BRIEF_EMPTY = { attention: [], decisions: [], commitments: [], risks: [], changes: [] };
const IMPACT = {
  base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/x", sha: "b".repeat(40) }, changedTotal: 2,
  changedFiles: [
    { path: "src/a.ts", status: "modified", previousPath: null, isTest: false },
    { path: "tests/a.test.ts", status: "renamed", previousPath: "tests/old.test.ts", isTest: true },
  ],
  dependents: [{ path: "src/m.ts", depth: 1, via: "src/a.ts" }, { path: "src/n.ts", depth: 2, via: "src/m.ts" }],
  prior: [{ path: "src/a.ts", items: [CITE, BARE] }],
  invariants: [{ kind: "invariant", label: "Bounds", statement: "Stay bounded.", paths: ["src/a.ts"], quote: "q", cite: CITE }],
  decisions: [{ kind: "decision", label: null, statement: "Use Postgres.", paths: [], quote: "q", cite: BARE }],
  untested: [{ path: "src/a.ts" }],
  specs: [{ spec: "specs/1-x", changedPaths: ["a"], cite: CITE }, { spec: "specs/2-y", changedPaths: ["a", "b"], cite: null }],
  notices: ["brain_behind_head", "dependents_capped", "future_notice"], mergeBase: "c".repeat(40), approximate: true,
};

type Reply = Response | Promise<Response> | Error | string | { notAResponse: true };

async function connect(reply: (url: string) => Reply) {
  const fetcher = vi.fn<GatewayFetcher>(async (url) => {
    const value = reply(url);
    if (value instanceof Error || typeof value === "string") throw value;
    return value as Response;
  });
  const server = new McpServer({ name: "brain-fixture", version: "1" });
  registerBrainTools(server, fetcher);
  const client = new Client({ name: "brain-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as Array<{ text: string }>)[0]!.text, isError: result.isError === true };
  };
  return { client, fetcher, call, close: async () => { await client.close(); await server.close(); } };
}

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
/** A body larger than the cap whose cancel fails, to exercise cleanup logging. */
const oversized = (cancel: () => void) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(new Uint8Array(600 * 1024)); }, cancel,
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("integrations-mcp brain tools", () => {
  it("advertises six read-only tools", async () => {
    const f = await connect(json({}));
    try {
      const tools = (await f.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([...BRAIN_MCP_TOOL_NAMES]);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false)).toBe(true);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.get("brain_search")!.description).toBe(BRAIN_SEARCH_DESCRIPTION);
      const project = (name: string) => (byName.get(name)!.inputSchema.properties as Record<string, { pattern: string; description: string }>).project!;
      // Every tool takes a project id or slug, brain_claims included (its route accepts slugs).
      for (const tool of tools) expect(project(tool.name).pattern, tool.name).toBe(project("brain_search").pattern);
      expect(project("brain_search").pattern).toContain("[a-z0-9]");
      expect(byName.get("brain_claims")!.description).not.toContain("proj_");
    } finally { await f.close(); }
  });

  it("calls the local gateway with the bearer, bounded query and default limit, and wraps search hits", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "synthetic-token");
    vi.stubEnv("GATEWAY_URL", "http://gateway.test");
    const hits = [
      { snippet: { text: "kept bounded", truncatedStart: true, truncatedEnd: true }, claim: null, cite: CITE },
      { snippet: { text: "", truncatedStart: false, truncatedEnd: false }, claim: { kind: "risk", label: "Cost", statement: "May rise", stale: true }, cite: BARE },
      { snippet: { text: "x", truncatedStart: false, truncatedEnd: false }, claim: { kind: "decision", label: null, statement: "Use it", stale: false }, cite: CITE },
      { snippet: { text: "", truncatedStart: false, truncatedEnd: false }, claim: null, cite: BARE },
    ].map((hit) => ({ ...hit, type: hit.claim ? "claim" : "document" }));
    const f = await connect(json({ q: "bounded", mode: "text", items: hits, nextCursor: "n1", freshness: BEHIND, notices: [], capability: {} }));
    try {
      const result = await f.call("brain_search", { project: "matrix-os", query: "bounded", kinds: ["pr", "spec"], from: "2026-01-01" });
      const [url, init] = f.fetcher.mock.calls[0]!;
      expect(url).toBe("http://gateway.test/api/brain/projects/matrix-os/search?q=bounded&kinds=pr%2Cspec&from=2026-01-01&limit=8");
      expect(init).toEqual(expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }) }));
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/^<<<EXTERNAL_UNTRUSTED_CONTENT>>>\nCAUTION:[^\n]*\nSource: api\nFrom: Company Brain\n---\n/);
      expect(result.text).toContain([
        'Search "bounded": 4 results, best first. The index is catching up (1000+ documents pending).',
        "1. PR #12 - 2026-09-28 - Bound it", "   https://x.test/pull/12", "   Match: ...kept bounded...",
        "2. Risk in Document Plan - 2026-09-28 [stale]", "   Claim (Cost): May rise",
        "3. Decision in PR #12 - 2026-09-28 - Bound it", "   https://x.test/pull/12", "   Claim: Use it",
        "4. Document Plan - 2026-09-28", 'More: call brain_search with cursor "n1".',
      ].join("\n"));
    } finally { await f.close(); }
  });

  it("formats timeline, claims and conflicts answers like the kernel tools", async () => {
    const bodies: Record<string, unknown> = {
      timeline: { entity: { kind: "pull_request", key: "12", displayName: "" }, nextCursor: null, freshness: FRESH, items: [
        { cite: CITE, linkTypes: ["implements_spec"], mode: "inferred", matchedPaths: ["src/a.ts"] },
        { cite: CITE, linkTypes: [], mode: "explicit", matchedPaths: ["src/b.ts"] },
        { cite: BARE, linkTypes: [], mode: "explicit", matchedPaths: [] }] },
      claims: { kind: "decision", path: "src", match: "folder", nextCursor: "k", items: [
        { kind: "decision", label: "Store", statement: "Use Postgres.", stale: true, fields: { due: "2026-10-03" }, document: CITE },
        { kind: "risk", label: null, statement: "Cost.", stale: false, fields: {}, document: BARE }] },
      conflicts: { nextCursor: null, items: [{ rule: "label_disagreement", summary: "Differ", sides: [{ cite: CITE, quote: "A\nB" }, { cite: BARE, quote: "C" }] }] },
    };
    const f = await connect((url) => Response.json(bodies[new URL(url).pathname.split("/").at(-1)!]));
    try {
      expect((await f.call("brain_timeline", { project: "p", entity: "pull_request:12" })).text).toContain([
        "Timeline of pull request 12: 3 items, newest first.",
        "1. PR #12 - 2026-09-28 - Bound it [inferred]", "   https://x.test/pull/12", "   Linked: implements spec; paths: src/a.ts",
        "2. PR #12 - 2026-09-28 - Bound it", "   https://x.test/pull/12", "   Linked: related; paths: src/b.ts",
        "3. Document Plan - 2026-09-28", "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
      ].join("\n"));
      expect(f.fetcher.mock.calls[0]![0]).toContain("/timeline?entity=pull_request%3A12&limit=10");
      expect((await f.call("brain_claims", { project: ID, kind: "decision", path: "src/", cursor: "c" })).text).toContain([
        "Decisions for src/: 2 claims, newest document first.",
        "1. Decision in PR #12 - 2026-09-28 - Bound it [stale]", "   https://x.test/pull/12", "   Store: Use Postgres. (due 2026-10-03)",
        "2. Risk in Document Plan - 2026-09-28", "   Cost.", 'More: call brain_claims with cursor "k".',
      ].join("\n"));
      // A slug reaches the claims route like any other tool's.
      expect((await f.call("brain_claims", { project: "matrix-os" })).text).toContain("Decisions for src/");
      expect(f.fetcher.mock.calls.at(-1)![0]).toContain("/api/brain/projects/matrix-os/claims?");
      expect((await f.call("brain_conflicts", { project: "p" })).text).toContain([
        "Conflicts: 1 found, newest first.", "1. Statements disagree: Differ", "   a) PR #12 - 2026-09-28 - Bound it",
        "      https://x.test/pull/12", '      "A B"', "   b) Document Plan - 2026-09-28", '      "C"',
      ].join("\n"));
    } finally { await f.close(); }
  });

  it("formats brief and impact answers with sections, notes and caps", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...LINE, text: `item ${index}`, cites: index === 0 ? [] : index === 1 ? [BARE] : [CITE] }));
    const bodies: Record<string, unknown> = {
      brief: { date: "2026-10-01", window: "week", truncated: true, summary: { text: "Quiet." }, sections: {
        ...BRIEF_EMPTY, attention: [LINE], risks: [{ ...LINE, cites: [], due: null, assignee: null, severity: null }],
        changes: [{ label: "git", created: 1, revised: 2, items: many }] } },
      impact: IMPACT,
    };
    const f = await connect((url) => Response.json(bodies[new URL(url).pathname.split("/").at(-1)!]));
    try {
      const brief = (await f.call("brain_brief", { project: "p", date: "2026-10-01", window: "week" })).text;
      expect(f.fetcher.mock.calls[0]![0]).toMatch(/\/brief\?date=2026-10-01&window=week$/);
      expect(brief).toContain([
        "Brief for 2026-10-01 (week): 1 attention item, 0 decisions, 0 open commitments, 1 risk, 1 changed source. Some sections were cut at their caps.",
        "Summary: Quiet.", "Needs attention:", "1. Bound lists (due 2026-10-03, assignee ana, severity high) - PR #12 (2026-09-28)",
        "   https://x.test/pull/12", "   Also: Document Plan (2026-09-28)", "Risks:", "2. Bound lists", "Changes:", "3. git: 1 new, 2 revised",
        "   - item 0", "   - item 1 - Document Plan (2026-09-28)", "   - item 2 - PR #12 (2026-09-28) https://x.test/pull/12",
      ].join("\n"));
      expect(brief).toContain("   (+2 more)");
      const impact = (await f.call("brain_impact", { project: "p", head: "feature/x", base: "main", depth: 2 })).text;
      expect(f.fetcher.mock.calls[1]![0]).toMatch(/\/impact\?head=feature%2Fx&base=main&depth=2$/);
      expect(impact).toContain([
        "Impact of feature/x (bbbbbbbbbbbb) against main (aaaaaaaaaaaa): 2 changed files, 2 importers (approximate), 1 invariant, 1 decision, 2 specs, 1 without a changed test.",
        "Notes: the brain has not synced the newest commits yet; the importer list was capped.", "Invariants to keep:", "1. Bounds: Stay bounded. - PR #12 (2026-09-28)", "   https://x.test/pull/12", "   Paths: src/a.ts",
        "Decisions that apply:", "2. Use Postgres. - Document Plan (2026-09-28)", "Specs touched:",
        "- specs/1-x (1 changed file): PR #12 - 2026-09-28 - Bound it", "   https://x.test/pull/12", "- specs/2-y (2 changed files)",
        "Changed sources without a changed test:", "- src/a.ts", "Earlier pull requests:",
        "- src/a.ts: PR #12 (2026-09-28) https://x.test/pull/12; Document Plan (2026-09-28)", "Changed files:", "- M src/a.ts",
        "- R tests/a.test.ts (from tests/old.test.ts) [test]", "Importers (approximate):", "- src/m.ts imports src/a.ts",
        "- src/n.ts imports src/m.ts (second hop)",
      ].join("\n"));
    } finally { await f.close(); }
  });

  it("keeps the notices of impact lists cut at their caps", async () => {
    const f = await connect(json({ ...IMPACT, notices: ["prior_capped", "claims_capped", "untested_capped", "specs_capped"] }));
    try {
      expect((await f.call("brain_impact", { project: "p", head: "main" })).text).toContain(
        "Notes: earlier pull requests are listed for only some changed files; more invariants or decisions apply, or " +
          "name more changed files, than are listed; more changed sources lack a changed test than are listed; more " +
          "specs, or more changed files in a spec, were touched than are listed.",
      );
    } finally { await f.close(); }
  });

  it("accepts a commitment assignee as long as a stored ref, which the brief copies unchanged", async () => {
    const assignee = `name:${"a".repeat(507)}`;
    const f = await connect(json({ date: "2026-10-01", window: "day", truncated: false, summary: null,
      sections: { ...BRIEF_EMPTY, commitments: [{ ...LINE, assignee, severity: null }] } }));
    try {
      const brief = await f.call("brain_brief", { project: "p" });
      expect(brief.isError).toBe(false);
      expect(brief.text).toContain("Bound lists (due 2026-10-03, assignee name:aaaa");
    } finally { await f.close(); }
  });

  it("covers the plain variants: file paths, uncut briefs, impact without notes and long emoji titles", async () => {
    const bodies: Record<string, unknown> = {
      claims: { kind: null, path: "src/a.ts", match: "file_or_folder", nextCursor: null, items: [
        { kind: "invariant", label: null, statement: "S", stale: false, fields: {}, document: { ...CITE, title: "\u{1F600}".repeat(300) } }] },
      brief: { date: "2026-10-01", window: "day", truncated: false, summary: null, sections: {
        ...BRIEF_EMPTY, decisions: [LINE], changes: [{ label: "a", created: 1, revised: 0, items: [LINE] }] } },
      impact: { ...IMPACT, notices: [], changedFiles: Array.from({ length: 500 }, (_, i) => ({ path: `src/${i}-${"x".repeat(60)}.ts`, status: "added", previousPath: null, isTest: false })) },
      search: { q: "x", mode: "text", items: [], nextCursor: null, freshness: { ...BEHIND, pendingCapped: false, pendingDocuments: 3 }, notices: [] },
    };
    const f = await connect((url) => Response.json(bodies[new URL(url).pathname.split("/").at(-1)!]));
    try {
      const claims = (await f.call("brain_claims", { project: ID })).text;
      expect(claims).toContain("Claims for src/a.ts: 1 claim, newest document first.\n1. Invariant in PR #12 - 2026-09-28 - ");
      expect(claims.split("\n").find((line) => line.startsWith("1. "))!.isWellFormed()).toBe(true);
      const brief = (await f.call("brain_brief", { project: "p" })).text;
      expect(brief).toContain("1 changed source.\nDecisions:\n1. Bound lists");
      expect(brief).toContain("2. a: 1 new, 0 revised\n   - Bound lists - PR #12 (2026-09-28) https://x.test/pull/12\n<<<END");
      const impact = (await f.call("brain_impact", { project: "p", head: "main" })).text;
      expect(impact).toContain("1 without a changed test.\nInvariants to keep:");
      expect(impact).toMatch(/\n\d+ more lines were left out for length\.\n<<<END/);
      expect((await f.call("brain_search", { project: "p", query: "x" })).text).toBe('No Company Brain results for "x". The index is catching up (3 documents pending).');
    } finally { await f.close(); }
  });

  it("answers empty results plainly and keeps long answers under the cap", async () => {
    const long = { type: "document", snippet: { text: "x".repeat(2_000), truncatedStart: false, truncatedEnd: false }, claim: null, cite: { ...CITE, title: "t".repeat(400) } };
    const hits = (q: string, count: number) => ({ q, mode: "text", items: Array.from({ length: count }, () => long), nextCursor: "n", freshness: FRESH, notices: [] });
    const bodies: Record<string, unknown> = {
      search: { q: "none", mode: "text", items: [], nextCursor: null, freshness: FRESH, notices: [] },
      timeline: { entity: { kind: "file", key: "a.ts", displayName: "a.ts" }, items: [], nextCursor: null, freshness: BEHIND },
      claims: { kind: null, path: null, match: null, items: [], nextCursor: null },
      brief: { date: "2026-10-01", window: "day", truncated: false, summary: null, sections: BRIEF_EMPTY },
      conflicts: { items: [], nextCursor: null },
      impact: { ...IMPACT, changedTotal: 0, changedFiles: [], notices: [] },
    };
    const f = await connect((url) => {
      const q = new URL(url).searchParams.get("q");
      return Response.json(q === "many" ? hits(q, 20) : q === "eleven" ? hits(q, 11) : bodies[new URL(url).pathname.split("/").at(-1)!]);
    });
    try {
      expect((await f.call("brain_search", { project: "p", query: "none" })).text).toBe('No Company Brain results for "none".');
      expect((await f.call("brain_timeline", { project: "p", entity: "file:a.ts" })).text)
        .toContain("Nothing in the Company Brain touches file a.ts yet. The index is catching up (1000+ documents pending).");
      expect((await f.call("brain_claims", { project: ID })).text)
        .toBe("Claims: none found. Claims come from the last extraction; newer documents appear after the next extraction run.");
      expect((await f.call("brain_brief", { project: "p" })).text).toBe("Nothing to report for 2026-10-01 (day).");
      expect((await f.call("brain_conflicts", { project: "p" })).text).toBe("No conflicts found in this project's current claims and specs.");
      expect((await f.call("brain_impact", { project: "p", head: "main" })).text).toContain("No changes between main (aaaaaaaaaaaa) and feature/x (bbbbbbbbbbbb).");
      const text = (await f.call("brain_search", { project: "p", query: "many", limit: 20 })).text;
      expect(text.length).toBeLessThan(8_400);
      expect(text).toMatch(/\n10 more results were left out for length; call again with limit 10 for a cursor that continues after the results shown here\.\n<<<END/);
      expect((await f.call("brain_search", { project: "p", query: "eleven", limit: 11 })).text)
        .toMatch(/\n10\. PR #12[^\n]*\n[^\n]*\n[^\n]*\n1 more result was left out for length; call again with limit 10 for a cursor that continues after the results shown here\.\n<<<END/);
    } finally { await f.close(); }
  });

  it("states the search notices and mode, and answers a query without searchable words with guidance", async () => {
    const hit = { type: "document", snippet: { text: "a", truncatedStart: false, truncatedEnd: false }, claim: null, cite: CITE };
    const bodies: Record<string, unknown> = {
      wide: { q: "wide", mode: "hybrid", items: [hit], nextCursor: null, freshness: FRESH, notices: ["terms_dropped", "candidates_capped", "any_term_fallback", "future_notice"] },
      "*": { q: "*", mode: "text", items: [], nextCursor: null, freshness: FRESH, notices: ["query_empty_after_parse"] },
    };
    const f = await connect((url) => Response.json(bodies[new URL(url).searchParams.get("q")!]));
    try {
      expect((await f.call("brain_search", { project: "p", query: "wide" })).text).toContain(
        'Search "wide": 1 result, best first (words and meaning). Only the first 16 terms were used. Only the top 200 matches were ranked. Few results held every word, so results with any of them follow.\n1. PR #12');
      expect((await f.call("brain_search", { project: "p", query: "*" })).text)
        .toBe("That query has no searchable words. Use letters or digits, quote a phrase, or end a word with * for a prefix.");
    } finally { await f.close(); }
  });

  it("maps gateway errors to the kernel texts, refuses forged input and logs only error names", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const replies: Record<string, Reply> = {
      a: new Response("{}", { status: 404 }),
      b: new Response("{}", { status: 400 }),
      c: Response.json({ error: { code: "vector_search_unavailable", message: "x" } }, { status: 409 }),
      d: Response.json({ error: { code: "checkout_unavailable", message: "x" } }, { status: 409 }),
      e: new Response("/home/secret failure", { status: 500 }),
      f: new Response("x".repeat(600 * 1024)),
      g: new Response("not json"),
      h: Response.json({ q: 1 }),
      i: { notAResponse: true },
      j: new TypeError("fetch failed /home/secret"),
      k: new Response(null, { status: 200 }),
      l: "thrown text",
      m: new Response(oversized(() => { throw new Error("cancel failed"); })),
      n: new Response(oversized(() => { throw "cancel failed"; })),
    };
    const f = await connect((url) => replies[new URL(url).searchParams.get("q")!]!);
    try {
      const run = (q: string) => f.call("brain_search", { project: "p", query: q });
      expect(await run("a")).toEqual({ text: "That project was not found.", isError: false });
      expect((await run("b")).text).toMatch(/^That search is not valid\. Check the dates/);
      expect(await run("c")).toEqual({ text: "Meaning search is not available for this project; plain word search still works.", isError: false });
      for (const q of ["d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"]) {
        expect(await run(q)).toEqual({ text: "Company Brain is temporarily unavailable.", isError: true });
      }
      expect(error.mock.calls.map((call) => `${call[0]} ${call[1]}`)).toEqual([
        "BrainGatewayStatus", "BrainGatewayStatus", "Error", "SyntaxError", "ZodError", "Error", "TypeError", "Error",
        "string", "Error", "Error",
      ].map((name) => `[brain-read] brain_search failed: ${name}`));
      expect(warn.mock.calls).toEqual([["[brain-tools] Cleanup failed:", "Error"], ["[brain-tools] Cleanup failed:", "UnknownError"]]);
      expect(JSON.stringify([...error.mock.calls, ...warn.mock.calls])).not.toContain("/home/secret");
      f.fetcher.mockClear();
      for (const args of [{ project: "p", query: "q", ownerId: "other" }, { project: "../p", query: "q" }, { project: "p", query: "q", limit: 21 }]) {
        expect((await f.call("brain_search", args)).isError).toBe(true);
      }
      expect((await f.call("brain_impact", { project: "p", head: "HEAD" })).isError).toBe(true);
      expect((await f.call("brain_claims", { project: "Not A Ref" })).isError).toBe(true);
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("ends a body that stalls after its first bytes at the 30 second deadline, and releases it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let waiting!: () => void;
    const stalled = new Promise<void>((resolve) => { waiting = resolve; });
    let pulls = 0;
    const cancel = vi.fn();
    // The second pull comes from a read with nothing queued; the body never answers it and never looks at the signal.
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"q":')); },
      pull() { if (++pulls === 2) waiting(); }, cancel,
    });
    const f = await connect(() => new Response(body));
    try {
      const answer = f.call("brain_search", { project: "p", query: "slow" });
      await stalled;
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      expect(await answer).toEqual({ text: "Company Brain is temporarily unavailable.", isError: true });
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(cancel).toHaveBeenCalledOnce();
      expect(error.mock.calls).toEqual([["[brain-read] brain_search failed:", "TimeoutError"]]);
    } finally { await f.close(); }
  });

  it("ends a call whose transport never answers at the deadline, and cancels the body of a late answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let respond!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => { respond = resolve; });
    const f = await connect(() => late);
    try {
      const answer = f.call("brain_search", { project: "p", query: "slow" });
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      expect(await answer).toEqual({ text: "Company Brain is temporarily unavailable.", isError: true });
      expect(error.mock.calls).toEqual([["[brain-read] brain_search failed:", "TimeoutError"]]);
      const cancel = vi.fn();
      respond(new Response(new ReadableStream<Uint8Array>({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally { await f.close(); }
  });

  it("leaves the brain tools off the full surface when the process holds a run-scoped bearer", async () => {
    const names = async () => {
      const server = createIntegrationsMcpServer({ fetcher: vi.fn<GatewayFetcher>() });
      const client = new Client({ name: "brain-client", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      try { return (await client.listTools()).tools.map((tool) => tool.name); } finally { await client.close(); await server.close(); }
    };
    expect(await names()).toEqual(expect.arrayContaining([...BRAIN_MCP_TOOL_NAMES]));
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    const scoped = await names();
    expect(scoped).toContain("list_integration_inventory");
    expect(scoped.filter((name) => name.startsWith("brain_"))).toEqual([]);
  });

  it("parses its input again inside the handler, so a forged argument never reaches the gateway", async () => {
    const callbacks = new Map<string, (input: unknown) => Promise<{ content: Array<{ text: string }> }>>();
    const fetcher = vi.fn<GatewayFetcher>();
    const server = { registerTool: (name: string, _config: unknown, callback: (input: unknown) => Promise<{ content: Array<{ text: string }> }>) => callbacks.set(name, callback) };
    registerBrainTools(server as unknown as McpServer, fetcher);
    for (const input of [{ project: ID, ownerId: "other" }, { project: "Not A Ref" }]) {
      expect((await callbacks.get("brain_claims")!(input)).content[0]!.text).toBe("Those arguments are not valid for this Company Brain tool.");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
