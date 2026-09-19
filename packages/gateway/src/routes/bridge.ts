/**
 * Message dispatch + app bridge routes (extracted from server.ts, Phase 1-A1.1).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * Owns every `/api/message` and `/api/bridge/*` path so the bridge surface
 * lives in one module.
 *
 * Security notes (preserved from the inline versions):
 * - bodyLimit on every mutating route.
 * - `/api/bridge/proxy` is allowlist-only (no user-supplied host) with
 *   `redirect: "error"` and `AbortSignal.timeout(10_000)`.
 * - `/api/bridge/data` file fallback pins paths under `~/data/<app>` and
 *   rejects traversal.
 * - DB/provider errors are logged server-side; clients get generic messages.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { KernelEvent } from "@matrix-os/kernel";
import { createIntegrationBridgeRoutes } from "../integrations/bridge-routes.js";
import { BridgeQueryBodySchema } from "../domains/apps/db/app-db-contracts.js";
import type { KvStore } from "../domains/apps/db/app-db-kv.js";
import type { QueryEngine } from "../domains/apps/db/app-db-query.js";
import type { AppRegistry } from "../domains/apps/db/app-db-registry.js";
import { type Dispatcher, type DispatchContext } from "../domains/sessions/dispatcher.js";
import type { ServerMessage } from "../server/types.js";

const MESSAGE_BODY_LIMIT = 64 * 1024; // 64 KiB
const BRIDGE_QUERY_BODY_LIMIT = 1_000_000; // 1 MiB
const BRIDGE_DATA_BODY_LIMIT = 1_000_000; // 1 MiB

const ApiMessageBodySchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0),
  sessionId: z.string().optional(),
  from: z.object({
    handle: z.string(),
    displayName: z.string().optional(),
  }).optional(),
});

// Route-boundary schemas: bounded Zod validation before any sanitize/use.
// Bounds are generous (parity with the previously unbounded manual checks);
// sanitization and allowlists below still apply.
const BridgeProxyQuerySchema = z.object({
  url: z.string().min(1).max(2048),
});

const BridgeDataQuerySchema = z.object({
  app: z.string().min(1).max(1024),
  key: z.string().min(1).max(1024),
});

const BridgeDataBodySchema = z.object({
  action: z.enum(["read", "write"]),
  app: z.string().min(1).max(1024),
  key: z.string().min(1).max(1024),
  value: z.string().max(1_000_000).optional(),
});

export interface BridgeRouteDeps {
  dispatcher: Dispatcher;
  /** Request-time readers: the engine handles are nulled on DB shutdown, so
   *  closures preserve the original read-timing instead of mount-time snapshots. */
  getQueryEngine: () => QueryEngine | null;
  getAppRegistry: () => AppRegistry | null;
  getKvStore: () => KvStore | null;
  homePath: string;
  ensureAppProvisioned: (storageSlug: string) => Promise<void>;
  broadcast: (msg: ServerMessage) => void;
  logUnexpectedJsonParseFailure: (context: string, err: unknown) => void;
  /** Mount-time snapshot, identical to the previous inline mount: the
   *  integration bridge reads these options once at registration. */
  integrationBridge: Parameters<typeof createIntegrationBridgeRoutes>[0];
}

