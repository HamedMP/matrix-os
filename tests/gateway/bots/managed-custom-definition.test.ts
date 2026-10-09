import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreateManagedCustomBotRequestSchema } from "@matrix-os/contracts";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { createChatAgentRoutes } from "../../../packages/gateway/src/chat/agent-routes.js";
import { createChatAgentRecipeResolver } from "../../../packages/gateway/src/chat/agent-recipe.js";
import { createBotInstantiation, ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotProcedureResolver } from "../../../packages/gateway/src/bots/custom-procedure.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT_SYSTEM_PROMPT_TOKEN_BUDGET, buildBotSystemPrompt, estimatePromptTokens } from "../../../packages/gateway/src/bots/system-prompt.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const automatic = { instanceId: "matrix_bot_default", model: "auto" };
const input = { clientRequestId: "req_custom_budget", name: "Budget", instructions: "Confirmed work only", selection: {
  instanceId: "matrix_chatgpt_plan", model: "gpt-owner", options: [{ id: "accountId", value: "owner-account" }, { id: "grantRevision", value: "3" }],
} };
const recipe = { skills: ["matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Personal" }], output: "Confirmed result" };
let home: string;
let state: Awaited<ReturnType<typeof createBotStateDatabase>>;
let agents: ChatAgentStore;
let repository: ChatRepository;
let recipes: ReturnType<typeof createChatAgentRecipeResolver>;
let service: ReturnType<typeof createBotInstantiation>;
let routes: ReturnType<typeof createChatAgentRoutes>;
let procedures: ReturnType<typeof createBotProcedureResolver>;
let gmailLookup: ReturnType<typeof vi.fn>;

