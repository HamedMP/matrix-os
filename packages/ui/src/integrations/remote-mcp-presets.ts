import { REMOTE_MCP_DEPARTMENTS, remoteMcpCatalogEntryForUrl, type RemoteMcpDepartment } from "@matrix-os/contracts/remote-mcp-catalog";

/** Client view of `GET /api/mcp-servers/catalog` (spec 2691). */
export interface RemoteMcpPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  departments: RemoteMcpDepartment[];
  url: string;
  auth: "oauth_dcr" | "oauth_registered_client" | "none";
  demandRank?: number;
}

export const REMOTE_MCP_DEPARTMENT_LABELS: Record<RemoteMcpDepartment, string> = {
  engineering: "Engineering", product: "Product", design: "Design", sales: "Sales",
  marketing: "Marketing", support: "Support", operations: "Operations", finance: "Finance",
};

const MAX_PRESETS = 200;
const AUTH = new Set(["oauth_dcr", "oauth_registered_client", "none"]);
const DEPARTMENTS = new Set<string>(REMOTE_MCP_DEPARTMENTS);

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function isPreset(value: unknown): value is RemoteMcpPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preset = value as Record<string, unknown>;
  if (!boundedString(preset.id, 40) || !/^[a-z][a-z0-9_]+$/.test(preset.id)) return false;
  if (!boundedString(preset.name, 60) || !boundedString(preset.description, 120) || !boundedString(preset.category, 30)) return false;
  if (!Array.isArray(preset.departments) || preset.departments.length > 8
    || !preset.departments.every(department => typeof department === "string" && DEPARTMENTS.has(department))) return false;
  if (!boundedString(preset.url, 512) || typeof preset.auth !== "string" || !AUTH.has(preset.auth)) return false;
  if (preset.demandRank !== undefined && (!Number.isInteger(preset.demandRank) || (preset.demandRank as number) < 1)) return false;
  try {
    return new URL(preset.url).protocol === "https:";
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** Drops malformed entries; throws only when the payload itself is not a catalog. */
export function parseRemoteMcpCatalog(payload: unknown): RemoteMcpPreset[] {
  const presets = payload && typeof payload === "object" ? (payload as { presets?: unknown }).presets : undefined;
  if (!Array.isArray(presets) || presets.length > MAX_PRESETS) throw new Error("Invalid MCP catalog response");
  return presets.filter(isPreset).map(preset => ({ ...preset, departments: [...preset.departments] }));
}

export function filterRemoteMcpPresets(
  presets: readonly RemoteMcpPreset[],
  filters: { query?: string; department?: RemoteMcpDepartment | null },
): RemoteMcpPreset[] {
  const query = filters.query?.trim().toLowerCase() ?? "";
  return presets.filter(preset =>
    (!filters.department || preset.departments.includes(filters.department))
    && (!query || [preset.name, preset.description, preset.category.replaceAll("_", " ")].some(text => text.toLowerCase().includes(query))));
}

/** Allowlisted copy for Custom MCP route failures; server text is never shown. */
export function customMcpErrorMessage(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  if (status === 409 && code === "oauth_client_setup_required") return "This service needs administrator setup before you can sign in.";
  if (status === 409) return "This connection changed elsewhere. Refresh and try again.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 401) return "Sign in to Matrix again to manage connections.";
  if (status === 400) return "Check the server details and try again.";
  return "The MCP request failed. Try again.";
}

export type McpInventoryEntry =
  | { kind: "mcp"; id: string; name: string; statusLabel: string; presetId?: string }
  | { kind: "pipedream"; id: string; name: string; statusLabel: string; accountLabel?: string };

const MCP_STATUS_LABELS: Record<string, string> = {
  ready: "Connected", auth_required: "Sign-in required", disabled: "Disabled", degraded: "Degraded",
  action_required: "Action required", pending: "Pending",
};

/** One inventory of MCP servers plus legacy Pipedream connections (read-only here). */
export function buildMcpConnectionInventory(
  servers: ReadonlyArray<{ id: string; name: string; url: string; status: string }>,
  pipedream: ReadonlyArray<{ id: string; service: string; account_label?: string | null; status: string }>,
  serviceNames: Readonly<Record<string, string>> = {},
): McpInventoryEntry[] {
  const mcp = servers.map((server): McpInventoryEntry => {
    const presetId = remoteMcpCatalogEntryForUrl(server.url)?.id;
    return { kind: "mcp", id: server.id, name: server.name, statusLabel: MCP_STATUS_LABELS[server.status] ?? "Unknown", ...(presetId ? { presetId } : {}) };
  });
  const legacy = pipedream.map((connection): McpInventoryEntry => ({
    kind: "pipedream", id: connection.id,
    name: Object.hasOwn(serviceNames, connection.service) ? serviceNames[connection.service]! : connection.service,
    statusLabel: connection.status === "active" ? "Connected" : "Needs attention",
    ...(connection.account_label ? { accountLabel: connection.account_label } : {}),
  }));
  return [...mcp, ...legacy];
}

/** Connections that are live right now, for the "routes to" summary of the Matrix MCP endpoint card. */
/** Services the Matrix MCP endpoint actually routes to: ready MCP servers only (connected apps are not exposed there). */
export function connectedMcpServices(inventory: readonly McpInventoryEntry[]): Array<{ name: string; presetId?: string }> {
  return inventory.flatMap(entry => {
    if (entry.kind !== "mcp" || entry.statusLabel !== "Connected") return [];
    return [entry.presetId ? { name: entry.name, presetId: entry.presetId } : { name: entry.name }];
  });
}
