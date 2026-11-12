/**
 * Matrix Core MCP progressive-discovery catalog (spec 2691).
 *
 * The callable set is the broker's persisted enforcement projection: a tool
 * the owner has not enabled can never be dispatched, so the Core catalog is
 * derived from the same rows instead of a second live discovery. Every value
 * that originated upstream (names, descriptions, schemas) stays data.
 */
import type { CustomMcpApproval, CustomMcpServer } from "./types.js";

export const CORE_MAX_TOOLS_PER_SERVER = 500;
export const CORE_MAX_CATALOG_BYTES = 512 * 1024;
export const CORE_MAX_DESCRIPTION_BYTES = 2 * 1024;
export const CORE_CATALOG_CACHE_MAX = 500;
export const CORE_CATALOG_TTL_MS = 10 * 60_000;
export const CORE_SEARCH_DEFAULT_LIMIT = 10;
export const CORE_SEARCH_MAX_LIMIT = 25;
const MAX_QUERY_TOKENS = 16;
const SUMMARY_CHARS = 200;
const HIT_DESCRIPTION_CHARS = 200;
const SERVICE_SLUG_CHARS = 48;
const CONNECTION_SUFFIX_HEX = 8;
/** Tool names travel into prompts and envelopes; refuse anything that could restructure them. */
const SAFE_TOOL_NAME = /^[^\u0000-\u001f\u007f-\u009f<>"'`&\\]{1,128}$/u;

export type CoreToolPolicy = CustomMcpApproval | "blocked";

export interface CoreTool {
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: unknown;
  policy: CoreToolPolicy;
}

export interface CoreCatalog {
  serverId: string;
  revision: number;
  service: string;
  tools: CoreTool[];
}

export type CoreCatalogResult =
  | { ok: true; catalog: CoreCatalog }
  | { ok: false; reason: "catalog_too_large" | "invalid_catalog" };

export interface CoreSearchHit {
  /** The owner's own connection id, for server-id clients (managed Pi `mcp_describe`/`mcp_call`). */
  serverId: string;
  service: string;
  tool: string;
  qualifiedName: string;
  description: string;
  policy: CustomMcpApproval;
}

/** Truncate to a UTF-8 byte budget without leaving a split code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
}

function slugFor(name: string): string {
  const slug = name.normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SERVICE_SLUG_CHARS).replace(/-+$/g, "");
  return slug || "mcp";
}

/**
 * Service ids are bound to the immutable connection id (`<slug>-<8 hex>`), so a
 * deleted or renamed sibling can never re-point an id at another account; a
 * stale id simply stops resolving. The suffix only lengthens on a prefix clash.
 */
export function assignCoreServiceSlugs(servers: readonly Pick<CustomMcpServer, "id" | "name">[]): Map<string, string> {
  const hexes = servers.map(server => server.id.toLowerCase().replace(/[^0-9a-f]/g, ""));
  const slugs = new Map<string, string>();
  servers.forEach((server, index) => {
    const hex = hexes[index]!;
    let length = CONNECTION_SUFFIX_HEX;
    while (length < hex.length && hexes.some((other, j) => j !== index && other.startsWith(hex.slice(0, length)))) length += 4;
    slugs.set(server.id, `${slugFor(server.name)}-${hex.slice(0, length) || "0"}`);
  });
  return slugs;
}

export function isSafeCoreToolName(name: string): boolean {
  return SAFE_TOOL_NAME.test(name);
}

/** Bound and normalize one server's tools; an oversized catalog is degraded, never partial. */
export function normalizeCoreCatalog(server: CustomMcpServer, service: string): CoreCatalogResult {
  if (!Array.isArray(server.tools)) return { ok: false, reason: "invalid_catalog" };
  if (server.tools.length > CORE_MAX_TOOLS_PER_SERVER) return { ok: false, reason: "catalog_too_large" };
  let bytes = 0;
  const tools: CoreTool[] = [];
  for (const tool of server.tools) {
    if (!tool || typeof tool.name !== "string" || tool.name.length < 1 || tool.name.length > 128) {
      return { ok: false, reason: "invalid_catalog" };
    }
    if (!isSafeCoreToolName(tool.name)) {
      // Not exposed (so not callable) through Core; the rest of the server stays usable.
      console.warn("[core-mcp] tool with unsafe name omitted from catalog", { serverId: server.id });
      continue;
    }
    const description = truncateUtf8(typeof tool.description === "string" ? tool.description : "", CORE_MAX_DESCRIPTION_BYTES);
    let schemaText: string;
    try { schemaText = JSON.stringify(tool.inputSchema ?? { type: "object" }) ?? "{}"; }
    catch (error: unknown) {
      console.warn("[core-mcp] tool schema is not serializable", error instanceof Error ? error.name : "UnknownError");
      return { ok: false, reason: "invalid_catalog" };
    }
    bytes += Buffer.byteLength(tool.name, "utf8") + Buffer.byteLength(description, "utf8") + Buffer.byteLength(schemaText, "utf8");
    if (bytes > CORE_MAX_CATALOG_BYTES) return { ok: false, reason: "catalog_too_large" };
    tools.push({
      name: tool.name,
      qualifiedName: `${service}.${tool.name}`,
      description,
      inputSchema: tool.inputSchema ?? { type: "object" },
      policy: tool.enabled ? tool.approval : "blocked",
    });
  }
  return { ok: true, catalog: { serverId: server.id, revision: server.revision, service, tools } };
}

interface CacheEntry { revision: number; service: string; expiresAt: number; result: CoreCatalogResult }

/** Per-connection LRU; a new revision or service id is a miss, so policy edits apply on the next read. */
export class CoreCatalogCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { max?: number; ttlMs?: number; now?: () => number } = {}) {
    this.max = options.max ?? CORE_CATALOG_CACHE_MAX;
    this.ttlMs = options.ttlMs ?? CORE_CATALOG_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number { return this.entries.size; }

