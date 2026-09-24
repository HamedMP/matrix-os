/** Legacy app data bridge routes retained during gateway startup extraction. */
import { existsSync, readFileSync } from "node:fs";
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod/v4";
import { BridgeQueryBodySchema } from "../app-db-contracts.js";
import type { AppRegistry } from "../app-db-registry.js";
import type { QueryEngine } from "../app-db-query.js";
import type { KvStore } from "../app-db-kv.js";
import type { ServerMessage } from "./types.js";

export interface BridgeDataRouteOptions {
  homePath: string;
  queryEngine: QueryEngine | null;
  appRegistry: AppRegistry | null;
  kvStore: KvStore | null;
  ensureAppProvisioned(slug: string): Promise<void>;
  broadcast(message: ServerMessage): void;
  queryBodyLimit: MiddlewareHandler;
  dataBodyLimit: MiddlewareHandler;
  logUnexpectedJsonParseFailure(context: string, error: unknown): void;
}

/**
 * The KV bridge is an action endpoint, so the body is a discriminated union.
 * Without it an unrecognized action falls through to the write branch and
 * mutates owner data. Values arrive pre-encoded as strings from the shell
 * bridge (`encodeStoredValue`), so non-string values are rejected rather than
 * coerced onto disk.
 */
const BridgeKvBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    app: z.string().min(1),
    key: z.string().min(1),
  }),
  z.object({
    action: z.literal("write"),
    app: z.string().min(1),
    key: z.string().min(1),
    value: z.string().optional(),
  }),
]);

