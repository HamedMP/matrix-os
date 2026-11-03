import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateManagedCustomBotRequestSchema, InstantiateBotResponseSchema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createChatAgentRecipeResolver } from "../../../packages/gateway/src/chat/agent-recipe.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { createBotCreationSelectionValidator } from "../../../packages/gateway/src/bots/creation-selection.js";
import { createBotProcedureResolver } from "../../../packages/gateway/src/bots/custom-procedure.js";
import { createBotInstantiation, ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const model = "@cf/zai-org/glm-5.3-flash";
const selection = { instanceId: "matrix_pi_default", model };
const input = { clientRequestId: "req_funded_custom", name: "Github helper", instructions: "Only confirmed work", selection };
const recipe = { skills: ["matrix-review"], integrations: [{ service: "github", accountLabel: "Work" }], output: "A verified review" };
let state: Awaited<ReturnType<typeof createBotStateDatabase>>;
let home: string;
let agents: ChatAgentStore;
let chats: ChatRepository;
let service: ReturnType<typeof createBotInstantiation>;
let procedures: ReturnType<typeof createBotProcedureResolver>;
let snapshot: AiProviderSnapshotV3;

beforeEach(async () => {
  state = await createBotStateDatabase();
  home = await mkdtemp(join(tmpdir(), "matrix-funded-custom-"));
  chats = new ChatRepository(state.db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: chats.kysely });
  await agents.bootstrap();
  const skillsRoot = join(home, "skills");
  await mkdir(join(skillsRoot, "review"), { recursive: true });
  await writeFile(join(skillsRoot, "review/SKILL.md"), "---\nname: matrix-review\ndescription: Review safely\nauthor: Matrix OS\n---\nInspect the evidence before drawing conclusions.\n");
  const customRecipes = createChatAgentRecipeResolver({ skillsRoot, services: [{ id: "github", name: "Github" }] });
  const recipes = createBotRecipeCatalog();
  snapshot = makeAiProviderSnapshot();
  snapshot.accessSources = [{ ...snapshot.accessSources[0]!, id: "matrix_cloudflare", vendor: "cloudflare", eligibleModelIds: [model] }];
  snapshot.models = [{ ...snapshot.models[0]!, id: model, vendor: "cloudflare", displayName: "GLM Flash", eligibleAccessSourceIds: ["matrix_cloudflare"] }];
  snapshot.instances = [];
  service = createBotInstantiation({ db: state.db, agents, chats, recipes, customRecipes,
    validateSelection: createBotCreationSelectionValidator({ available: () => true, providers: { getSnapshot: async () => snapshot } }),
    ensureWorkspace: id => ensureBotWorkspace(home, id) });
  procedures = createBotProcedureResolver({ db: state.db, agents, recipes, customRecipes });
});
afterEach(async () => { await agents.close(); await state.destroy(); await rm(home, { recursive: true, force: true }); });

it.each([false, true])("creates a funded custom Bot with recipe=%s and admits its direct turn through the Bot coordinator", async withRecipe => {
  const request = { ...input, ...(withRecipe ? { recipe } : {}) };
  const routes = createBotRoutes({ instantiation: service, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
  const response = await routes.request("/api/chat-agents/managed-custom", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  });
  expect(response.status).toBe(201);
  const created = InstantiateBotResponseSchema.parse(await response.json());
  const replayed = await service.createCustom(OWNER, request);
  expect(replayed).toEqual({ ...created, operation: "replayed" });
  const agent = (await agents.get(owner, created.agent.id))!;
  expect(agent).toMatchObject({ selection, recipeRef: { recipeId: "custom-coordinator", version: "1" } });
  expect(await agents.count(owner)).toBe(1);
  expect((await chats.get(owner, created.chatId))?.chat.currentSelection).toEqual(selection);
  const procedure = await procedures.resolve(OWNER, agent);
  expect(procedure.instructions).toContain("Only confirmed work");
  if (withRecipe) {
    expect(agent.recipe).toEqual(recipe);
    expect(procedure.instructions).toContain("Inspect the evidence before drawing conclusions.");
    expect(procedure.instructions).toContain('account "Work"');
    expect(procedure.output).toBe("A verified review");
  }
  const resolved = resolveManagedPiRoute(snapshot, agent.selection);
  const binding = { ownerId: OWNER, botId: agent.id, chatId: created.chatId,
    managedDefinitionRevision: agent.revision, ...resolved } as BotRuntimeBinding;
  await expect(procedures.revalidate(binding)).resolves.toBeUndefined();
  await expect(procedures.revalidate({ ...binding, ownerId: "other-owner" })).rejects.toMatchObject({ code: "model_unavailable" });
  await expect(procedures.revalidate({ ...binding, accessSourceId: "owner_anthropic_key" })).rejects.toMatchObject({ code: "model_unavailable" });

  // Real creation, binding, AgentContext and canonical admission must choose the
  // Bot adapter. The ordinary Pi adapter cannot admit this bound conversation.
  const started: string[] = [];
  const bot: CanonicalChatProviderAdapter = {
    driverKind: "matrix_bot", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async *start() { started.push("matrix_bot"); yield { type: "run.completed", outcome: "completed" }; },
  };
  const orchestrator = new CanonicalChatOrchestrator({ repository: chats,
    catalog: withBotProviderInstance({ getCatalog: async () => ({ revision: "funded", drivers: [],
      instances: managedPiChatInstances(snapshot).map(instance => ({ ...instance, catalogRevision: "funded" })) }) }),
    adapters: new CanonicalChatProviderRegistry([bot]),
    agentContext: new ChatAgentContext({ agents, repository: chats, enabled: () => true,
      botChats: { assertManagedCustom: (scope, agent, chatId) => procedures.assert(scope.ownerId, agent, chatId),
        directBot: async (scope, chatId) => (await createBotBindingsRepository(state.db).forChat({ ownerId: scope.ownerId, chatId }))
          .find(binding => binding.kind === "direct")?.botId ?? null } }),
  });
  try {
    const admitted = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, created.chatId, {
      clientRequestId: "req_funded_turn", baseRevision: (await chats.get(owner, created.chatId))!.chat.revision,
      parts: [{ type: "text", text: "Review the changes" }], selection,
      interactionMode: "default", permissionMode: "default",
    });
    expect(admitted.run).toMatchObject({ driverKind: "matrix_bot", instanceId: "matrix_bot_default",
      selection: { instanceId: "matrix_bot_default", model }, permissionMode: "default" });
    await vi.waitFor(() => expect(started).toEqual(["matrix_bot"]));
  } finally { await orchestrator.drain(); await orchestrator.close(); }
});

