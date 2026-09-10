import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { ChatAgentContext } from "../../packages/gateway/src/chat/agent-context.js";
import { createChatAgentRoutes } from "../../packages/gateway/src/chat/agent-routes.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

const owner = { type: "personal" as const, ownerId: "owner_agent_routes" };
const fields = {
  clientRequestId: "req_route_agent", name: "Meeting helper", description: "Prepare a meeting",
  instructions: "Summarize decisions and questions.", selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
};

describe("Chat Agent HTTP boundary", () => {
  let repository: ChatRepository;
  let agents: ChatAgentStore;
  let home: string;
  let enabled: boolean;
  let user: string | null;
  let app: ReturnType<typeof createChatAgentRoutes>;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-agent-routes-"));
    repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    await repository.bootstrap();
    agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
    await agents.bootstrap();
    enabled = true; user = owner.ownerId;
    const catalog = createCanonicalProviderCatalogFixture();
    catalog.drivers.push({ ...catalog.drivers[0]!, kind: "hermes", displayName: "Hermes" });
    catalog.instances.push({ ...catalog.instances[0]!, id: "hermes_default", driverKind: "hermes",
      models: [{ ...catalog.instances[0]!.models[0]!, id: fields.selection.model }],
      supports: { ...catalog.instances[0]!.supports, permissionModes: ["full_access"] },
    });
    app = createChatAgentRoutes({ agents, repository,
      context: new ChatAgentContext({ repository, agents, enabled: () => enabled }),
      catalog: { getCatalog: async () => catalog }, enabled: () => enabled,
      getPrincipal: () => { if (!user) throw new MissingRequestPrincipalError(); return { userId: user, source: "jwt" }; },
    });
  });
  afterEach(async () => {
    await agents.close(); await repository.kysely.destroy(); await rm(home, { recursive: true, force: true });
  });
  const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("defaults to a quiet disabled feature and rejects mutations when switched off", async () => {
    enabled = false;
    expect(await (await app.request("/api/chat-agents")).json()).toEqual({ enabled: false, agents: [] });
    expect(await (await app.request("/api/chat-mentions")).json()).toEqual({ enabled: false, resources: [] });
    expect((await app.request("/api/chat-agents", json("POST", fields))).status).toBe(409);
    expect(await agents.list(owner)).toEqual([]);
  });

  it("creates and edits a durable Hermes role using the authenticated owner only", async () => {
    const created = await app.request("/api/chat-agents", json("POST", fields));
    expect(created.status).toBe(201);
    const agent = await created.json();
    const duplicate = await (await app.request("/api/chat-agents", json("POST", fields))).json();
    expect(duplicate.id).toBe(agent.id);
    const updated = await app.request(`/api/chat-agents/${agent.id}`, json("PATCH", { baseRevision: agent.revision, name: "Partner helper" }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).name).toBe("Partner helper");
    expect((await app.request(`/api/chat-agents/${agent.id}`, json("PATCH", { baseRevision: 1, archived: true }))).status).toBe(409);
    user = "someone_else";
    expect(await (await app.request("/api/chat-agents")).json()).toEqual({ enabled: true, agents: [] });
    expect((await app.request(`/api/chat-agents/${agent.id}`, json("PATCH", { baseRevision: 2, archived: true }))).status).toBe(404);
  });

  it("rejects missing identity, forged owner/context, oversized bodies, and non-Hermes selections", async () => {
    user = null;
    expect((await app.request("/api/chat-agents")).status).toBe(401);
    user = owner.ownerId;
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, owner: { ownerId: "someone_else" } }))).status).toBe(400);
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" } }))).status).toBe(400);
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, instructions: "x".repeat(70_000) }))).status).toBe(413);
    expect((await app.request("/api/chat-mentions?query=" + "x".repeat(201))).status).toBe(400);
    expect(await agents.list(owner)).toEqual([]);
  });

  it("searches only owned active Chat titles and Agent names, excluding the current Chat", async () => {
    await agents.create(owner, fields);
    await repository.create(owner, { id: "chat_current", clientRequestId: "req_current", title: "Meeting current" });
    await repository.create(owner, { id: "chat_source", clientRequestId: "req_source", title: "Meeting notes" });
    await repository.create({ ...owner, ownerId: "another_owner" }, { id: "chat_private", clientRequestId: "req_private", title: "Meeting private" });
    const response = await app.request("/api/chat-mentions?query=meeting&chatId=chat_current");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.resources.map((resource: { kind: string }) => resource.kind)).toEqual(["agent", "chat"]);
    expect(result.resources.map((resource: { label: string }) => resource.label)).toEqual(["Meeting helper", "Meeting notes"]);
    expect((await app.request("/api/chat-context/chat_private")).status).toBe(404);
    expect((await app.request("/api/chat-context/chat_source")).status).toBe(200);
  });

  it("returns a coarse service error if configured without database-backed services", async () => {
    const unavailable = createChatAgentRoutes({ enabled: () => true,
      getPrincipal: () => ({ userId: owner.ownerId, source: "jwt" }),
      catalog: { getCatalog: async () => { throw new Error("private db path"); } },
    });
    const response = await unavailable.request("/api/chat-agents");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private db path");
  });
});