export function createBridgeRoutes(deps: BridgeRouteDeps): Hono {
  const app = new Hono();
  const apiMessageBodyLimit = bodyLimit({ maxSize: MESSAGE_BODY_LIMIT });
  const bridgeQueryBodyLimit = bodyLimit({ maxSize: BRIDGE_QUERY_BODY_LIMIT });
  const bridgeDataBodyLimit = bodyLimit({ maxSize: BRIDGE_DATA_BODY_LIMIT });

  app.post("/api/message", apiMessageBodyLimit, async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      console.warn("[gateway] Invalid /api/message JSON:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsedBody = ApiMessageBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: "Invalid message body" }, 400);
    }
    const body = parsedBody.data;
    const events: KernelEvent[] = [];

    const context: DispatchContext | undefined = body.from
      ? { senderId: body.from.handle, senderName: body.from.displayName ?? body.from.handle }
      : undefined;

    try {
      await deps.dispatcher.dispatch(body.text, body.sessionId, (event) => {
        events.push(event);
      }, context);
    } catch (err: unknown) {
      console.error("[gateway] Message dispatch failed:", err);
      return c.json({ error: "Message dispatch failed" }, 500);
    }

    return c.json({ events });
  });

  // Structured query API (Postgres-backed)
  app.post("/api/bridge/query", bridgeQueryBodyLimit, async (c) => {
    const queryEngine = deps.getQueryEngine();
    const appRegistry = deps.getAppRegistry();
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
      await deps.ensureAppProvisioned(appSlug);
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
          deps.broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json(result, 201);
        }
        case "bulkInsert": {
          const result = await queryEngine.bulkInsert(
            appSlug,
            safeTable,
            body.rows,
          );
          deps.broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json(result, 201);
        }
        case "update": {
          await queryEngine.update(appSlug, safeTable, body.id, body.data);
          deps.broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "bulkUpdate": {
          await queryEngine.bulkUpdate(
            appSlug,
            safeTable,
            body.updates,
          );
          deps.broadcast({ type: "data:change", app: appSlug, key: safeTable });
          return c.json({ ok: true });
        }
        case "delete": {
          await queryEngine.delete(appSlug, safeTable, body.id);
          deps.broadcast({ type: "data:change", app: appSlug, key: safeTable });
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
    const parsedQuery = BridgeProxyQuerySchema.safeParse({ url: c.req.query("url") });
    if (!parsedQuery.success) {
      return c.json({ error: "url query param required" }, 400);
    }
    const target = parsedQuery.data.url;
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
    const parsedQuery = BridgeDataQuerySchema.safeParse({ app: c.req.query("app"), key: c.req.query("key") });
    if (!parsedQuery.success) return c.json({ error: "app and key query params required" }, 400);
    const appName = parsedQuery.data.app;
    const key = parsedQuery.data.key;

    const safeApp = appName.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeApp || !safeKey) return c.json({ error: "Invalid app or key" }, 400);

    const kvStore = deps.getKvStore();
    if (kvStore) {
      try {
        const value = await kvStore.read(safeApp, safeKey);
        return c.json({ value });
      } catch (e) {
        console.error(`[app-db] KV read error for ${safeApp}/${safeKey}:`, (e as Error).message);
        return c.json({ error: "Database read failed" }, 500);
      }
    }

    const dataDir = join(deps.homePath, "data", safeApp);
    const filePath = normalize(join(dataDir, `${safeKey}.json`));
    if (!filePath.startsWith(normalize(dataDir))) return c.json({ error: "Path traversal denied" }, 403);
    if (!existsSync(filePath)) return c.json({ value: null });
    const content = readFileSync(filePath, "utf-8");
    let value = content;
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "string") value = parsed;
    } catch (err: unknown) {
      deps.logUnexpectedJsonParseFailure("Failed to parse stored bridge value", err);
    }
    return c.json({ value });
  });

  app.post("/api/bridge/data", bridgeDataBodyLimit, async (c) => {
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

    const parsedBody = BridgeDataBodySchema.safeParse(rawBody);
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
    const kvStore = deps.getKvStore();
    if (kvStore) {
      try {
        if (body.action === "read") {
          const value = await kvStore.read(safeApp, safeKey);
          return c.json({ value });
        }
        await kvStore.write(safeApp, safeKey, body.value ?? "");
        deps.broadcast({ type: "data:change", app: safeApp, key: safeKey });
        return c.json({ ok: true });
      } catch (e) {
        console.error(`[app-db] KV ${body.action} error for ${safeApp}/${safeKey}:`, (e as Error).message);
        return c.json({ error: "Database operation failed" }, 500);
      }
    }

    // File-based fallback (no Postgres)
    const dataDir = join(deps.homePath, "data", safeApp);
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
        deps.logUnexpectedJsonParseFailure("Failed to parse stored bridge data", err);
      }
      return c.json({ value });
    }

    await mkdirAsync(dataDir, { recursive: true });
    const raw = body.value ?? "";
    await writeFileAsync(filePath, typeof raw === "string" ? raw : String(raw), "utf-8");
    deps.broadcast({ type: "data:change", app: safeApp, key: safeKey });
    return c.json({ ok: true });
  });

  app.route("/api/bridge/service", createIntegrationBridgeRoutes(deps.integrationBridge));

  return app;
}
