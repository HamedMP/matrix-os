/**
 * Organization → Connections client and derivations, shared by Web Canvas,
 * Web Desktop, and Electron Desktop (spec 2691 layer 5). Every response is
 * schema-checked; every failure becomes fixed copy, never server text.
 */
import {
  OrgMcpConnectionsPageSchema,
  OrgMcpMutationResultSchema,
  OrgMcpUsageResponseSchema,
  type OrgMcpConnectionsPage,
  type OrgMcpMember,
  type OrgMcpServerDefinition,
  type OrgMcpServerMode,
  type OrgMcpUsageResponse,
  type OrgMcpUsageRow,
} from "@matrix-os/contracts";
import type { CollaborationApi } from "../collaboration/ChatCollaboratorsDialog.js";

export const ORG_MCP_USAGE_WINDOW_DAYS = 30;
const MAX_MEMBER_PAGES = 40;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
const ORG_MCP_PATH = /^\/api\/orgs\/[A-Za-z0-9_]+\/mcp\/[A-Za-z0-9_.:%/-]+(?:\?[A-Za-z0-9_.:%=&-]*)?$/;

export type OrganizationMcpHttpApi = Pick<CollaborationApi, "get" | "put" | "delete">;

/**
 * Same-origin platform transport for the admin routes only: a fixed path
 * shape, no redirects, a 10 s deadline, a bounded JSON body, and one generic
 * error for every failure.
 */
export function createOrganizationMcpHttpApi(options: { baseUrl: string; fetchImpl?: typeof fetch }): OrganizationMcpHttpApi {
  const origin = new URL(options.baseUrl).origin;
  const request = async (method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> => {
    if (!ORG_MCP_PATH.test(path) || path.includes("..")) throw new Error("OrganizationConnectionsUnavailable");
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error("OrganizationConnectionsUnavailable");
    try {
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        credentials: "same-origin",
        redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
        await response.body?.cancel();
        throw new Error("OrganizationConnectionsUnavailable");
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new Error("OrganizationConnectionsUnavailable");
      return JSON.parse(text) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === "OrganizationConnectionsUnavailable")) {
        console.warn("[org-mcp] request failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new Error("OrganizationConnectionsUnavailable");
    }
  };
  return {
    get: (path) => request("GET", path),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),
  };
}

export interface OrganizationMcpAdminClient {
  listConnections(cursor?: string): Promise<OrgMcpConnectionsPage>;
  listUsage(range: { from: string; to: string }): Promise<OrgMcpUsageResponse>;
  setServerMode(serverDefId: string, mode: OrgMcpServerMode): Promise<void>;
  clearServer(serverDefId: string): Promise<void>;
  blockMember(memberId: string, serverDefId: string): Promise<void>;
  unblockMember(memberId: string, serverDefId: string): Promise<void>;
}

export function createOrganizationMcpAdminClient(
  api: OrganizationMcpHttpApi,
  organizationId: string,
): OrganizationMcpAdminClient {
  const base = `/api/orgs/${encodeURIComponent(organizationId)}/mcp`;
  const put = (path: string, body: unknown) => {
    if (!api.put) throw new Error("OrganizationConnectionsUnavailable");
    return api.put(path, body);
  };
  const complete = async (request: Promise<unknown>) => { OrgMcpMutationResultSchema.parse(await request); };
  const server = (id: string) => `${base}/servers/${encodeURIComponent(id)}`;
  const block = (memberId: string, id: string) => `${base}/members/${encodeURIComponent(memberId)}/blocks/${encodeURIComponent(id)}`;
  return {
    listConnections: async (cursor) => OrgMcpConnectionsPageSchema.parse(
      await api.get(`${base}/connections?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)),
    listUsage: async ({ from, to }) => OrgMcpUsageResponseSchema.parse(
      await api.get(`${base}/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)),
    setServerMode: (id, mode) => complete(put(server(id), { mode })),
    clearServer: (id) => complete(api.delete(server(id))),
    blockMember: (memberId, id) => complete(put(block(memberId, id), {})),
    unblockMember: (memberId, id) => complete(api.delete(block(memberId, id))),
  };
}

export interface OrganizationMcpSnapshot {
  members: OrgMcpMember[];
  servers: OrgMcpServerDefinition[];
  usage: OrgMcpUsageRow[];
  usageTruncated: boolean;
  usageUpdatedAt: string;
  membersTruncated: boolean;
}

export function usageWindow(now: Date, days = ORG_MCP_USAGE_WINDOW_DAYS): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

/** Every member page (bounded) plus the usage window, as one consistent snapshot. */
export async function loadOrganizationMcpSnapshot(client: OrganizationMcpAdminClient, now = new Date()): Promise<OrganizationMcpSnapshot> {
  const [first, usage] = await Promise.all([client.listConnections(), client.listUsage(usageWindow(now))]);
  const members = [...first.members];
  const seen = new Set<string>();
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor && !seen.has(cursor) && pages < MAX_MEMBER_PAGES) {
    seen.add(cursor);
    const page = await client.listConnections(cursor);
    members.push(...page.members);
    cursor = page.nextCursor;
    pages += 1;
  }
  return { members, servers: first.servers, usage: usage.rows, usageTruncated: usage.truncated, usageUpdatedAt: usage.updatedAt, membersTruncated: Boolean(cursor) };
}

export function callsByConnectionHost(usage: readonly OrgMcpUsageRow[], actorId: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of usage) {
    if (row.actorId !== actorId) continue;
    totals.set(row.serverKey, (totals.get(row.serverKey) ?? 0) + row.calls);
  }
  return totals;
}

export function serverModeFor(servers: readonly OrgMcpServerDefinition[], serverDefIds: readonly string[]): OrgMcpServerMode | null {
  const ids = new Set(serverDefIds);
  const modes = new Set(servers.filter(server => ids.has(server.serverDefId)).map(server => server.mode));
  if (modes.has("block")) return "block";
  if (modes.has("allow")) return "allow";
  return modes.has("recommend") ? "recommend" : null;
}

export const ORG_MCP_LOAD_ERROR = "Connections are unavailable right now. Try again.";
export const ORG_MCP_SAVE_ERROR = "That change couldn’t be saved. Try again.";
export const ORG_MCP_VISIBILITY_NOTICE = "Your organization’s admins can see which MCP servers you connect, each connection’s status and last use, and how many calls Matrix made by day, server, and tool. They never see your credentials or what those calls contained.";
