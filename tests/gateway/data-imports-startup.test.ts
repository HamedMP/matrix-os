import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { Hono } from "hono";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createRuntimeDataImportRoutes } from "../../packages/gateway/src/startup/data-imports.js";
import { IntegrationRefreshRepository } from "../../packages/gateway/src/integrations/refresh/repository.js";
import type { BotIntegrationTransport } from "../../packages/gateway/src/bots/integration-client.js";

const owner = "owner_1";
const source = { appId: "research_app", sourceId: "drive", service: "google_drive", action: "list_files", label: "main", connectionId: "connection_1", params: { maxResults: 25 } };
describe("runtime data import wiring", () => {
  let db: Kysely<any>;
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-data-imports-test-"));
    await mkdir(join(home, "apps", "research_app"), { recursive: true });
    await writeFile(join(home, "apps", "research_app", "matrix.json"), JSON.stringify({ name: "Research", integrations: { required: ["google_drive"] } }));
    const instance = await KyselyPGlite.create(); db = new Kysely({ dialect: instance.dialect });
  });
  afterEach(async () => { await db.destroy(); await rm(home, { recursive: true, force: true }); });
  async function mount(transport: BotIntegrationTransport | null, ownerDatabase: Kysely<any> | null = db) {
    const app = new Hono();
    app.use("*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, c.req.header("x-test-owner") ?? owner); await next(); });
    app.route("/api/data-imports", await createRuntimeDataImportRoutes({ ownerDatabase, homePath: home, runtimeOwnerIds: [owner], transport }));
    return app;
  }
  const refresh = (app: Hono, body = source, headers: Record<string, string> = {}) => app.request("/api/data-imports/refresh", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const inventory = [{ id: "connection_1", service: "google_drive", account_label: "main", status: "active" }];
  it("binds the owner database, installed manifest and exact live connection through the bounded read client", async () => {
    const transport = vi.fn().mockImplementation(async (_owner, request) => Response.json(request.method === "GET" ? inventory : { data: { files: [{ id: "a" }] } }));
    const app = await mount(transport);
    const response = await refresh(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "complete", calls: 1, pages: 1 });
    expect(transport.mock.calls).toHaveLength(2);
    expect(transport.mock.calls[1]).toEqual([owner, expect.objectContaining({ method: "POST", path: "/read-call", readScope: true,
      body: { service: "google_drive", action: "list_files", label: "main", connectionId: "connection_1", params: { maxResults: 25 } }, signal: expect.any(AbortSignal) })]);
    const pages = await app.request("/api/data-imports/sources/research_app/drive/pages");
    expect(await pages.json()).toEqual({ pages: [{ files: [{ id: "a" }] }] });
  });
  it("fails closed for an undeclared service, wrong owner, ambiguous/removed connection and opaque app origin", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json(inventory));
    const app = await mount(transport);
    expect((await refresh(app, source, { "x-test-owner": "other" })).status).toBe(403);
    expect((await refresh(app, source, { Origin: "null" })).status).toBe(403);
    expect((await refresh(app, { ...source, service: "gmail", action: "list_messages", params: {} })).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
    expect(await db.selectFrom("integration_refresh_sources").selectAll().execute()).toEqual([]);
    const ambiguous = await mount(async () => Response.json([...inventory, { ...inventory[0], id: "connection_2" }]));
    expect((await refresh(ambiguous, { ...source, sourceId: "ambiguous" })).status).toBe(403);
    const removed = await mount(async () => Response.json([]));
    expect((await refresh(removed, { ...source, sourceId: "removed" })).status).toBe(403);
  });
  it("checks inventory once inside the reserved lease and safely backs off a denied connection", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json([]));
    const app = await mount(transport);
    const response = await refresh(app);
    expect(response.status).toBe(403);
    expect(await db.selectFrom("integration_refresh_sources").selectAll().executeTakeFirst()).toMatchObject({ status: "backoff", pages: 0, calls: 1, lease_token: null });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][1]).toMatchObject({ method: "GET" });
    transport.mockClear();
    expect((await refresh(app)).status).toBe(200);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["complete", "backoff", "running"] as const)("does not contact integrations for an ineligible %s source", async status => {
    const transport = vi.fn(); const app = await mount(transport);
    const repository = new IntegrationRefreshRepository(db);
    const now = new Date();
    await repository.ensure(owner, source, now);
    const lease = (await repository.claim(owner, source.appId, source.sourceId, now))!;
    if (status === "complete") await repository.commit(lease, { files: [] }, null, null, now);
    if (status === "backoff") await repository.fail(lease, "source_unavailable", now);
    const response = await refresh(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status, calls: 1 });
    expect(transport).not.toHaveBeenCalled();
  });
  it("honors bare, read and exact read-action refs without expanding write-only permissions", async () => {
    const transport = vi.fn().mockImplementation(async (_owner, request) => Response.json(request.method === "GET" ? inventory : { data: { files: [] } }));
    const app = await mount(transport);
    for (const ref of ["google_drive", "google_drive.read", "google_drive.list_files"]) {
      await writeFile(join(home, "apps", "research_app", "matrix.json"), JSON.stringify({ name: "Research", integrations: { required: ["gmail.send_email"], optional: [ref] } }));
      expect((await refresh(app)).status).toBe(200);
    }
    for (const ref of ["google_drive.write", "google_drive.send", "google_drive.upload_file", "google_drive.read_file", "google_drive.list_files.extra"]) {
      await writeFile(join(home, "apps", "research_app", "matrix.json"), JSON.stringify({ name: "Research", integrations: { required: [ref] } }));
      transport.mockClear();
      expect((await refresh(app)).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
    }
  });
  it("denies symlinked manifests and returns503 for missing owner database/transport", async () => {
    const file = join(home, "apps", "research_app", "matrix.json");
    await rm(file); await writeFile(join(home, "outside.json"), JSON.stringify({ name: "Outside", integrations: { required: ["google_drive"] } }));
    await symlink(join(home, "outside.json"), file);
    const transport = vi.fn();
    expect((await refresh(await mount(transport))).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
    expect((await refresh(await mount(transport, null))).status).toBe(503);
    expect((await refresh(await mount(null))).status).toBe(503);
  });
});
