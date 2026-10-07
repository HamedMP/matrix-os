import { managedPiChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KyselyPGlite } from "kysely-pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createIntegrationsMcpServer } from "../../packages/integrations-mcp/src/server.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { ChatAgentContext } from "../../packages/gateway/src/chat/agent-context.js";
import { issueHermesIntegrationCapability, resolveHermesIntegrationCapability } from "../../packages/gateway/src/chat/hermes-integration-capability.js";
import { createChatAgentRoutes } from "../../packages/gateway/src/chat/agent-routes.js";
import { createChatAgentRecipeResolver } from "../../packages/gateway/src/chat/agent-recipe.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
import { ChatRunContextSchema } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

const owner = { type: "personal" as const, ownerId: "owner_agent_routes" };
const fields = {
  clientRequestId: "req_route_agent", name: "Meeting helper", description: "Prepare a meeting",
  instructions: "Summarize decisions and questions.", selection: { instanceId: "hermes_default", model: "openai-api:gpt-5.6-sol" },
};

describe("Chat Agent HTTP boundary", () => {
  let repository: ChatRepository;
  let agents: ChatAgentStore;
  let home: string;
  let enabled: boolean;
  let user: string | null;
  let catalog: ReturnType<typeof createCanonicalProviderCatalogFixture>;
  let app: ReturnType<typeof createChatAgentRoutes>;
  let agentContext: ChatAgentContext;
  let recipes: ReturnType<typeof createChatAgentRecipeResolver>;
  let gmailAccounts: Array<{ id: string; user_id: string; service: "gmail"; account_label: string;
    account_email: string | null; status: "active" | "revoked" }>;
  let gmailLookup: (ownerId: string) => Promise<typeof gmailAccounts>;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "matrix-agent-routes-"));
    repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    await repository.bootstrap();
    agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
    await agents.bootstrap();
    const skillsRoot = join(home, "skills/matrix");
    for (const [directory, id] of [["integrations", "matrix-integrations"], ["personal-daily-brief", "matrix-personal-daily-brief"],
      ["jev-email-triage", "matrix-jev-email-triage"]]) {
      await mkdir(join(skillsRoot, directory), { recursive: true });
      await writeFile(join(skillsRoot, directory, "SKILL.md"),
        `---\nname: ${id}\ndescription: ${id === "matrix-integrations" ? "Use Matrix integrations safely."
          : id === "matrix-jev-email-triage" ? "Review Gmail with Jev." : "Prepare a personal daily brief."}\nauthor: Matrix OS\n---\nInstructions for ${id}.\n`);
    }
    recipes = createChatAgentRecipeResolver({
      skillsRoot,
      services: [{ id: "gmail", name: "Gmail" }, { id: "google_calendar", name: "Google Calendar" }],
    });
    enabled = true; user = owner.ownerId;
    gmailAccounts = [{ id: "conn_mine", user_id: owner.ownerId, service: "gmail", account_label: "My Gmail",
      account_email: "me@example.test", status: "active" }];
    gmailLookup = async (ownerId) => gmailAccounts.filter((row) => row.user_id === ownerId);
    catalog = createCanonicalProviderCatalogFixture();
    catalog.drivers.push({ ...catalog.drivers[0]!, kind: "hermes", displayName: "Hermes" });
    catalog.instances.push({ ...catalog.instances[0]!, id: "hermes_default", driverKind: "hermes",
      defaultSelection: fields.selection,
      models: [{ ...catalog.instances[0]!.models[0]!, id: fields.selection.model }],
      supports: { ...catalog.instances[0]!.supports, permissionModes: ["full_access"] },
    });
    agentContext = new ChatAgentContext({ repository, agents, recipes, enabled: () => enabled });
    app = createChatAgentRoutes({ agents, repository,
      context: agentContext, recipes,
      catalog: { getCatalog: async () => catalog }, enabled: () => enabled,
      getPrincipal: () => { if (!user) throw new MissingRequestPrincipalError(); return { userId: user, source: "jwt" }; },
      // The server must use its own owner-scoped connection lookup. The client
      // sends a label, never an account ID or expected email.
      listGmailAccounts: (ownerId) => gmailLookup(ownerId),
    });
  });
  afterEach(async () => {
    await agents.close(); await repository.kysely.destroy(); await rm(home, { recursive: true, force: true });
  });
  const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it.each(["matrix_pi_anthropic_api", "matrix_anthropic_api"])("rejects %s on generic Agent create and edit even when advertised", async instanceId => {
    const selection = { instanceId, model: "claude-owner", options: [{ id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" }] };
    catalog.instances.push({ ...catalog.instances[0]!, id: instanceId, driverKind: instanceId.startsWith("matrix_pi_") ? "matrix_pi" : "matrix_bot",
      models: [{ ...catalog.instances[0]!.models[0]!, id: selection.model }], defaultSelection: selection,
      options: selection.options.map(o => ({ id: o.id, label: o.id, kind: "enum", values: [{ value: o.value, label: "Current connection" }], defaultValue: o.value, placement: "advanced" })) });
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, selection }))).status).toBe(400);
    const created = await (await app.request("/api/chat-agents", json("POST", fields))).json();
    expect((await app.request(`/api/chat-agents/${created.id}`, json("PATCH", { baseRevision: created.revision, selection }))).status).toBe(400);
  });
  it("rejects owner-local subscription selection on generic Agent create and edit", async () => {
    const selection = { instanceId: "matrix_chatgpt_plan", model: "account-model", options: [
      { id: "accountId", value: "account_own" }, { id: "grantRevision", value: "3" },
    ] };
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, selection }))).status).toBe(400);
    const created = await (await app.request("/api/chat-agents", json("POST", fields))).json();
    expect((await app.request(`/api/chat-agents/${created.id}`, json("PATCH", { baseRevision: created.revision, selection }))).status).toBe(400);
  });
  it("rejects a Jev recipe on a Codex harness at create and selection-only edit", async () => {
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Read-only proposals" };
    const codex = catalog.instances.find(instance => instance.driverKind === "codex")!;
    const selection = { instanceId: codex.id, model: codex.models[0]!.id };
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, recipe, selection }))).status).toBe(400);
    const created = await (await app.request("/api/chat-agents", json("POST", { ...fields, recipe }))).json();
    expect((await app.request(`/api/chat-agents/${created.id}`, json("PATCH", { baseRevision: created.revision, selection }))).status).toBe(400);
  });

  it("cannot save an unsupported Jev selection while archiving or reactivate a legacy unsupported selection", async () => {
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Read-only proposals" };
    const created = await (await app.request("/api/chat-agents", json("POST", { ...fields, recipe }))).json();
    const codex = catalog.instances.find(instance => instance.driverKind === "codex")!;
    const selection = { instanceId: codex.id, model: codex.models[0]!.id };
    expect((await app.request(`/api/chat-agents/${created.id}`, json("PATCH", {
      baseRevision: created.revision, archived: true, selection,
    }))).status).toBe(400);
    // Simulate an archived record from before this boundary existed.
    const legacy = await agents.update(owner, created.id, { baseRevision: created.revision, archived: true, selection });
    expect((await app.request(`/api/chat-agents/${created.id}`, json("PATCH", {
      baseRevision: legacy.revision, archived: false,
    }))).status).toBe(400);
    expect((await agents.get(owner, created.id))?.archived).toBe(true);
    const repaired = await app.request(`/api/chat-agents/${created.id}`, json("PATCH", {
      baseRevision: legacy.revision, archived: false, selection: fields.selection,
    }));
    expect(repaired.status).toBe(200);
    expect((await repaired.json()).archived).toBe(false);
  });

  it("protects server-routed recipe bots from coding-model edits while allowing profile edits", async () => {
    const bot = await agents.createRecipeBot(owner, {
      id: "bot_writingroute", createHash: "a".repeat(64),
      fields: { name: "Writing Bot", description: "Write", instructions: "Help write", selection: fields.selection },
      recipeRef: { recipeId: "writing-bot", version: "1" },
    });
    const rejected = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", {
      baseRevision: bot.revision, selection: fields.selection,
    }));
    expect(rejected.status).toBe(400);
    expect((await agents.get(owner, bot.id))?.revision).toBe(bot.revision);
    const edited = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", {
      baseRevision: bot.revision, name: "My Writing Bot",
    }));
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ name: "My Writing Bot", recipeRef: bot.recipeRef });
  });

  it("requires the complete current Anthropic binding before saving a recipe Bot selection", async () => {
    const selection = { instanceId: "matrix_anthropic_api", model: "claude-owner", options: [
      { id: "connectionRevision", value: "3" }, { id: "credentialGeneration", value: "e16625fe-cad7-4983-a9db-e808bbf104cc" },
    ] };
    catalog.instances.push({ ...catalog.instances[0]!, id: selection.instanceId, driverKind: "matrix_bot",
      supports: { ...catalog.instances[0]!.supports, permissionModes: ["default"] },
      models: [{ ...catalog.instances[0]!.models[0]!, id: selection.model }], defaultSelection: selection,
      options: selection.options.map(o => ({ id: o.id, label: o.id, kind: "enum", values: [{ value: o.value, label: "Current connection" }], defaultValue: o.value, placement: "advanced" })) });
    const bot = await agents.createRecipeBot(owner, { id: "bot_anthropicedit", createHash: "e".repeat(64),
      fields: { name: "Writing Bot", description: "Write", instructions: "Write", selection: { instanceId: "matrix_bot_default", model: "auto" } },
      recipeRef: { recipeId: "writing-bot", version: "1" } });
    for (const options of [undefined, [], [selection.options[0]!], [selection.options[1]!],
      [{ ...selection.options[0]!, value: "2" }, selection.options[1]!],
      [selection.options[0]!, { ...selection.options[1]!, value: "cfbe8f56-2fbc-47d7-9769-489ac7d4a78f" }]]) {
      expect((await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, selection: { ...selection, options } }))).status).toBe(400);
      expect((await agents.get(owner, bot.id))?.revision).toBe(bot.revision);
    }
    const saved = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, selection }));
    expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ selection, revision: 2 });
  });

  it("saves a recipe bot managed model with revision checks and can restore Automatic", async () => {
    const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
    catalog.drivers.push({ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" });
    catalog.instances.push(...managedPiChatInstances(makeAiProviderSnapshot()).map((instance) => ({ ...instance, catalogRevision: catalog.revision })));
    const bot = await agents.createRecipeBot(owner, { id: "bot_managededit", createHash: "c".repeat(64),
      fields: { name: "Writing Bot", description: "Write", instructions: "Help write", selection: { instanceId: "matrix_bot_default", model: "auto" } },
      recipeRef: { recipeId: "writing-bot", version: "1" } });
    const response = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, selection }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ selection, revision: 2, description: "Write" });
    expect((await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, selection }))).status).toBe(409);
    const automatic = { instanceId: "matrix_bot_default", model: "auto" };
    const restored = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: 2, selection: automatic }));
    expect(restored.status).toBe(200); expect(await restored.json()).toMatchObject({ selection: automatic, revision: 3 });
  });

  it("stamps owner, exact label, connection ID and expected email on Jev creation", async () => {
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Review proposed labels" };
    const request = { ...fields, clientRequestId: "req_jev_authority", name: "Jev Inbox Triage", recipe };
    const created = await app.request("/api/chat-agents", json("POST", request));
    expect(created.status).toBe(201);
    const agent = await created.json();
    expect(agent.recipe?.jevInboxTriage).toEqual({ version: 1, ownerId: owner.ownerId, service: "gmail",
      accountLabel: "My Gmail", connectionId: "conn_mine", expectedEmail: "me@example.test" });
    const saved = await agents.get(owner, agent.id);
    expect(saved?.recipe).toEqual(agent.recipe);
    // A successful create may be followed by a failed library readback. Its
    // idempotent retry must return the saved bot even if inventory changed.
    gmailAccounts = [];
    const retried = await app.request("/api/chat-agents", json("POST", request));
    expect(retried.status).toBe(201);
    expect((await retried.json()).id).toBe(agent.id);
    expect(await agents.list(owner)).toHaveLength(1);
    expect((await app.request("/api/chat-agents", json("POST", { ...request, name: "Different bot" }))).status).toBe(409);
  });

  it("keeps owner file writes unblocked while the Platform inventory is pending", async () => {
    let releaseLookup!: () => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const pending = new Promise<void>((resolve) => { releaseLookup = resolve; });
    gmailLookup = async () => { lookupStarted(); await pending; return gmailAccounts; };
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Review proposals" };
    const createSpy = vi.spyOn(agents, "create");
    const jev = app.request("/api/chat-agents", json("POST", { ...fields,
      clientRequestId: "req_jev_pending_lookup", recipe }));
    await started;
    expect(createSpy).not.toHaveBeenCalled();
    try {
      const ordinary = app.request("/api/chat-agents", json("POST", { ...fields,
        clientRequestId: "req_ordinary_while_lookup" }));
      const first = await Promise.race([ordinary.then((response) => response.status),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 1_000))]);
      expect(first).toBe(201);
    } finally { releaseLookup(); }
    expect((await jev).status).toBe(201);
    expect(await agents.list(owner)).toHaveLength(2);
  });

  it.each(["missing", "duplicate", "foreign", "email-less", "revoked"] as const)(
    "fails Jev creation closed for a %s selected account", async (caseName) => {
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Review proposed labels" };
    const selected = gmailAccounts[0]!;
    gmailAccounts = caseName === "missing" ? []
      : caseName === "duplicate" ? [selected, { ...selected, id: "conn_duplicate" }]
      : caseName === "foreign" ? [{ ...selected, user_id: "another_owner" }]
      : caseName === "email-less" ? [{ ...selected, account_email: null }]
      : [{ ...selected, status: "revoked" }];
    const response = await app.request("/api/chat-agents", json("POST", { ...fields, clientRequestId: `req_jev_${caseName}`, recipe }));
    expect(response.status).toBe(409);
    expect(await agents.list(owner)).toEqual([]);
  });

  it("rejects client-forged Jev owner, connection ID and expected email on create and PATCH", async () => {
    const forged = { version: 1, ownerId: "another_owner", service: "gmail", accountLabel: "My Gmail",
      connectionId: "conn_foreign", expectedEmail: "attacker@example.test" };
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Review proposed labels",
      jevInboxTriage: forged };
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, recipe }))).status).toBe(400);
    const created = await (await app.request("/api/chat-agents", json("POST", fields))).json();
    expect((await app.request(`/api/chat-agents/${created.id}`, json("PATCH", { baseRevision: 1, recipe }))).status).toBe(400);
    expect((await agents.get(owner, created.id))?.revision).toBe(1);
  });

  it("rebinds a Jev account with a revision change and invalidates the prior run context", async () => {
    const recipe = { skills: ["matrix-jev-email-triage", "matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "My Gmail" }], output: "Review proposed labels" };
    const created = await (await app.request("/api/chat-agents", json("POST", {
      ...fields, clientRequestId: "req_jev_rebind", recipe,
    }))).json();
    await repository.create(owner, { id: "chat_jev_rebind", clientRequestId: "req_chat_jev_rebind", title: "Jev review" });
    const oldContext = ChatRunContextSchema.parse({ version: 1, requestHash: "a".repeat(64), chats: [],
      agent: { id: created.id, revision: 1, name: created.name, instructions: created.instructions,
        recipe: await recipes.resolve(created.recipe) } });
    const capability = issueHermesIntegrationCapability(owner.ownerId, { kind: "jev_inbox_preview", runId: "run_jev_rebind",
      agentId: created.id, revision: 1, account: { service: "gmail", accountLabel: "My Gmail",
        connectionId: "conn_mine", expectedEmail: "me@example.test" } });
    try {
      gmailAccounts.push({ id: "conn_work", user_id: owner.ownerId, service: "gmail", account_label: "Work",
        account_email: "work@example.test", status: "active" });
      const updated = await app.request(`/api/chat-agents/${created.id}`, json("PATCH", { baseRevision: 1,
        recipe: { ...recipe, integrations: [{ service: "gmail", accountLabel: "Work" }] },
      }));
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ revision: 2,
        recipe: { jevInboxTriage: { ownerId: owner.ownerId, accountLabel: "Work",
          connectionId: "conn_work", expectedEmail: "work@example.test" } } });
      await expect(agentContext.revalidate(owner, "chat_jev_rebind", oldContext)).rejects.toMatchObject({ code: "context_unavailable" });
      expect(resolveHermesIntegrationCapability(capability.token, "POST", "/api/jev/inbox/preview")).toBeNull();
    } finally { capability.revoke(); }
  });

  it("accepts recipe-only PATCH after the saved model becomes unavailable while rejecting a supplied unavailable selection", async () => {
    const created = await (await app.request("/api/chat-agents", json("POST", fields))).json();
    catalog.instances = catalog.instances.filter((instance) => instance.id !== fields.selection.instanceId);
    const recipe = { skills: ["matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Work" }], output: "Edited daily brief" };
    const updated = await app.request(`/api/chat-agents/${created.id}`, json("PATCH", { baseRevision: 1, recipe }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ selection: fields.selection, recipe });
    const rejected = await app.request(`/api/chat-agents/${created.id}`, json("PATCH", {
      baseRevision: 2, selection: fields.selection, description: "Changed selection must be ready",
    }));
    expect(rejected.status).toBe(400);
    expect((await agents.get(owner, created.id))?.revision).toBe(2);
  });

  it("hides the feature and rejects mutations when availability is disabled", async () => {
    enabled = false;
    expect(await (await app.request("/api/chat-agents")).json()).toEqual({ enabled: false, agents: [] });
    expect(await (await app.request("/api/chat-agents/recipe-catalog")).json()).toEqual({ enabled: false, skills: [], services: [] });
    expect(await (await app.request("/api/chat-mentions")).json()).toEqual({ enabled: false, resources: [] });
    expect((await app.request("/api/chat-agents", json("POST", fields))).status).toBe(409);
    expect(await agents.list(owner)).toEqual([]);
  });

  it("returns authenticated recipe metadata without instructions, accounts or credentials", async () => {
    const response = await app.request("/api/chat-agents/recipe-catalog");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({
      enabled: true,
      skills: [
        { id: "matrix-integrations", name: "Matrix Integrations", description: "Use Matrix integrations safely.", instructionBytes: 37 },
        { id: "matrix-jev-email-triage", name: "matrix-jev-email-triage", description: "Review Gmail with Jev.",
          instructionBytes: Buffer.byteLength("Instructions for matrix-jev-email-triage.") },
        { id: "matrix-personal-daily-brief", name: "Personal Daily Brief", description: "Prepare a personal daily brief.", instructionBytes: 45 },
      ],
      services: [{ id: "gmail", name: "Gmail" }, { id: "google_calendar", name: "Google Calendar" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/instructions|accounts|credential|token/i);
    user = null;
    expect((await app.request("/api/chat-agents/recipe-catalog")).status).toBe(401);
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

  it("creates an Agent using an available Codex model", async () => {
    const selection = { instanceId: "codex_fixture", model: "gpt-5.6-sol" };
    const result = await app.request("/api/chat-agents", json("POST", { ...fields, selection }));
    expect(result.status).toBe(201);
    expect((await result.json()).selection).toEqual(selection);
  });

  it("creates a custom Agent with an authorized Matrix model and rejects unavailable or private Bot routes", async () => {
    const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
    catalog.drivers.push({ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" });
    const instances = managedPiChatInstances(makeAiProviderSnapshot()).map(instance => ({ ...instance, catalogRevision: catalog.revision }));
    catalog.instances.push(...instances);
    const input = { ...fields, clientRequestId: "req_route_matrix_agent", selection };
    const response = await app.request("/api/chat-agents", json("POST", input));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ selection, name: fields.name });
    expect((await agents.get(owner, created.id))?.selection).toEqual(selection);
    const instance = catalog.instances.find(candidate => candidate.id === selection.instanceId)!;
    instance.availability = "unavailable";
    instance.defaultSelection = undefined;
    expect((await app.request("/api/chat-agents", json("POST", input))).status).toBe(201);
    expect((await app.request("/api/chat-agents", json("POST", { ...input, clientRequestId: "req_route_matrix_blocked" }))).status).toBe(400);
    expect((await app.request("/api/chat-agents", json("POST", { ...input, clientRequestId: "req_route_private_bot", selection: { instanceId: "matrix_bot_default", model: "auto" } }))).status).toBe(400);
    expect(await agents.list(owner)).toHaveLength(1);
  });

  it("persists conversational MCP creation through the real route and makes retries idempotent", async () => {
    const server = createIntegrationsMcpServer({ fetcher: async (url, init) => app.request(new URL(url).pathname, init) });
    const client = new Client({ name: "agent-creation-route-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(right), client.connect(left)]);
    try {
      const input = { ...fields, selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" } };
      const first = await client.callTool({ name: "create_chat_agent", arguments: input });
      const retry = await client.callTool({ name: "create_chat_agent", arguments: input });
      expect(first.isError).not.toBe(true);
      expect(retry).toEqual(first);
      const listed = await agents.list(owner);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ name: fields.name, instructions: fields.instructions, selection: input.selection });
      user = "another_owner";
      expect(await (await app.request("/api/chat-agents")).json()).toEqual({ enabled: true, agents: [] });
    } finally { await client.close(); await server.close(); }
  });

  it("rejects missing identity, forged owner/context, oversized bodies, and unavailable selections", async () => {
    user = null;
    expect((await app.request("/api/chat-agents")).status).toBe(401);
    user = owner.ownerId;
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, owner: { ownerId: "someone_else" } }))).status).toBe(400);
    expect((await app.request("/api/chat-agents", json("POST", { ...fields, selection: { instanceId: "unavailable_instance", model: "gpt-5.6-sol" } }))).status).toBe(400);
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

  it("keeps valid Chats searchable when their titles are unsafe resource labels", async () => {
    await repository.create(owner, { id: "chat_path_title", clientRequestId: "req_path_title", title: "Debug /tmp/cache" });
    await repository.create(owner, { id: "chat_safe_title", clientRequestId: "req_safe_title", title: "Debug cache" });
    const response = await app.request("/api/chat-mentions?query=Debug");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.resources).toEqual(expect.arrayContaining([
      { kind: "chat", id: "chat_path_title", label: "Chat" },
      { kind: "chat", id: "chat_safe_title", label: "Debug cache" },
    ]));
    expect(JSON.stringify(result)).not.toContain("/tmp/");
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
