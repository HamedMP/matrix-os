import { z } from "zod/v4";
import type { CustomMcpProjectionStore } from "./projection-store.js";
import type { CustomMcpServerProjection } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 6;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 120_000;
const MAX_SERVERS = 100;

const ListedServerSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  url: z.string().min(1).max(2_048),
  authMode: z.enum(["none", "oauth", "bearer", "api_key"]),
  enabled: z.boolean(),
  revision: z.number().int().min(0),
  tools: z.array(z.object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    approval: z.enum(["always_ask", "allow"]),
  })).max(500),
});
const ListedServersSchema = z.array(ListedServerSchema).max(MAX_SERVERS);

type ListedServer = z.infer<typeof ListedServerSchema>;

function toProjection(server: ListedServer): CustomMcpServerProjection {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    authMode: server.authMode,
    enabled: server.enabled,
    revision: server.revision,
    tools: server.tools.map((tool) => ({ name: tool.name, enabled: tool.enabled, approval: tool.approval })),
  };
}

/**
 * Spec 537: a Private Preview starts after its owner configured Custom MCP on
 * another computer, and the platform only pushes later changes. At startup it
 * pulls the owner's current servers once, retrying while the platform does
 * not yet consider the machine eligible. The store's revision guard keeps a
 * concurrent push from being overwritten by older pulled data.
 */
export async function bootstrapCustomMcpProjection(options: {
  store: Pick<CustomMcpProjectionStore, "upsert">;
  listUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
    let response: Response;
    try {
      response = await fetchImpl(options.listUrl, {
        headers: { authorization: `Bearer ${options.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      console.warn("[custom-mcp] projection pull failed", error instanceof Error ? error.name : "UnknownError");
      continue;
    }
    // 403 and 5xx can clear once the platform sees the machine running and eligible.
    if (response.status === 403 || response.status >= 500) continue;
    if (!response.ok) {
      console.warn(`[custom-mcp] projection pull rejected status=${response.status}`);
      return false;
    }
    let servers: ListedServer[];
    try {
      servers = ListedServersSchema.parse(await response.json());
    } catch (error: unknown) {
      console.warn("[custom-mcp] projection pull returned an invalid list", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
    for (const server of servers) {
      try {
        await options.store.upsert(toProjection(server));
      } catch (error: unknown) {
        console.warn("[custom-mcp] projection pull could not store a server", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return true;
  }
  return false;
}
