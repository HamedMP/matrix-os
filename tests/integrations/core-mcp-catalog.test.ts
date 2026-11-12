import { describe, expect, it } from "vitest";
import {
  CORE_MAX_DESCRIPTION_BYTES,
  CoreCatalogCache,
  assignCoreServiceSlugs,
  normalizeCoreCatalog,
} from "../../packages/gateway/src/integrations/custom-mcp/core-catalog.js";
import type { CustomMcpServer, CustomMcpTool } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

function server(id: string, tools: CustomMcpTool[], revision = 1): CustomMcpServer {
  return { id, name: "Fixture", url: "https://mcp.example.test/mcp", authMode: "none", status: "ready", enabled: true, revision, tools };
}
const tool = (name: string, description = "d"): CustomMcpTool => ({ name, description, inputSchema: { type: "object" }, approval: "allow", enabled: true });

describe("Matrix Core MCP catalog bounds", () => {
  it("caps upstream descriptions at 2 KB without splitting a code point", () => {
    const result = normalizeCoreCatalog(server("s1", [tool("search", "é".repeat(5_000))]), "fixture");
    if (!result.ok) throw new Error("expected catalog");
    const description = result.catalog.tools[0]!.description;
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(CORE_MAX_DESCRIPTION_BYTES);
    expect(description).toMatch(/^é+$/);
  });

  it("degrades a server above 500 tools or 512 KB instead of serving a partial catalog", () => {
    expect(normalizeCoreCatalog(server("s1", Array.from({ length: 501 }, (_, index) => tool(`t${index}`))), "fixture"))
      .toEqual({ ok: false, reason: "catalog_too_large" });
    const heavy = Array.from({ length: 300 }, (_, index) => ({ ...tool(`t${index}`), inputSchema: { blob: "x".repeat(2_000) } }));
    expect(normalizeCoreCatalog(server("s1", heavy), "fixture")).toEqual({ ok: false, reason: "catalog_too_large" });
    expect(normalizeCoreCatalog(server("s1", Array.from({ length: 500 }, (_, index) => tool(`t${index}`))), "fixture").ok).toBe(true);
  });

  it("binds service ids to the connection id, independent of sibling order, and lengthens only on a prefix clash", () => {
    const a = { id: "aaaaaaaa-1111-4111-8111-111111111111", name: "My Linear!" };
    const b = { id: "bbbbbbbb-2222-4222-8222-222222222222", name: "my linear" };
    const c = { id: "aaaaaaaa-3333-4333-8333-333333333333", name: "???" };
    expect([...assignCoreServiceSlugs([a, b]).values()]).toEqual(["my-linear-aaaaaaaa", "my-linear-bbbbbbbb"]);
    expect(assignCoreServiceSlugs([b]).get(b.id)).toBe("my-linear-bbbbbbbb");
    expect([...assignCoreServiceSlugs([a, c]).values()]).toEqual(["my-linear-aaaaaaaa1111", "mcp-aaaaaaaa3333"]);
  });

  it("omits tools whose names could restructure prompts or envelopes", () => {
    const result = normalizeCoreCatalog(server("s1", [tool('a"b'), tool("a<b"), tool("tab\tname"), tool("ok.name-1")]), "fixture");
    if (!result.ok) throw new Error("expected catalog");
    expect(result.catalog.tools.map(entry => entry.name)).toEqual(["ok.name-1"]);
  });

  it("evicts the least recently used connection at the cap and expires entries after the TTL", () => {
    let clock = 0;
    const cache = new CoreCatalogCache({ max: 2, ttlMs: 1_000, now: () => clock });
    const a = server("a", [tool("one")]);
    const first = cache.get(a, "a");
    cache.get(server("b", [tool("two")]), "b");
    expect(cache.get(a, "a")).toBe(first);
    cache.get(server("c", [tool("three")]), "c");
    expect(cache.size).toBe(2);
    expect(cache.get(a, "a")).toBe(first);
    clock = 1_001;
    expect(cache.get(a, "a")).not.toBe(first);
    expect(cache.get(server("a", [tool("one")], 2), "a")).not.toBe(cache.get(a, "a"));
  });
});
