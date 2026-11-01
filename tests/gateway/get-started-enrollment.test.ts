import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { registerSettingsRoutes } from "../../packages/gateway/src/server/settings-routes.js";

const owner = { type: "personal" as const, ownerId: "owner_enrollment" };
const input = {
  clientRequestId: "req_enrollment_agent", name: "Research helper", description: "Research",
  instructions: "Help the owner research.", selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
};
const endpoint = "/api/settings/get-started";

describe("Get started enrollment through registered settings routes", () => {
  let homePath: string;
  let db: Kysely<ChatDatabase>;
  let agents: ChatAgentStore;
  let statePath: string;

  function mount({ enabled = true, userId = owner.ownerId as string | null, runtimeSlot = "primary", available = true } = {}) {
    const app = new Hono();
    registerSettingsRoutes({
      app, homePath, settingsRoutes: new Hono(), getStartedEnabled: enabled,
      getOwnerId: () => userId, botServices: null, osViewState: null,
      getStartedEnrollment: { agents: available ? agents : null, ownerId: owner.ownerId, runtimeSlot },
    });
    return app;
  }

  async function put(app: Hono, value: unknown) {
    return app.request(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  }

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-get-started-enrollment-"));
    await mkdir(join(homePath, "system"));
    statePath = join(homePath, "system/get-started.json");
    db = new Kysely({ dialect: (await KyselyPGlite.create()).dialect });
    agents = new ChatAgentStore({ homePath, db });
    await agents.bootstrap();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await agents.close();
    await db.destroy();
    await rm(homePath, { recursive: true, force: true });
  });

  it("offers an existing zero-agent owner setup and persists one shared record across requests", async () => {
    await writeFile(join(homePath, "system/onboarding-complete.json"), '{"source":"legacy"}');
    const responses = await Promise.all(Array.from({ length: 6 }, () => mount().request(endpoint)));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "pending" });
    }
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ version: 1, status: "pending" });
    expect((await readdir(join(homePath, "system"))).sort()).toEqual(["get-started.json", "onboarding-complete.json"]);
  });

  it("does not enroll an owner with an active Matrix agent", async () => {
    await agents.create(owner, input);
    expect(await (await mount().request(endpoint)).json()).toEqual({ status: "not_eligible" });
    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("counts only this owner's active agents, allowing an archived-only inventory", async () => {
    const agent = await agents.create(owner, input);
    await agents.update(owner, agent.id, { baseRevision: agent.revision, archived: true });
    await agents.create({ type: "personal", ownerId: "owner_elsewhere" }, input);
    expect(await (await mount().request(endpoint)).json()).toEqual({ status: "pending" });
  });

  it.each(["complete", "skip"] as const)("never offers setup again after %s, even after the last agent is archived and the gateway restarts", async (type) => {
    const app = mount();
    expect((await app.request(endpoint)).status).toBe(200);
    expect((await put(app, type === "complete" ? { type, answers: { name: "Sam", goals: ["code"] } } : { type })).status).toBe(200);
    const saved = await readFile(statePath, "utf8");
    const agent = await agents.create(owner, input);
    await agents.update(owner, agent.id, { baseRevision: agent.revision, archived: true });
    expect((await (await mount().request(endpoint)).json()).status).toBe(type === "complete" ? "completed" : "skipped");
    expect(await readFile(statePath, "utf8")).toBe(saved);
  });

  it("keeps a saved draft when an agent was created partway through setup", async () => {
    const app = mount();
    await app.request(endpoint);
    expect((await put(app, { type: "draft", draft: { step: 2, name: "Sam" } })).status).toBe(200);
    await agents.create(owner, input);
    expect(await (await mount().request(endpoint)).json()).toMatchObject({ status: "in_progress", draft: { step: 2, name: "Sam" } });
  });

  it.each([
    { enabled: false }, { userId: null }, { userId: "another_owner" }, { runtimeSlot: "secondary" },
  ])("does not create a setup record outside the enabled primary owner scope: %j", async (options) => {
    expect(await (await mount(options).request(endpoint)).json()).toEqual({ status: "not_eligible" });
    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reseed a missing state file when the wizard's completion receipt survives", async () => {
    await writeFile(join(homePath, "system/onboarding-complete.json"), '{"source":"get-started","completedAt":"2026-10-29T10:00:00.000Z"}');
    expect(await (await mount().request(endpoint)).json()).toEqual({ status: "not_eligible" });
    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["unavailable", "read failure"])("fails closed when the agent inventory is %s", async (failure) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (failure === "read failure") vi.spyOn(agents, "list").mockRejectedValue(new Error("private filesystem failure"));
    const response = await mount({ available: failure !== "unavailable" }).request(endpoint);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.json()).toEqual({ error: "Unable to load your setup" });
    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite corrupt state or follow a symlink during enrollment", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(statePath, "broken state");
    expect((await mount().request(endpoint)).status).toBe(500);
    expect(await readFile(statePath, "utf8")).toBe("broken state");
    await rm(statePath);
    const target = join(homePath, "private.json");
    await writeFile(target, '{"version":1,"status":"pending"}');
    await symlink(target, statePath);
    expect((await mount().request(endpoint)).status).toBe(500);
    expect(await readFile(target, "utf8")).toBe('{"version":1,"status":"pending"}');
  });
});