  get(server: CustomMcpServer, service: string): CoreCatalogResult {
    const current = this.now();
    const cached = this.entries.get(server.id);
    if (cached && cached.revision === server.revision && cached.service === service && cached.expiresAt > current) {
      this.entries.delete(server.id);
      this.entries.set(server.id, cached);
      return cached.result;
    }
    const result = normalizeCoreCatalog(server, service);
    this.entries.delete(server.id);
    this.entries.set(server.id, { revision: server.revision, service, expiresAt: current + this.ttlMs, result });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return result;
  }

  invalidate(serverId: string): void { this.entries.delete(serverId); }

  clear(): void { this.entries.clear(); }
}

export function coreCapabilitySummary(catalog: CoreCatalog): string {
  const callable = catalog.tools.filter(tool => tool.policy !== "blocked").map(tool => tool.name);
  if (callable.length === 0) return "No tools are enabled.";
  let summary = "";
  let shown = 0;
  for (const name of callable) {
    const next = summary ? `${summary}, ${name}` : name;
    if (next.length > SUMMARY_CHARS) break;
    summary = next;
    shown++;
  }
  return shown < callable.length ? `${summary} (+${callable.length - shown} more)` : summary;
}

export function coreQueryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))].slice(0, MAX_QUERY_TOKENS);
}

/** Deterministic token ranking over callable tools; blocked tools are never suggested. */
export function searchCoreCatalogs(catalogs: readonly CoreCatalog[], query: string, limit: number): CoreSearchHit[] {
  const tokens = coreQueryTokens(query);
  const phrase = query.trim().toLowerCase();
  if (tokens.length === 0) return [];
  const scored: Array<{ score: number; hit: CoreSearchHit }> = [];
  for (const catalog of catalogs) {
    for (const tool of catalog.tools) {
      if (tool.policy === "blocked") continue;
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      if (name === phrase || tool.qualifiedName.toLowerCase() === phrase) score += 10;
      for (const token of tokens) {
        if (name === token) score += 5;
        else if (name.includes(token)) score += 3;
        if (description.includes(token)) score += 1;
        if (catalog.service.includes(token)) score += 1;
      }
      if (score === 0) continue;
      scored.push({ score, hit: {
        serverId: catalog.serverId,
        service: catalog.service,
        tool: tool.name,
        qualifiedName: tool.qualifiedName,
        description: (tool.description.split(/\r?\n/, 1)[0] ?? "").slice(0, HIT_DESCRIPTION_CHARS),
        policy: tool.policy,
      } });
    }
  }
  scored.sort((left, right) => right.score - left.score || left.hit.qualifiedName.localeCompare(right.hit.qualifiedName));
  return scored.slice(0, Math.max(1, Math.min(limit, CORE_SEARCH_MAX_LIMIT))).map(entry => entry.hit);
}
