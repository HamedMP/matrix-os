import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Kysely, sql } from "kysely";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPGlite } from "../helpers/pglite-test-helper";
import { registerOwnerImports } from "../../packages/gateway/src/startup/owner-imports";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal";
import type { Dispatcher } from "../../packages/gateway/src/dispatcher";

it("wires accepted app requests through the background worker to verified rows in the actual owner schema", async () => {
  const db = new Kysely<any>({ dialect: (await createTestPGlite()).dialect });
  const home = await mkdtemp(join(tmpdir(), "gallery-sync-runtime-"));
  let runtime: Awaited<ReturnType<typeof registerOwnerImports>> | undefined;
  try {
    await mkdir(join(home, "apps/people/src"), { recursive: true });
    await writeFile(join(home, "apps/people/matrix.json"), JSON.stringify({ name: "People", slug: "people", runtime: "vite", version: "1.0.0", runtimeVersion: "^24.0.0", build: { command: "pnpm exec vite build", output: "dist" } }));
    await sql`CREATE SCHEMA people`.execute(db);
    await sql`CREATE TABLE people.records (id UUID PRIMARY KEY, payload JSONB, source_id TEXT, created_at TIMESTAMPTZ DEFAULT now())`.execute(db);
    const app = new Hono();
    app.use("*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, "owner"); await next(); });
    const dispatch = vi.fn<Dispatcher["dispatch"]>(async (message, _session, event) => {
      const runId = /include importRunId: "([0-9a-f-]+)"/.exec(message)?.[1];
      expect(runId).toBeTruthy();
      await event({ type: "init", sessionId: "fixture-run" });
      await sql`INSERT INTO people.records (id, payload, source_id) VALUES (${crypto.randomUUID()}, ${JSON.stringify({ id: crypto.randomUUID(), importRunId: runId, fields: { title: "Fixture person" }, scope: "work", manualFields: [], sources: [] })}::jsonb, 'gmail:Work:fixture-person')`.execute(db);
      await event({ type: "result", data: { sessionId: "fixture-run", cost: 0, turns: 1, tokensIn: 0, tokensOut: 0, result: '{"galleryImport":"complete","skipped":0}' } });
    });
    runtime = await registerOwnerImports(app, { ownerDatabase: db, homePath: home, runtimeOwnerIds: ["owner"], dispatcher: { dispatch } as unknown as Dispatcher,
      transport: async (_owner, request) => Response.json(request.method === "GET" ? [{ id: "gmail_work", service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active" }]
        : { data: { emailAddress: "work@example.test", historyId: "100" } }),
    });
    const response = await app.request("/api/app-gallery/people/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), accounts: [{ service: "gmail", label: "Work", connectionId: "gmail_work", expectedEmail: "work@example.test" }], start: "2026-10-01", end: "2026-10-19", context: "", scope: "work", keepUpdated: true }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued" });
    await vi.waitFor(async () => {
      const state = await (await app.request("/api/app-gallery/people/sync")).json();
      expect(state).toMatchObject({ status: "complete", added: 1, updated: 0 });
    }, { timeout: 8000, interval: 100 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await runtime?.close(); await db.destroy(); await rm(home, { recursive: true, force: true }); }
}, 15000);
