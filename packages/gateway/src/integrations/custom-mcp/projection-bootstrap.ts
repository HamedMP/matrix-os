import { z } from "zod/v4";
import type { CustomMcpProjectionStore } from "./projection-store.js";
import type { CustomMcpServerProjection } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 6;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 120_000;
const RESYNC_INTERVAL_MS = 5 * 60_000;
const STALE_RETRY_DELAY_MS = 2_000;
const STALE_RETRIES = 3;
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

export type CustomMcpProjectionPullOutcome = "applied" | "stale" | "retry" | "rejected";

interface PullOptions {
  store: Pick<CustomMcpProjectionStore, "writeGeneration" | "replaceFromPull">;
  listUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Spec 537: one pull of the owner's current servers into a Private Preview's
 * projection. The list replaces the projection, so servers deleted while the
 * preview missed a push disappear too. A push that lands while the list is in
 * flight may be newer than it, so that list is discarded ("stale").
 */
export async function pullCustomMcpProjection(options: PullOptions): Promise<CustomMcpProjectionPullOutcome> {
  const generation = options.store.writeGeneration();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(options.listUrl, {
      headers: { authorization: `Bearer ${options.token}` },
      redirect: "error",
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (error: unknown) {
    console.warn("[custom-mcp] projection pull failed", error instanceof Error ? error.name : "UnknownError");
    return "retry";
  }
  // 403 and 5xx can clear once the platform sees the machine running and eligible.
  if (response.status === 403 || response.status >= 500) return "retry";
  if (!response.ok) {
    console.warn(`[custom-mcp] projection pull rejected status=${response.status}`);
    return "rejected";
  }
  let servers: ListedServer[];
  try {
    servers = ListedServersSchema.parse(await response.json());
  } catch (error: unknown) {
    console.warn("[custom-mcp] projection pull returned an invalid list", error instanceof Error ? error.name : "UnknownError");
    return "rejected";
  }
  try {
    return await options.store.replaceFromPull(servers.map(toProjection), generation) ? "applied" : "stale";
  } catch (error: unknown) {
    console.warn("[custom-mcp] projection pull could not be stored", error instanceof Error ? error.name : "UnknownError");
    return "rejected";
  }
}

/**
 * A Private Preview starts after its owner configured Custom MCP on another
 * computer. At startup it pulls until a list applies, retrying while the
 * platform does not yet consider the machine eligible or a push overtook the
 * list.
 */
export async function bootstrapCustomMcpProjection(options: PullOptions & {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
    if (options.signal?.aborted) return false;
    const outcome = await pullCustomMcpProjection(options);
    if (outcome === "applied") return true;
    if (outcome === "rejected") return false;
  }
  return false;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Starts the startup pull, then pulls again on an interval so a push the
 * preview missed (it was restarting, or the platform's bounded delivery queue
 * dropped it) converges without a restart. A periodic pull that a push
 * overtook is retried shortly instead of an interval later. `stop` ends both.
 */
export function startCustomMcpProjectionSync(options: PullOptions & {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}): { stop(): void } {
  const controller = new AbortController();
  const signal = controller.signal;
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const pullOptions = { ...options, sleep, signal };
  void (async () => {
    await bootstrapCustomMcpProjection(pullOptions);
    while (!signal.aborted) {
      await sleep(options.intervalMs ?? RESYNC_INTERVAL_MS);
      for (let attempt = 0; attempt <= STALE_RETRIES && !signal.aborted; attempt += 1) {
        if (attempt > 0) await sleep(STALE_RETRY_DELAY_MS);
        if (signal.aborted || await pullCustomMcpProjection(pullOptions) !== "stale") break;
      }
    }
  })().catch((error: unknown) => {
    console.warn("[custom-mcp] projection sync crashed", error instanceof Error ? error.name : "UnknownError");
  });
  return {
    stop() {
      controller.abort();
    },
  };
}
