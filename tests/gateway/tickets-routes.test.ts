import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { KyselyTicketRepository } from "../../packages/gateway/src/tickets/internal-repository.js";
import { createTicketRoutes } from "../../packages/gateway/src/tickets/routes.js";

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://local.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Ticket routes", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<any>;
  let repository: KyselyTicketRepository;
  let app: Hono;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = new Kysely<any>({ dialect: instance.dialect });
    repository = new KyselyTicketRepository(db, () => "2026-05-14T18:00:00.000Z");
    await repository.bootstrap();
    app = new Hono();
    app.route("/api/projects", createTicketRoutes({
      repository,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    }));
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates, lists, and protects Matrix-native tickets with route-boundary validation", async () => {
    const create = await app.request(jsonRequest("/api/projects/repo/tickets", "POST", {
      title: "Add cloud preview panel",
      description: "Show preview URL in task workbench",
      status: "Todo",
      priority: "medium",
      assigneeIds: [],
      labelIds: ["desktop"],
    }));
    expect(create.status).toBe(201);
    const created = await create.json() as { ticket: { id: string; revision: number; sourceKind: string } };
    expect(created.ticket).toMatchObject({ sourceKind: "matrix", revision: 1 });

    const list = await app.request("/api/projects/repo/tickets?source=matrix&limit=20");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      tickets: [expect.objectContaining({ id: created.ticket.id, sourceKind: "matrix" })],
      nextCursor: null,
    });

    const update = await app.request(jsonRequest(`/api/projects/repo/tickets/${created.ticket.id}`, "PATCH", {
      baseRevision: 1,
      patch: { status: "In Progress" },
    }));
    expect(update.status).toBe(200);

    const stale = await app.request(jsonRequest(`/api/projects/repo/tickets/${created.ticket.id}`, "PATCH", {
      baseRevision: 1,
      patch: { status: "Done" },
    }));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: "revision_conflict" } });

    const invalid = await app.request(jsonRequest("/api/projects/-bad/tickets", "POST", { title: "Bad" }));
    expect(invalid.status).toBe(400);
  });
});