export function registerBridgeDataRoutes(app: Hono, options: BridgeDataRouteOptions): void {
  const {
    homePath, queryEngine, appRegistry, kvStore, ensureAppProvisioned,
    broadcast, queryBodyLimit, dataBodyLimit, logUnexpectedJsonParseFailure,
  } = options;
  // Structured query API (Postgres-backed)
  app.post("/api/bridge/query", queryBodyLimit, async (c) => {
    if (!queryEngine || !appRegistry) {
      return c.json({ error: "Database not configured (no DATABASE_URL)" }, 503);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      console.error("[bridge/query] Failed to read request body:", err);
      return c.json({ error: "Failed to read request body" }, 500);
    }

    const parsedBody = BridgeQueryBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      const exceedsRowLimit = parsedBody.error.issues.some((issue) =>
        issue.code === "too_big" && (issue.path[0] === "rows" || issue.path[0] === "updates")
      );
      return c.json(
        { error: exceedsRowLimit ? "rows too large (max 200 rows)" : "Invalid query body" },
        exceedsRowLimit ? 413 : 400,
      );
    }
    const body = parsedBody.data;
    const action = body.action;
    const appSlug = action === "listApps" ? "" : body.app;
    const safeTable = "table" in body ? body.table : "";

    // Ensure the app's Postgres schema exists before querying. Apps built in-OS
    // after gateway startup aren't in the startup registration pass; provision
    // them lazily from their manifest so the first query doesn't 500.
    if (appSlug && action !== "listApps") {
      await ensureAppProvisioned(appSlug);
    }

    try {
      switch (action) {
        case "find":
          return c.json(await queryEngine.find(appSlug, safeTable, {
            filter: body.filter,
            orderBy: body.orderBy,
            limit: body.limit,
            offset: body.offset,
          }));
        case "findOne":
          return c.json(await queryEngine.findOne(appSlug, safeTable, body.id));
        case "insert": {
          const result = await queryEngine.insert(appSlug, safeTable, body.data);
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json(result, 201);
        }
        case "bulkInsert": {
          const result = await queryEngine.bulkInsert(
            appSlug,
            safeTable,
            body.rows,
          );
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json(result, 201);
        }
        case "update": {
          await queryEngine.update(appSlug, safeTable, body.id, body.data);
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "bulkUpdate": {
          await queryEngine.bulkUpdate(
            appSlug,
            safeTable,
            body.updates,
          );
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "delete": {
          await queryEngine.delete(appSlug, safeTable, body.id);
          broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "count":
          return c.json({ count: await queryEngine.count(appSlug, safeTable, body.filter) });
        case "schema":
          return c.json(await appRegistry.getSchema(appSlug));
        case "appInfo": {
          const record = await appRegistry.get(appSlug);
          if (!record) return c.json({ error: "App not found" }, 404);
          return c.json({ installedVersion: record.installed_version });
        }
        case "listApps":
          return c.json(await appRegistry.listApps());
        default:
          return c.json({ error: `Unknown action: ${action}` }, 400);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[app-db] Query error:", msg);
      const isValidation =
        msg.startsWith("Invalid ") ||
        msg.startsWith("insert:") ||
        msg.startsWith("bulkInsert:") ||
        msg.startsWith("update:") ||
        msg.startsWith("bulkUpdate:");
      const safe = isValidation ? msg : "Query failed";
      return c.json({ error: safe }, isValidation ? 400 : 500);
    }
  });

  // Read-only outbound proxy for sandboxed apps. Apps run in a null-origin iframe
  // with CSP connect-src 'self', so they cannot call third-party APIs directly.
  // This proxies GET requests to a small, fixed allowlist of public, keyless data
  // APIs. Allowlist-only (no user-supplied host) keeps the SSRF surface closed.
  // The fetch remains hostname-based after allowlist validation, so it accepts
  // the residual DNS-rebinding risk for these stable public API hosts.
  const BRIDGE_PROXY_ALLOWED_HOSTS = new Set([
    "api.open-meteo.com",
    "geocoding-api.open-meteo.com",
  ]);
  app.get("/api/bridge/proxy", async (c) => {
    const target = c.req.query("url");
    if (!target || typeof target !== "string" || target.length > 2048) {
      return c.json({ error: "url query param required" }, 400);
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch (err) {
      if (!(err instanceof TypeError)) {
        console.warn("[bridge/proxy] URL parse failed:", err instanceof Error ? err.message : String(err));
      }
      return c.json({ error: "invalid url" }, 400);
    }
    if (parsed.protocol !== "https:" || !BRIDGE_PROXY_ALLOWED_HOSTS.has(parsed.hostname)) {
      // Do not echo the host back; this is an allowlist boundary.
      return c.json({ error: "url not allowed" }, 403);
    }
    try {
      const upstream = await fetch(parsed.toString(), {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!upstream.ok) {
        // Coarse status only; never leak upstream body/headers on failure.
        return c.json({ error: "upstream request failed" }, 502);
      }
      let data: unknown = null;
      try {
        data = await upstream.json();
      } catch (err) {
        console.warn("[bridge/proxy] upstream JSON parse failed:", err instanceof Error ? err.message : String(err));
      }
      if (data == null) return c.json({ error: "upstream returned no data" }, 502);
      return c.json({ data });
    } catch (e) {
      console.error("[bridge/proxy] fetch error:", (e as Error).message);
      return c.json({ error: "proxy request failed" }, 502);
    }
  });

  // Key-value bridge: GET for reads (query params), POST for read/write (JSON body)
  app.get("/api/bridge/data", async (c) => {
    const appName = c.req.query("app");
    const key = c.req.query("key");
    if (!appName || !key) return c.json({ error: "app and key query params required" }, 400);

    const safeApp = appName.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeApp || !safeKey) return c.json({ error: "Invalid app or key" }, 400);

    if (kvStore) {
      try {
        const value = await kvStore.read(safeApp, safeKey);
        return c.json({ value });
      } catch (e) {
        console.error(`[app-db] KV read error for ${safeApp}/${safeKey}:`, (e as Error).message);
        return c.json({ error: "Database read failed" }, 500);
      }
    }

    const dataDir = join(homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));
    if (!filePath.startsWith(normalize(dataDir))) return c.json({ error: "Path traversal denied" }, 403);
    if (!existsSync(filePath)) return c.json({ value: null });
    const content = readFileSync(filePath, "utf-8");
    let value = content;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "string") value = parsed;
    } catch (err: unknown) {
      logUnexpectedJsonParseFailure("Failed to parse stored bridge value", err);
    }
    return c.json({ value });
  });

  app.post("/api/bridge/data", dataBodyLimit, async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      console.error("[bridge/data] Failed to read request body:", err);
      return c.json({ error: "Failed to read request body" }, 500);
    }

    const parsedBody = BridgeKvBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const body = parsedBody.data;

    const safeApp = body.app.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = body.key.replace(/[^a-zA-Z0-9_-]/g, "");

    if (!safeApp || !safeKey) {
      return c.json({ error: "app and key must contain valid characters" }, 400);
    }

    // Postgres-backed path
    if (kvStore) {
      try {
        if (body.action === "read") {
          const value = await kvStore.read(safeApp, safeKey);
          return c.json({ value });
        }
        await kvStore.write(safeApp, safeKey, body.value ?? "");
        broadcast({ type: "data:change", app: safeApp, key: safeKey });
        return c.json({ ok: true });
      } catch (e) {
        console.error(`[app-db] KV ${body.action} error for ${safeApp}/${safeKey}:`, (e as Error).message);
        return c.json({ error: "Database operation failed" }, 500);
      }
    }

    // File-based fallback (no Postgres)
    const dataDir = join(homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));

    if (!filePath.startsWith(normalize(dataDir))) {
      return c.json({ error: "Path traversal denied" }, 403);
    }

    if (body.action === "read") {
      if (!existsSync(filePath)) return c.json({ value: null });
      const content = readFileSync(filePath, "utf-8");
      let value = content;
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === "string") {
          value = parsed;
        }
      } catch (err: unknown) {
        logUnexpectedJsonParseFailure("Failed to parse stored bridge data", err);
      }
      return c.json({ value });
    }

    await mkdirAsync(dataDir, { recursive: true });
    await writeFileAsync(filePath, body.value ?? "", "utf-8");
    broadcast({ type: "data:change", app: safeApp, key: safeKey });
    return c.json({ ok: true });
  });

}
