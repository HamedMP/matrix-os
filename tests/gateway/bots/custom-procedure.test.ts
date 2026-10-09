import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatAgentStore } from '../../../packages/gateway/src/chat/agent-store.js';
import { ChatRepository } from '../../../packages/gateway/src/chat/repository.js';
import type { ChatDatabase } from '../../../packages/gateway/src/chat/database.js';
import type { BotRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { createBotInstantiation, ensureBotWorkspace } from '../../../packages/gateway/src/bots/instantiation.js';
import { createBotRecipeCatalog } from '../../../packages/gateway/src/bots/recipe-catalog.js';
import { createBotProcedureResolver } from '../../../packages/gateway/src/bots/custom-procedure.js';
import { OWNER, createBotStateDatabase } from './bot-state-support.js';

const owner = { type: 'personal' as const, ownerId: OWNER };
let clean: () => Promise<void>;
let home: string;
let agents: ChatAgentStore;
let database: Awaited<ReturnType<typeof createBotStateDatabase>>["db"];
let resolver: ReturnType<typeof createBotProcedureResolver>;
let binding: BotRuntimeBinding;
beforeEach(async () => {
  const state = await createBotStateDatabase(); clean = state.destroy; database = state.db;
  home = await mkdtemp(join(tmpdir(), 'matrix-custom-procedure-'));
  agents = new ChatAgentStore({ homePath: home, db: state.db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap();
  const selection = { instanceId: 'matrix_chatgpt_plan', model: 'gpt-owner', options: [{ id: 'accountId', value: 'owner-account' }, { id: 'grantRevision', value: '3' }] };
  const created = await createBotInstantiation({ db: state.db, agents, chats: new ChatRepository(state.db as unknown as Kysely<ChatDatabase>), recipes: createBotRecipeCatalog(), validateSelection: async () => {}, ensureWorkspace: id => ensureBotWorkspace(home, id) }).createCustom(OWNER, { clientRequestId: 'req_custom_revalidate', name: 'Custom', instructions: 'Only confirmed work', selection });
  resolver = createBotProcedureResolver({ db: state.db, agents, recipes: createBotRecipeCatalog(), customRecipes: { catalog: vi.fn(), resolve: vi.fn(), revalidate: vi.fn() } });
  binding = { ownerId: OWNER, botId: created.agent.id, chatId: created.chatId, managedDefinitionRevision: 1, route: { modelId: 'gpt-owner', api: 'openai-responses' }, accessSourceId: 'matrix_chatgpt_plan', subscription: { accountId: 'owner-account', grantRevision: 3 } } as BotRuntimeBinding;
});
afterEach(async () => { await agents.close(); await clean(); await rm(home, { recursive: true, force: true }); });

it('allows explicitly saved Automatic to retain a qualified non-subscription run', async () => {
  const agent = await agents.update(owner, binding.botId, { baseRevision: 1, selection: { instanceId: 'matrix_bot_default', model: 'auto' } });
  const automatic = { ...binding, managedDefinitionRevision: agent.revision, accessSourceId: 'matrix_included' as const, subscription: undefined, route: { ...binding.route, modelId: 'glm-owner', api: 'openai-completions' as const } };
  await expect(resolver.revalidate(automatic)).resolves.toBeUndefined();
  await expect(resolver.revalidate({ ...automatic, accessSourceId: 'matrix_chatgpt_plan', subscription: binding.subscription })).rejects.toMatchObject({ code: 'model_unavailable' });
});

it('refuses a source-mismatched continuation even when its model and definition revision match', async () => {
  const agent = await agents.update(owner, binding.botId, { baseRevision: 1, selection: { instanceId: 'matrix_pi_default', model: 'gpt-owner' } });
  const current = { ...binding, managedDefinitionRevision: agent.revision, subscription: undefined };
  await expect(resolver.revalidate({ ...current, accessSourceId: 'owner_anthropic_key' })).rejects.toMatchObject({ code: 'model_unavailable' });
  await expect(resolver.revalidate({ ...current, accessSourceId: 'matrix_included' })).resolves.toBeUndefined();
});

it('refuses ordinary creation provenance despite an otherwise matching active hash and direct Chat', async () => {
  const agent = (await agents.get(owner, binding.botId))!;
  await database.updateTable('bot_operations').set({ client_request_id: 'req_ordinary_recipe_operation' }).where('bot_id', '=', agent.id).execute();
  await expect(resolver.assert(OWNER, agent, binding.chatId)).rejects.toMatchObject({ code: 'model_unavailable' });
});
