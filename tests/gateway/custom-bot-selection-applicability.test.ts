import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { ChatAgentContext } from "../../packages/gateway/src/chat/agent-context.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createChatAgentRoutes } from "../../packages/gateway/src/chat/agent-routes.js";
import { createCustomBotChats } from "../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotStateDatabase, OWNER } from "./bots/bot-state-support.js";
import { ordinaryPlanCatalog, planBinding, planId } from "../ui/ordinary-chatgpt-plan-fixture.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const fields = { clientRequestId: "req_custom_applicability", name: "Saved custom Bot", description: "Original description", instructions: "Preserve exact instructions.", selection: { instanceId: "hermes_default", model: "openai-codex:gpt-5.6-sol" } };
const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const files = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : join(directory, entry.name)))).flat();
let home: string, agents: ChatAgentStore, repository: ChatRepository, destroy: () => Promise<void>, app: ReturnType<typeof createChatAgentRoutes>;
beforeEach(async () => {
  const state = await createBotStateDatabase(); destroy = state.destroy;
  repository = new ChatRepository(state.db as never);
  home = await mkdtemp(join(tmpdir(), "matrix-custom-applicability-"));
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap();
  const catalog = ordinaryPlanCatalog(), base = catalog.instances[0]!;
  catalog.instances.push({ ...base, id: fields.selection.instanceId, driverKind: "hermes", models: [{ ...base.models[0]!, id: fields.selection.model }], supports: { ...base.supports, permissionModes: ["full_access"] } });
  catalog.instances.push({ ...base, id: "matrix_chatgpt_plan", driverKind: "matrix_bot", defaultSelection: { instanceId: "matrix_chatgpt_plan", model: "gpt-owner", options: planBinding }, supports: { ...base.supports, rootChat: false, permissionModes: ["default"] }, models: [{ ...base.models[0]!, id: "gpt-owner" }], options: catalog.instances.find(instance => instance.id === planId)!.options });
  app = createChatAgentRoutes({ agents, repository, context: new ChatAgentContext({ agents, repository, enabled: () => true }), enabled: () => true, catalog: { getCatalog: async () => catalog }, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
});
afterEach(async () => { await agents.close(); await destroy(); await rm(home, { recursive: true, force: true }); });

it.each([planId, "matrix_chatgpt_plan"])("rejects fresh generic creation with unsupported %s before definition writes", async instanceId => {
  const response = await app.request("/api/chat-agents", json("POST", { ...fields, selection: { instanceId, model: "gpt-owner", options: planBinding } }));
  expect(response.status).toBe(400); expect(await agents.list(owner)).toEqual([]);
  expect((await files(home)).filter(path => path.endsWith(".md"))).toEqual([]);
});

it.each([
  { name: "Jev Inbox Triage", model: "openai-codex:gpt-5.3-codex-spark", revision: 1 },
  { name: "Jev Inbox Triage", model: "openai-codex:gpt-5.6-sol", revision: 2 },
  { name: "Signal Brief", model: "openai-codex:gpt-5.6-sol", revision: 1 },
])("refuses ordinary subscription PATCH without changing $name/$model/rev$revision or its dedicated history", async shape => {
  let bot = await agents.create(owner, { ...fields, name: shape.name, selection: { ...fields.selection, model: shape.model },
    ...(shape.name === "Jev Inbox Triage" ? { recipe: { skills: ["matrix-jev-email-triage", "matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Synthetic account" }], output: "Read-only proposals" } } : {}) });
  if (shape.revision === 2) bot = await agents.update(owner, bot.id, { baseRevision: 1, instructions: bot.instructions });
  const chats = createCustomBotChats({ chats: repository, agents }), chatId = await chats.ensureDirectChat(owner, bot.id);
  const paths = await files(home), before = await Promise.all(paths.map(path => readFile(path)));
  const history = await repository.get(owner, chatId);
  const response = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, name: "Rejected rename", selection: { instanceId: planId, model: "gpt-owner", options: planBinding } }));
  expect(response.status).toBe(400); expect(await agents.get(owner, bot.id)).toEqual(bot);
  expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before); expect(await repository.get(owner, chatId)).toEqual(history);
  expect(await chats.ensureDirectChat(owner, bot.id)).toBe(chatId);
  expect(await repository.kysely.selectFrom("bot_provider_authorizations" as never).selectAll().execute()).toHaveLength(0);
  expect(await repository.kysely.selectFrom("bot_execution_bindings" as never).selectAll().execute()).toHaveLength(0);
});

it("preserves text-only edits and idempotent create replay for historical custom selections without migrating them", async () => {
  const legacyFields = { ...fields, selection: { instanceId: planId, model: "gpt-owner", options: planBinding } };
  const bot = await agents.create(owner, legacyFields);
  expect((await app.request("/api/chat-agents", json("POST", legacyFields))).status).toBe(201);
  const response = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, name: "Explicit identity edit" }));
  expect(response.status).toBe(200);
  expect(await agents.get(owner, bot.id)).toMatchObject({ name: "Explicit identity edit", revision: bot.revision + 1, selection: legacyFields.selection, instructions: bot.instructions });
});

it("keeps exact recipe Bot subscription selection and account/grant binding editable", async () => {
  const bot = await agents.createRecipeBot(owner, { id: "bot_recipeapplicability", createHash: "a".repeat(64), recipeRef: { recipeId: "writer", version: "1" }, fields: { name: fields.name, description: fields.description, instructions: fields.instructions, selection: { instanceId: "matrix_bot_default", model: "auto" } } });
  const selection = { instanceId: "matrix_chatgpt_plan", model: "gpt-owner", options: planBinding };
  const response = await app.request(`/api/chat-agents/${bot.id}`, json("PATCH", { baseRevision: bot.revision, selection }));
  expect(response.status).toBe(200); expect(await agents.get(owner, bot.id)).toMatchObject({ revision: bot.revision + 1, recipeRef: bot.recipeRef, selection });
});
