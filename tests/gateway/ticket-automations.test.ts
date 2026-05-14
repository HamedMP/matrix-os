import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { createTicketAutomationRoutes } from "../../packages/gateway/src/tickets/automation-routes.js";
import { KyselyTicketAutomationRepository } from "../../packages/gateway/src/tickets/automation-repository.js";

describe("Ticket automation routes", () => {
  it("validates automation rules and keeps execution scoped to cloud runtime", async () => {
    const repository = { saveRule: vi.fn(async (rule) => ({ ...rule, id: "automation_1", enabled: true })) };
    const app = new Hono();
    app.route("/api/projects", createTicketAutomationRoutes({
      repository,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    }));

    const res = await app.request("/api/projects/repo/tickets/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ready to Symphony",
        trigger: { type: "ticket.status.changed", statuses: ["Ready"] },
        action: { type: "assign_to_symphony", runtimeMode: "cloud" },
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ automation: { id: "automation_1", action: { runtimeMode: "cloud" } } });
    expect(repository.saveRule).toHaveBeenCalledWith(expect.objectContaining({ projectSlug: "repo", ownerId: "user_123" }));
  });

  it("returns generic errors and logs when automation persistence fails", async () => {
    const repository = { saveRule: vi.fn(async () => { throw new Error("postgres://secret@example.test/path"); }) };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new Hono();
    app.route("/api/projects", createTicketAutomationRoutes({
      repository,
      getPrincipal: () => ({ userId: "user_123", source: "dev-default" }),
    }));

    const res = await app.request("/api/projects/repo/tickets/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ready to Symphony",
        trigger: { type: "ticket.status.changed", statuses: ["Ready"] },
        action: { type: "assign_to_symphony", runtimeMode: "cloud" },
      }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: { code: "automation_save_failed", message: "Ticket automation could not be saved" } });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("Ticket automation repository", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<any>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = new Kysely<any>({ dialect: instance.dialect });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("persists automation rules across repository instances and caps project scope", async () => {
    const first = new KyselyTicketAutomationRepository(db, 1);
    await first.bootstrap();
    await first.saveRule({
      ownerId: "user_123",
      projectSlug: "repo",
      name: "First",
      trigger: { type: "ticket.status.changed", statuses: ["Ready"] },
      action: { type: "assign_to_symphony", runtimeMode: "cloud" },
    });
    await first.saveRule({
      ownerId: "user_123",
      projectSlug: "repo",
      name: "Second",
      trigger: { type: "ticket.status.changed", statuses: ["In Progress"] },
      action: { type: "assign_to_symphony", runtimeMode: "cloud" },
    });

    const restarted = new KyselyTicketAutomationRepository(db, 1);
    await restarted.bootstrap();
    await expect(restarted.listRules("user_123", "repo")).resolves.toMatchObject([
      { name: "Second", ownerId: "user_123", projectSlug: "repo", enabled: true },
    ]);
  });
});
