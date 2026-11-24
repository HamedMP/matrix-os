import {
  REMOTE_MCP_CATALOG,
  isRemoteMcpCatalogEntryConnectable,
  remoteMcpCatalogEntry,
  remoteMcpCatalogEntryForUrl,
  type RemoteMcpAuth,
  type RemoteMcpCatalogEntry,
  type RemoteMcpDepartment,
  type RemoteMcpRegisteredOAuth,
} from "@matrix-os/contracts/remote-mcp-catalog";

const boundedToken = (value: string | undefined, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);

/** One Matrix-owned vendor OAuth app. The secret is a private field so it never serializes. */
export class RegisteredMcpOAuthClient {
  readonly #clientSecret: string;

  constructor(
    readonly catalogId: string,
    readonly clientId: string,
    clientSecret: string,
    readonly pinned: Readonly<RemoteMcpRegisteredOAuth>,
  ) {
    this.#clientSecret = clientSecret;
  }

  /** Used only to authenticate to the pinned token/revocation endpoint. */
  get clientSecret(): string {
    return this.#clientSecret;
  }

  toJSON(): { catalogId: string; clientId: string } {
    return { catalogId: this.catalogId, clientId: this.clientId };
  }
}

/**
 * Platform-only registry of Matrix-owned OAuth apps, parsed once at startup from
 * `MCP_OAUTH_<VENDOR>_CLIENT_ID` / `_CLIENT_SECRET`. A missing or malformed
 * pair makes that preset unavailable; it is never a startup error.
 */
export class RegisteredMcpOAuthClients {
  private readonly clients: ReadonlyMap<string, RegisteredMcpOAuthClient>;

  private constructor(clients: Map<string, RegisteredMcpOAuthClient>) {
    this.clients = clients;
  }

  static empty(): RegisteredMcpOAuthClients {
    return new RegisteredMcpOAuthClients(new Map());
  }

  static fromEnv(
    env: Readonly<Record<string, string | undefined>>,
    warn: (message: string, detail: { catalogId: string; reason: "incomplete" | "invalid" }) => void = console.warn,
  ): RegisteredMcpOAuthClients {
    const clients = new Map<string, RegisteredMcpOAuthClient>();
    for (const entry of REMOTE_MCP_CATALOG) {
      if (entry.auth !== "oauth_registered_client" || entry.deferred || !entry.registeredOAuth) continue;
      const prefix = `MCP_OAUTH_${entry.id.toUpperCase()}`;
      const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
      const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
      if (!clientId && !clientSecret) continue;
      if (!clientId || !clientSecret) {
        warn("[custom-mcp] Matrix OAuth app config ignored", { catalogId: entry.id, reason: "incomplete" });
        continue;
      }
      if (!boundedToken(clientId, 2048) || !boundedToken(clientSecret, 8192)) {
        warn("[custom-mcp] Matrix OAuth app config ignored", { catalogId: entry.id, reason: "invalid" });
        continue;
      }
      clients.set(entry.id, new RegisteredMcpOAuthClient(entry.id, clientId, clientSecret, entry.registeredOAuth));
    }
    return new RegisteredMcpOAuthClients(clients);
  }

  has(catalogId: string): boolean {
    return this.clients.has(catalogId);
  }

  forCatalogId(catalogId: string): RegisteredMcpOAuthClient | undefined {
    return this.clients.get(catalogId);
  }

  /** A pasted vendor URL uses the same pinned app as its preset. */
  forServerUrl(url: string): RegisteredMcpOAuthClient | undefined {
    const entry = remoteMcpCatalogEntryForUrl(url);
    return entry?.auth === "oauth_registered_client" ? this.clients.get(entry.id) : undefined;
  }

  toJSON(): { configured: string[] } {
    return { configured: [...this.clients.keys()] };
  }
}

/** Client-facing projection: no pinned OAuth endpoints, scopes, or app ids. */
export interface CatalogPresetProjection {
  id: string;
  name: string;
  description: string;
  category: string;
  departments: RemoteMcpDepartment[];
  url: string;
  auth: RemoteMcpAuth;
  demandRank?: number;
}

export interface CatalogPresetFilters {
  category?: string;
  department?: RemoteMcpDepartment;
}

function project(entry: Readonly<RemoteMcpCatalogEntry>): CatalogPresetProjection {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    category: entry.category,
    departments: [...entry.departments],
    url: entry.url,
    auth: entry.auth,
    ...(entry.demandRank !== undefined ? { demandRank: entry.demandRank } : {}),
  };
}

export function listConnectableCatalogPresets(
  clients: RegisteredMcpOAuthClients,
  filters: CatalogPresetFilters = {},
): CatalogPresetProjection[] {
  return REMOTE_MCP_CATALOG
    .filter(entry => isRemoteMcpCatalogEntryConnectable(entry, id => clients.has(id)))
    .filter(entry => filters.category === undefined || entry.category === filters.category)
    .filter(entry => filters.department === undefined || entry.departments.includes(filters.department))
    .map(project)
    .sort((a, b) => (a.demandRank ?? Number.POSITIVE_INFINITY) - (b.demandRank ?? Number.POSITIVE_INFINITY));
}

export function resolveConnectableCatalogPreset(
  clients: RegisteredMcpOAuthClients,
  catalogId: string,
): Readonly<RemoteMcpCatalogEntry> | undefined {
  const entry = remoteMcpCatalogEntry(catalogId);
  return entry && isRemoteMcpCatalogEntryConnectable(entry, id => clients.has(id)) ? entry : undefined;
}
