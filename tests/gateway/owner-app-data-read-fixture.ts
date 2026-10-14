import { Hono } from "hono";
import { afterAll, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppDb } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry, type AppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { createQueryEngine, type QueryEngine } from "../../packages/gateway/src/app-db-query.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import * as bridgeRoutes from "../../packages/gateway/src/server/bridge-routes.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

// ENG-289 RED contract. These proposed names are implementation seams, not a
// test implementation of the missing capability. No fallback handler is mounted.
// Existing auth, capability registry, MCP registration and Kysely/PG execute for
// real. Only audit collection/observability spies and network transport are fake.
export const READ_PATH = "/api/agent/app-data/read";
export const READ_TOOL = "read_app_data";
export const OWNER = { type: "personal", ownerId: "owner_app_read" };
export const RUN = "run_app_read";
export const RUNTIME = "runtime_owner_a";
export const DEFAULT_ROWS = 50;
export const MAX_ROWS = 100;
export const MAX_BYTES = 64 * 1024;
export const BODY_BYTES = 16 * 1024;
export const MACHINE_SECRET = "machine-secret-must-not-be-delegated";
export const DATABASE_SECRET = "postgres://matrix:db-secret@127.0.0.1/matrix";

type AuditEvent = {
  ownerId?: string; runId?: string; runtimeHandle?: string;
  app?: string; action?: string; outcome: "allowed" | "denied" | "error";
};
type RouteOptions = {
  appRegistry: AppRegistry; queryEngine: QueryEngine;
  configuredOwnerId: string; runtimeHandle: string;
  audit(event: AuditEvent): Promise<void>;
  defaultRows: number; maxRows: number; maxResponseBytes: number; bodyLimitBytes: number;
};
type Registration = (app: Hono, options: RouteOptions) => void;
export const registerReadRoutes = (bridgeRoutes as unknown as {
  registerOwnerAppDataReadRoutes?: Registration;
}).registerOwnerAppDataReadRoutes;

const cleanups: Array<() => Promise<void>> = []; // <=1 fixture per test; drained after every case.
// One PostgreSQL engine per suite; reset owner schemas between tests instead of
// retaining dozens of WASM heaps until the worker exits.
let database: Promise<ReturnType<typeof createAppDb> & { close(): Promise<void> }> | undefined;
function suiteDatabase() {
  return database ??= createTestPGlite().then(instance => {
    const created = createAppDb({ dialect: instance.dialect });
    return { ...created, close: () => created.db.destroy() };
  });
}
afterAll(async () => { if (database) await (await database).close(); });
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

export async function ownerReadFixture(options: { runtime?: string; rows?: number } = {}) {
  const { db, kysely } = await suiteDatabase();
  await db.raw('DROP SCHEMA IF EXISTS notes CASCADE');
  await db.raw('DROP SCHEMA IF EXISTS private_app CASCADE');
  await db.bootstrap();
  await db.raw('DELETE FROM public._apps');
  const apps = createAppRegistry(db, kysely);
  for (const slug of ["notes", "private_app"]) {
    await apps.register({ slug, name: slug, tables: {
      entries: { columns: { title: "text", position: "integer" } },
      restricted: { columns: { secret: "text" } },
    } });
  }
  // Physically present but NOT declared in the manifest/registry projection.
  await db.raw('CREATE TABLE notes.hidden (id text, secret text)');
  await db.raw("INSERT INTO notes.hidden VALUES ('hidden', 'undeclared-secret')");
  const engine = createQueryEngine(db);
  await engine.bulkInsert("notes", "entries", Array.from({ length: options.rows ?? 6 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    title: `note-${i + 1}`, position: i + 1,
  })).reverse());
  await engine.insert("private_app", "entries", { title: "foreign-app-secret", position: 1 });

  const before = await engine.find("notes", "entries", { orderBy: { position: "asc" } });
  const audit = vi.fn<(event: AuditEvent) => Promise<void>>(async () => undefined);
  let clock = 0;
  const registryOptions = { configuredOwnerId: OWNER.ownerId, configuredRuntimeHandle: RUNTIME, now: () => clock };
  const capabilities = createMatrixMcpCapabilityRegistry(registryOptions);
  cleanups.push(async () => capabilities.close());
  const grantInput = {
    owner: OWNER, runId: RUN, scope: "chat_call" as const,
    appDataRead: { runtimeHandle: RUNTIME, apps: [{ app: "notes", schema: "notes", tables: ["entries"] }] },
  };
  const grant = capabilities.issue(grantInput)!;
  const gateway = new Hono();
  const authOptions = {
    resolveMatrixMcpRunContext: capabilities.resolveRunContext,
    ownerAppDataRead: { runtimeHandle: options.runtime ?? RUNTIME, audit },
  };
  gateway.use("*", authMiddleware(MACHINE_SECRET, authOptions));
  registerReadRoutes?.(gateway, {
    appRegistry: apps, queryEngine: engine, configuredOwnerId: OWNER.ownerId,
    runtimeHandle: options.runtime ?? RUNTIME, audit,
    defaultRows: DEFAULT_ROWS, maxRows: MAX_ROWS, maxResponseBytes: MAX_BYTES, bodyLimitBytes: BODY_BYTES,
  });
  // The mixed write bridge is deliberately NOT registered or authorized here.
  const writes = [vi.spyOn(apps, "register"), vi.spyOn(apps, "unregister"),
    vi.spyOn(db, "createAppSchema"), vi.spyOn(db, "createTable"), vi.spyOn(db, "dropAppSchema"),
    vi.spyOn(engine, "insert"), vi.spyOn(engine, "bulkInsert"), vi.spyOn(engine, "update"),
    vi.spyOn(engine, "bulkUpdate"), vi.spyOn(engine, "compareAndSwap"), vi.spyOn(engine, "delete")];
  const raw = vi.spyOn(db, "raw");
  const find = vi.spyOn(engine, "find");
  const headers = { authorization: `Bearer ${grant.token}`, "content-type": "application/json" };
  const request = (body: unknown, extra: Record<string, string> = {}) => gateway.request(READ_PATH, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  async function connectMcp(surface: "chat-call" | "chat-discovery" = "chat-call") {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", grant.token);
    vi.stubEnv("MATRIX_AUTH_TOKEN", MACHINE_SECRET);
    vi.stubEnv("DATABASE_URL", DATABASE_SECRET);
    const fetcher = vi.fn<GatewayFetcher>(async (url, init) => gateway.request(new URL(url).pathname, init));
    const server = createIntegrationsMcpServer({ fetcher, toolSurface: surface });
    const client = new Client({ name: "owner-app-data-red", version: "1" });
    cleanups.push(async () => { await client.close(); await server.close(); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, fetcher };
  }
  return { gateway, request, headers, grant, grantInput, capabilities, audit, writes, raw, find,
    engine, apps, before, connectMcp, expire: () => { clock = 35 * 60_000; } };
}

export const fiveRows = { action: "find", app: "notes", table: "entries", limit: 5,
  orderBy: { position: "asc", id: "asc" } };