async function skill(instructions: string) {
  const directory = join(home, "skills/matrix/integrations");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: matrix-integrations\ndescription: Safe tools\nauthor: Matrix OS\n---\n${instructions}\n`);
}
beforeEach(async () => {
  state = await createBotStateDatabase();
  home = await mkdtemp(join(tmpdir(), "matrix-custom-definition-"));
  repository = new ChatRepository(state.db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
  await agents.bootstrap();
  await skill("Use only authorized tools.");
  recipes = createChatAgentRecipeResolver({ skillsRoot: join(home, "skills/matrix"), services: [{ id: "gmail", name: "Gmail" }] });
  service = createBotInstantiation({ db: state.db, agents, chats: repository, recipes: createBotRecipeCatalog(),
    customRecipes: recipes,
    validateSelection: async () => {}, ensureWorkspace: id => ensureBotWorkspace(home, id) });
  procedures = createBotProcedureResolver({ db: state.db, agents, recipes: createBotRecipeCatalog(), customRecipes: recipes });
  gmailLookup = vi.fn(async () => [{ id: "conn_budget", user_id: OWNER, service: "gmail" as const,
    account_label: "Personal", account_email: "owner@example.test", status: "active" as const }]);
  routes = createChatAgentRoutes({ agents, repository, recipes, context: new ChatAgentContext({ agents, repository, recipes, enabled: () => true }),
    enabled: () => true, catalog: { getCatalog: async () => createCanonicalProviderCatalogFixture() },
    getPrincipal: () => ({ userId: OWNER, source: "jwt" }), listGmailAccounts: gmailLookup });
});
afterEach(async () => { await agents.close(); await state.destroy(); await rm(home, { recursive: true, force: true }); });

async function patch(id: string, body: unknown) {
  return routes.request(`/api/chat-agents/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function emptyCreationState() {
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
  expect(await state.db.selectFrom("chats").selectAll().execute()).toHaveLength(0);
  expect(await agents.list(owner)).toHaveLength(0);
  expect((await readdir(home, { recursive: true })).filter(name => name.startsWith("agents/custom/") && name.endsWith(".md"))).toHaveLength(0);
}
async function definitions() {
  const paths = (await readdir(home, { recursive: true })).filter(name => name.startsWith("agents/custom/") && name.endsWith(".md")).sort();
  return Promise.all(paths.map(async path => ({ path, bytes: await readFile(join(home, path)) })));
}

it("rejects DTO-valid 7500 CJK instructions before reservation, definition or Chat", async () => {
  const request = { ...input, instructions: "漢".repeat(7500) };
  expect(CreateManagedCustomBotRequestSchema.safeParse(request).success).toBe(true);
  await expect(service.createCustom(OWNER, request)).rejects.toMatchObject({ code: "invalid_request" });
  await emptyCreationState();
});

it("rejects combined installed skills and instructions over budget before any creation writes", async () => {
  await skill("漢".repeat(1300));
  const request = { ...input, instructions: "漢".repeat(6000), recipe };
  expect(CreateManagedCustomBotRequestSchema.safeParse(request).success).toBe(true);
  await expect(service.createCustom(OWNER, request)).rejects.toMatchObject({ code: "invalid_request" });
  await emptyCreationState();
});

it("rejects oversized managed edits before binding or definition changes", async () => {
  const created = await service.createCustom(OWNER, input);
  const update = vi.spyOn(agents, "update");
  const files = await definitions();
  const operations = await state.db.selectFrom("bot_operations").selectAll().execute();
  const chats = await state.db.selectFrom("chats").selectAll().execute();
  for (const body of [{ instructions: "漢".repeat(7500) }, { instructions: "漢".repeat(6000), recipe }]) {
    await skill("漢".repeat(1300));
    const response = await patch(created.agent.id, { baseRevision: 1, ...body });
    expect(response.status).toBe(400);
    expect((await agents.get(owner, created.agent.id))?.revision).toBe(1);
  }
  expect(update).not.toHaveBeenCalled();
  expect(gmailLookup).not.toHaveBeenCalled();
  expect(await definitions()).toEqual(files);
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toEqual(operations);
  expect(await state.db.selectFrom("chats").selectAll().execute()).toEqual(chats);
});

it("refuses the unsupported Jev skill on Automatic managed edits before Gmail binding", async () => {
  const created = await service.createCustom(OWNER, input);
  const update = vi.spyOn(agents, "update");
  const unsupported = { ...recipe, skills: ["matrix-jev-email-triage", "matrix-integrations"] };
  const response = await patch(created.agent.id, { baseRevision: 1, selection: automatic, recipe: unsupported });
  expect(response.status).toBe(400);
  expect(gmailLookup).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect((await agents.get(owner, created.agent.id))?.recipe).toBeUndefined();
});

it("accepts a full prompt exactly at the runtime budget and trims only optional memory", async () => {
  const first = await service.createCustom(OWNER, input);
  const firstAgent = (await agents.get(owner, first.agent.id))!;
  const base = await procedures.resolve(OWNER, firstAgent);
  const now = new Date("2026-10-09T00:00:00.000Z");
  const overhead = estimatePromptTokens(buildBotSystemPrompt({ botName: input.name, instructions: "", recipe: base, now }));
  const instructions = "漢".repeat(BOT_SYSTEM_PROMPT_TOKEN_BUDGET - overhead);
  const boundary = await service.createCustom(OWNER, { ...input, clientRequestId: "req_custom_boundary", instructions });
  const agent = (await agents.get(owner, boundary.agent.id))!;
  const resolved = await procedures.resolve(OWNER, agent);
  const prompt = buildBotSystemPrompt({ botName: agent.name, instructions: resolved.instructions, recipe: resolved, now,
    memory: ["漢".repeat(1000)] });
  expect(estimatePromptTokens(prompt)).toBe(BOT_SYSTEM_PROMPT_TOKEN_BUDGET);
  expect(prompt).toContain(instructions);
  expect(prompt).not.toContain("What the owner has told you before");
  await expect(service.createCustom(OWNER, { ...input, clientRequestId: "req_custom_boundary_plus", instructions: instructions + "漢" }))
    .rejects.toMatchObject({ code: "invalid_request" });
  expect((await patch(boundary.agent.id, { baseRevision: 1, name: "漢".repeat(80) })).status).toBe(400);
  expect((await agents.get(owner, boundary.agent.id))?.revision).toBe(1);
  const edited = await patch(boundary.agent.id, { baseRevision: 1, instructions: "Use a short confirmed answer", recipe });
  expect(edited.status).toBe(200);
  const saved = (await agents.get(owner, boundary.agent.id))!;
  const procedure = await procedures.resolve(OWNER, saved);
  expect(procedure.instructions).toContain("Use a short confirmed answer");
  expect(procedure.instructions).toContain("Use only authorized tools.");
  expect(estimatePromptTokens(buildBotSystemPrompt({ botName: saved.name, instructions: procedure.instructions, recipe: procedure, now })))
    .toBeLessThan(BOT_SYSTEM_PROMPT_TOKEN_BUDGET);
});

it("preserves active replay even when installed skills subsequently exceed admission budget", async () => {
  const created = await service.createCustom(OWNER, { ...input, recipe });
  await skill("漢".repeat(7500));
  await expect(service.createCustom(OWNER, { ...input, recipe })).resolves.toEqual({ ...created, operation: "replayed" });
});

it("preserves pending creation state on a newly oversized skill and recovers the original IDs", async () => {
  let interrupted = true;
  const pending = createBotInstantiation({ db: state.db, agents, chats: repository, recipes: createBotRecipeCatalog(),
    customRecipes: recipes, validateSelection: async () => {}, ensureWorkspace: async id => {
      if (interrupted) { interrupted = false; throw new Error("Synthetic workspace interruption"); }
      await ensureBotWorkspace(home, id);
    } });
  await expect(pending.createCustom(OWNER, { ...input, recipe })).rejects.toMatchObject({ code: "unavailable" });
  const operation = (await state.db.selectFrom("bot_operations").selectAll().execute())[0]!;
  const files = await definitions();
  await skill("漢".repeat(7500));
  await expect(pending.createCustom(OWNER, { ...input, recipe })).rejects.toMatchObject({ code: "invalid_request" });
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toEqual([operation]);
  expect(await definitions()).toEqual(files);
  expect(await state.db.selectFrom("chats").selectAll().execute()).toHaveLength(0);
  await skill("Use only authorized tools.");
  const recovered = await pending.createCustom(OWNER, { ...input, recipe });
  expect(recovered.agent.id).toBe(operation.bot_id);
  expect(recovered.chatId).toBe(operation.chat_id);
});

it("keeps installed skill read failures as unavailable without mutating the saved Bot", async () => {
  const created = await service.createCustom(OWNER, { ...input, recipe });
  const files = await definitions();
  const update = vi.spyOn(agents, "update");
  vi.spyOn(recipes, "resolve").mockRejectedValue(new Error("Synthetic filesystem outage"));
  const response = await patch(created.agent.id, { baseRevision: 1, instructions: "Still valid" });
  expect(response.status).toBe(503);
  expect(update).not.toHaveBeenCalled();
  expect(await definitions()).toEqual(files);
  expect((await agents.get(owner, created.agent.id))?.revision).toBe(1);
});

it("preserves description edits and archival withdrawal despite unavailable skills, without accepting incompatible recipe changes", async () => {
  const created = await service.createCustom(OWNER, { ...input, recipe });
  const resolve = vi.spyOn(recipes, "resolve").mockRejectedValue(new Error("Synthetic filesystem outage"));
  const operations = await state.db.selectFrom("bot_operations").selectAll().execute();
  const chats = await state.db.selectFrom("chats").selectAll().execute();
  expect((await patch(created.agent.id, { baseRevision: 1, description: "Updated profile description" })).status).toBe(200);
  expect((await patch(created.agent.id, { baseRevision: 2, archived: true })).status).toBe(200);
  expect(resolve).not.toHaveBeenCalled();
  const saved = (await agents.get(owner, created.agent.id))!;
  expect(saved).toMatchObject({ revision: 3, description: "Updated profile description", archived: true,
    instructions: input.instructions, recipe });
  expect((await patch(created.agent.id, { baseRevision: 3, archived: true,
    recipe: { ...recipe, skills: ["matrix-jev-email-triage"] } })).status).toBe(400);
  expect((await patch(created.agent.id, { baseRevision: 3, archived: false })).status).toBe(503);
  expect((await agents.get(owner, created.agent.id))?.revision).toBe(3);
  expect(gmailLookup).not.toHaveBeenCalled();
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toEqual(operations);
  expect(await state.db.selectFrom("chats").selectAll().execute()).toEqual(chats);
});

it("accepts the editor's unchanged executable payload for description recovery but validates actual mutations", async () => {
  const created = await service.createCustom(OWNER, { ...input, recipe });
  const resolve = vi.spyOn(recipes, "resolve").mockRejectedValue(new Error("Synthetic filesystem outage"));
  const unchanged = { name: input.name, instructions: input.instructions,
    selection: { ...input.selection, options: [...input.selection.options].reverse() }, recipe };
  expect((await patch(created.agent.id, { ...unchanged, baseRevision: 1, description: "Recovered description" })).status).toBe(200);
  expect(resolve).not.toHaveBeenCalled();
  const saved = (await agents.get(owner, created.agent.id))!;
  expect(saved).toMatchObject({ revision: 2, description: "Recovered description", instructions: input.instructions, recipe });
  expect((await patch(created.agent.id, { ...unchanged, baseRevision: 2, archived: true })).status).toBe(200);
  expect(resolve).not.toHaveBeenCalled();
  expect((await agents.get(owner, created.agent.id))?.archived).toBe(true);
  const files = await definitions();
  for (const change of [
    { name: "Different job" }, { instructions: "Different instructions" },
    { selection: { ...input.selection, options: [{ id: "accountId", value: "different-account" }, { id: "grantRevision", value: "3" }] } },
    { recipe: { ...recipe, output: "Different result" } }, { archived: false },
  ]) {
    expect((await patch(created.agent.id, { ...unchanged, ...change, baseRevision: 3 })).status).toBe(503);
    expect((await agents.get(owner, created.agent.id))?.revision).toBe(3);
    expect(await definitions()).toEqual(files);
  }
  expect(resolve).toHaveBeenCalledTimes(5);
  expect(gmailLookup).not.toHaveBeenCalled();
});

it("records policy_denied on a durable task when an installed skill grows beyond the saved prompt budget", async () => {
  const created = await service.createCustom(OWNER, { ...input, recipe });
  const files = await definitions();
  await skill("漢".repeat(7500));
  const admit = vi.fn(async () => { throw new Error("Oversized prompt must not reach admission"); });
  const runBot = vi.fn(async () => { throw new Error("Oversized prompt must not reach the worker"); });
  const orchestrator = createBotTaskOrchestrator({ agents, recipes: createBotRecipeCatalog(),
    bindings: createBotBindingsRepository(state.db), transact: createBotStateTransactions(repository),
    resolveProcedure: (ownerId, agent) => procedures.resolve(ownerId, agent),
    resolveRoute: async () => ({ accessSourceId: "matrix_chatgpt_plan", subscription: { accountId: "owner-account", grantRevision: 3 },
      route: { api: "openai-responses", modelId: "gpt-owner", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8192 } }),
    admission: { admit, release: vi.fn() }, registry: new BotRuntimeRegistry(), client: { runBot } });
  const run = orchestrator.start({ ownerId: OWNER, chatId: created.chatId, runId: "run_skill_growth",
    text: "Summarize", selection: input.selection, signal: new AbortController().signal });
  await expect(run.result).resolves.toEqual({ status: "blocked", blockedReason: "policy_denied" });
  expect(await state.db.selectFrom("bot_tasks").select(["status", "blocked_reason", "run_id", "revision"]).execute())
    .toEqual([{ status: "blocked", blocked_reason: "policy_denied", run_id: "run_skill_growth", revision: 3 }]);
  expect(admit).not.toHaveBeenCalled();
  expect(runBot).not.toHaveBeenCalled();
  expect(await definitions()).toEqual(files);
  expect((await agents.get(owner, created.agent.id))?.revision).toBe(1);
});