async function expectEmptyCreation() {
  expect(await agents.count(owner)).toBe(0);
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
  expect(await state.db.selectFrom("bot_chat_bindings").selectAll().execute()).toHaveLength(0);
  expect(await state.db.selectFrom("chats").selectAll().execute()).toHaveLength(0);
}

it.each(["disabled", "stale", "missing-model", "owner-key-only"])("refuses %s funded authority before reservation without fallback", async unavailable => {
  if (unavailable === "disabled") snapshot.accessSources[0]!.state = "disabled";
  if (unavailable === "stale") snapshot.accessSources[0]!.staleAfter = "2000-01-01T00:00:00.000Z";
  if (unavailable === "missing-model") snapshot.models = [];
  if (unavailable === "owner-key-only") snapshot.accessSources[0]!.id = "owner_anthropic_key";
  await expect(service.createCustom(OWNER, input)).rejects.toMatchObject({ code: "invalid_request" });
  await expectEmptyCreation();
});

it("preserves funded prompt-budget and unsupported-skill refusal before writes", async () => {
  const oversized = { ...input, instructions: "漢".repeat(7500) };
  expect(CreateManagedCustomBotRequestSchema.safeParse(oversized).success).toBe(true);
  await expect(service.createCustom(OWNER, oversized)).rejects.toMatchObject({ code: "invalid_request", reason: "prompt_too_large" });
  await expect(service.createCustom(OWNER, { ...input, recipe: { ...recipe, skills: ["matrix-jev-email-triage"] } }))
    .rejects.toMatchObject({ code: "invalid_request", reason: "unsupported_skill" });
  await expectEmptyCreation();
});

it("returns actionable allowlisted creation diagnostics without exposing resolved skill or provider errors", async () => {
  await writeFile(join(home, "skills/review/SKILL.md"), `---\nname: matrix-review\ndescription: Review safely\nauthor: Matrix OS\n---\n${"漢".repeat(1300)}\n`);
  const routes = createBotRoutes({ instantiation: service, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
  const response = await routes.request("/api/chat-agents/managed-custom", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, recipe, instructions: "漢".repeat(6000) }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: "invalid_request", reason: "prompt_too_large",
    message: "Shorten the instructions or remove recipe skills, then try again." });
  await expectEmptyCreation();
});

it("replays the same committed funded Bot after response loss without changing source or authorizing an edited payload", async () => {
  const created = await service.createCustom(OWNER, input);
  snapshot.accessSources[0]!.state = "disabled";
  expect(await service.createCustom(OWNER, input)).toEqual({ ...created, operation: "replayed" });
  await expect(service.createCustom(OWNER, { ...input, instructions: "Changed draft" })).rejects.toMatchObject({ code: "conflict" });
  expect(await agents.count(owner)).toBe(1);
  expect((await agents.get(owner, created.agent.id))?.instructions).toBe("Only confirmed work");
});
