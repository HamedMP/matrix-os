import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { OWNER_APP_READ_PATH, OwnerAppReadInputSchema, OWNER_APP_READ_DEFAULT_ROWS,
  OWNER_APP_READ_MAX_ROWS, OWNER_APP_READ_MAX_BYTES, OWNER_APP_READ_BODY_BYTES,
  type OwnerAppReadAudit } from "@matrix-os/contracts";
import type { AppRegistry } from "./app-db-registry.js";
import type { QueryEngine } from "./app-db-query.js";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "./chat/matrix-mcp-launch.js";

export interface OwnerAppReadRouteOptions {
  appRegistry: AppRegistry; queryEngine: QueryEngine; configuredOwnerId: string; runtimeHandle: string;
  audit: OwnerAppReadAudit;
  defaultRows?: number; maxRows?: number; maxResponseBytes?: number; bodyLimitBytes?: number;
}

/** Installed on the same Hono app as the dedicated run-bearer auth gate. */
export function registerOwnerAppDataReadRoutes(app: Hono, options: OwnerAppReadRouteOptions): void {
  if (!options?.appRegistry?.get || !options.queryEngine?.find || !options.configuredOwnerId
    || !options.runtimeHandle || typeof options.audit !== "function") throw new Error("App read dependencies unavailable");
  const caps = [options.defaultRows ?? OWNER_APP_READ_DEFAULT_ROWS, options.maxRows ?? OWNER_APP_READ_MAX_ROWS,
    options.maxResponseBytes ?? OWNER_APP_READ_MAX_BYTES, options.bodyLimitBytes ?? OWNER_APP_READ_BODY_BYTES];
  if (caps.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > [50, 100, 65536, 16384][i]!)
    || caps[0]! > caps[1]!) throw new Error("Invalid app read limits");
  const [defaultRows, maxRows, maxBytes, bodyBytes] = caps as [number, number, number, number];
  const unavailable = { error: "App data read unavailable" };
  const runAuthority = (c: Context) => {
    const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
    return { ownerId: run?.actorId, runId: run?.runId, runtimeHandle: options.runtimeHandle };
  };
  const routes = new Hono();
  routes.onError((error, c) => {
    console.warn("[app-data-read] Request unavailable", error.name);
    return c.json(unavailable, 503);
  });
  routes.post(OWNER_APP_READ_PATH, bodyLimit({ maxSize: bodyBytes, onError: async c => {
    await options.audit({ ...runAuthority(c), outcome: "denied" });
    return c.json({ error: "App data request too large" }, 413);
  } }), async c => {
    const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
    const live = () => !!run?.isLive?.() && run.actorId === options.configuredOwnerId
      && run.appDataRead?.runtimeHandle === options.runtimeHandle;
    const authority = runAuthority(c);
    let requestDetails: { app?: string; action?: "listApps" | "schema" | "find"; table?: string } = {};
    const deny = async (status: 400 | 401 | 403) => {
      await options.audit({ ...authority, ...requestDetails, outcome: "denied" });
      return c.json({ error: "App data read denied" }, status);
    };
    if (!live()) return deny(401);
    let value: unknown;
    try { value = await c.req.json(); }
    catch (error: unknown) {
      if (error instanceof SyntaxError) return deny(400);
      throw error;
    }
    const parsed = OwnerAppReadInputSchema.safeParse(value);
    if (!parsed.success) return deny(400);
    const input = parsed.data;
    requestDetails = { action: input.action, ...("app" in input ? { app: input.app } : {}),
      ...("table" in input ? { table: input.table } : {}) };
    const event = { ...authority, ...requestDetails };
    let data: unknown;
    try {
      const grants = run!.appDataRead!.apps;
      if (input.action === "listApps") {
        const apps = [];
        for (const grant of grants) {
          if (await options.appRegistry.get(grant.schema)) apps.push({ app: grant.app, schema: grant.schema });
        }
        data = { apps };
      } else {
        const grant = grants.find(app => app.app === input.app);
        if (!grant) return deny(403);
        const record = await options.appRegistry.get(grant.schema);
        if (!record) return deny(403);
        const tables = Object.fromEntries(Object.entries(record.tables).filter(([name]) => grant.tables.includes(name)));
        if (input.action === "schema") data = { app: input.app, schema: grant.schema, tables };
        else {
          const table = Object.hasOwn(tables, input.table) ? tables[input.table] : undefined;
          if (!table) return deny(403);
          const columns = [...new Set(["id", "created_at", "updated_at", ...Object.keys(table.columns)])]; // registry-bound projection
          if (columns.length > 128) return deny(403);
          if ([...Object.keys(input.filter ?? {}), ...Object.keys(input.orderBy ?? {})].some(col => !columns.includes(col))) return deny(400);
          const orderBy = { ...input.orderBy, id: input.orderBy?.id ?? "asc" as const };
          if (!live()) return deny(401);
          data = { rows: await options.queryEngine.find(grant.schema, input.table, {
            filter: input.filter, orderBy, limit: Math.min(input.limit ?? defaultRows, maxRows), offset: input.offset,
            columns, maxResponseBytes: maxBytes - 32, readOnly: true,
          }) };
        }
      }
      if (!live()) return deny(401);
      const encoded = JSON.stringify(data);
      if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
        await options.audit({ ...event, outcome: "error" });
        return c.json({ error: "App data response too large" }, 413);
      }
      await options.audit({ ...event, outcome: "allowed" });
      if (!live()) return deny(401);
      return c.body(encoded, 200, { "content-type": "application/json", "cache-control": "no-store" });
    } catch (error: unknown) {
      console.warn("[app-data-read] Read unavailable", error instanceof Error ? error.name : "UnknownError");
      await options.audit({ ...event, outcome: "error" });
      return error instanceof Error && error.name === "AppReadLimitError"
        ? c.json({ error: "App data response too large" }, 413) : c.json(unavailable, 503);
    }
  });
  app.route("/", routes);
}
