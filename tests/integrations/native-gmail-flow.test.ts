import { KyselyPGlite } from 'kysely-pglite';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createPlatformDb, type PlatformDb } from '../../packages/gateway/src/platform-db.js';
import { NativeGmailOAuthManager } from '../../packages/gateway/src/integrations/native-gmail/oauth.js';
import { createNativeGmailClient } from '../../packages/gateway/src/integrations/native-gmail/client.js';
import { createNativeGmailLaunchRoutes } from '../../packages/gateway/src/integrations/native-gmail/routes.js';
import { createIntegrationRoutes } from '../../packages/gateway/src/integrations/routes.js';
import type { PipedreamConnectClient } from '../../packages/gateway/src/integrations/pipedream.js';
import { GMAIL_SCOPE } from '../../packages/gateway/src/integrations/native-gmail/types.js';
import { createBotIntegrationClient } from '../../packages/gateway/src/bots/integration-client.js';
import { createBotIntegrationTools } from '../../packages/gateway/src/bots/integration-tools.js';
import { createBotRecipeCatalog } from '../../packages/gateway/src/bots/recipe-catalog.js';
import { createBotStateTransactions } from '../../packages/gateway/src/bots/events.js';
import { ChatRepository } from '../../packages/gateway/src/chat/repository.js';
import { createBotBindingsRepository } from '../../packages/gateway/src/bots/repositories/bindings.js';
import { createBotTasksRepository } from '../../packages/gateway/src/bots/repositories/tasks.js';
import { createBotAccessHandlers } from '../../packages/gateway/src/bots/access-handlers.js';
import { createBotInteractionService } from '../../packages/gateway/src/bots/interactions.js';
import type { BotRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { BOT, OWNER, createBotStateDatabase, insertChat } from '../gateway/bots/bot-state-support.js';

describe('native Gmail consent through real integration actions', () => {
  let db: PlatformDb; let owner: string; let other: string; let app: Hono; let fetcher: ReturnType<typeof vi.fn>; let legacy: PipedreamConnectClient;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create(); db = createPlatformDb({ dialect: instance.dialect }); await db.migrate();
    owner = (await db.createUser({ clerkId: 'user_owner', handle: 'owner', displayName: 'Owner', email: 'owner@example.test', containerId: 'owner-container', pipedreamExternalId: 'ext-owner' })).id;
    other = (await db.createUser({ clerkId: 'user_other', handle: 'other', displayName: 'Other', email: 'other@example.test', containerId: 'other-container', pipedreamExternalId: 'ext-other' })).id;
    fetcher = vi.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', token_type: 'Bearer', scope: GMAIL_SCOPE, expires_in: 3600 });
      if (url.endsWith('/profile')) return Response.json({ emailAddress: 'owner@gmail.test', historyId: '9007199254740993' });
      if (url.includes('/history')) return new Response(null, { status: 404 });
      if (url.includes('/attachments/')) return Response.json({ size: 3, data: Buffer.from([0, 255, 42]).toString('base64url') });
      return Response.json({ id: 'message1', threadId: 'thread1', payload: { body: { data: 'complete' } } });
    });
    const paid = vi.fn(async () => { throw new Error('Paid execution must never run'); });
    legacy = { proxyGet: paid, proxyPost: paid, boundedGmailGet: paid, boundedGmailLabels: paid,
      getAppInfo: async () => null, listAccounts: async () => [], runAction: paid } as unknown as PipedreamConnectClient;
    const oauth = new NativeGmailOAuthManager({ store: db.nativeGmailStore!, clientId: 'matrix-client', clientSecret: 'matrix-secret',
      redirectUri: 'https://app.matrix-os.com/api/integrations/gmail/oauth/callback', encryptionKey: Buffer.alloc(32, 8), fetcher });
    const client = createNativeGmailClient({ legacy, oauth, fetcher });
    const resolveUserId = async (c: any) => c.req.header('x-owner') ?? null;
    app = new Hono().route('/api/integrations', createIntegrationRoutes({ db, nativeGmail: oauth, nativeGmailEligible: async () => true, pipedream: client, webhookSecret: '', resolveUserId }));
    app.route('/auth', createNativeGmailLaunchRoutes({ oauth, resolveUserId }));
  });
  afterEach(async () => db.destroy());
  const post = (app: Hono, path: string, owner: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'x-owner': owner, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const connect = async () => {
    const started = await post(app, '/api/integrations/connect', owner, { service: 'gmail', label: 'Work Gmail' });
    expect(started.status).toBe(200);
    const launch = new URL((await started.json()).url); const state = launch.searchParams.get('state')!;
    const launched = await app.request(`${launch.pathname}${launch.search}`, { headers: { 'x-owner': owner } });
    expect(launched.status).toBe(302);
    const cookie = launched.headers.get('set-cookie')!.split(';')[0]!;
    const complete = await app.request(`/api/integrations/gmail/oauth/callback?state=${state}&code=authorized-code`, { headers: { cookie } });
    expect(complete.status).toBe(200); expect(await complete.text()).not.toContain('private-access');
    return { state, cookie };
  };
  it('connects, lists safe account metadata, reads and sends directly, retaining scoped permissions', async () => {
    await connect();
    const listed = await app.request('/api/integrations', { headers: { 'x-owner': owner } });
    expect(listed.status).toBe(200); const text = await listed.text(); expect(text).not.toContain('private-refresh'); expect(text).not.toContain('encrypted_credentials');
    const read = await post(app, '/api/integrations/read-call', owner, { service: 'gmail', label: 'Work Gmail', action: 'get_message', params: { messageId: 'message1' } });
    expect(read.status).toBe(200); expect((await read.json()).data.id).toBe('message1');
    const denied = await post(app, '/api/integrations/read-call', owner, { service: 'gmail', label: 'Work Gmail', action: 'send_email', params: { to: 'person@example.test', subject: 'test', body: 'body' } });
    expect(denied.status).toBe(403);
    const sent = await post(app, '/api/integrations/call', owner, { service: 'gmail', label: 'Work Gmail', action: 'send_email', params: { to: 'person@example.test', subject: 'test', body: 'body' } });
    expect(sent.status).toBe(200);
    expect(legacy.proxyGet).not.toHaveBeenCalled(); expect(legacy.proxyPost).not.toHaveBeenCalled(); expect(legacy.runAction).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('pipedream'))).toBe(true);
  });
  it('rejects consent URL sharing, callback replay and cross-owner reads', async () => {
    const { state, cookie } = await connect();
    expect((await app.request(`/auth/gmail?state=${state}`, { headers: { 'x-owner': other } })).status).toBe(403);
    expect((await app.request(`/api/integrations/gmail/oauth/callback?state=${state}&code=code`, { headers: { cookie } })).status).toBe(502);
    const count = fetcher.mock.calls.length;
    const denied = await post(app, '/api/integrations/read-call', other, { service: 'gmail', label: 'Work Gmail', action: 'get_message', params: { messageId: 'message1' } });
    expect(denied.status).toBe(400); expect(fetcher.mock.calls.length).toBe(count);
  });
  it('returns explicit history recovery without pretending an expired cursor is current', async () => {
    await connect();
    const response = await post(app, '/api/integrations/read-call', owner, { service: 'gmail', label: 'Work Gmail', action: 'list_history', params: { startHistoryId: '9007199254740993' } });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'gmail_history_expired', resync_required: true });
  });
  it('requires an exact bot grant and approval before sending through direct Gmail', async () => {
    await connect();
    const row = (await db.listConnectedServices(owner))[0]!;
    const state = await createBotStateDatabase();
    try {
      const chatId = 'chat_directgmail'; const at = new Date().toISOString();
      await insertChat(state.db, chatId);
      await createBotBindingsRepository(state.db).bindDirect({ ownerId: OWNER, botId: BOT, chatId, now: at });
      const task = await createBotTasksRepository(state.db).create({ ownerId: OWNER, botId: BOT, chatId, now: at });
      const client = createBotIntegrationClient(async (actor, request) => {
        expect(actor).toBe(OWNER);
        return app.request(request.path === '/' ? '/api/integrations' : `/api/integrations${request.path}`, { method: request.method, signal: request.signal,
          headers: { 'x-owner': owner, 'content-type': 'application/json' }, ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
      });
      const transact = createBotStateTransactions(new ChatRepository(state.db as never));
      const tools = createBotIntegrationTools({ client, transact,
        recipes: createBotRecipeCatalog([{ recipeId: 'gmail-direct', version: '1', name: 'Mail helper', description: 'Mail helper', instructions: 'Help with mail',
          capabilities: ['integration.call'], integrations: [{ service: 'gmail', effects: ['read', 'send'], required: true }], output: 'Mail result' }]),
        agents: { get: async () => ({ id: BOT, recipeRef: { recipeId: 'gmail-direct', version: '1' } }) as never } });
      const interactions = createBotInteractionService({ transact, handlers: createBotAccessHandlers({ tools }) });
      const pending = () => state.db.selectFrom('bot_interactions').select(['interaction_id', 'revision'])
        .where('status', '=', 'pending').executeTakeFirstOrThrow();
      const binding: BotRuntimeBinding = { runtimeHandle: `runtime_${'c'.repeat(32)}`, executionGeneration: '1', ownerId: OWNER, botId: BOT,
        chatId, taskId: task.taskId, runId: 'run_directmail1', rootFingerprint: 'f'.repeat(64),
        route: { api: 'anthropic-messages', modelId: 'claude-sonnet-5', input: ['text'], contextWindow: 200000, maxOutputTokens: 8192 },
        accessSourceId: 'matrix_included', capabilities: ['integration.call'], requestClass: 'interactive' };
      const send = { service: 'gmail', action: 'send_email', connectionId: row.id, params: { to: 'person@example.test', subject: 'Test', body: 'Hello' } };
      const sends = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/messages/send')).length;
      expect((await tools.call(binding, send)).content[0]).toMatchObject({ text: expect.stringContaining('which Gmail account') });
      expect(sends()).toBe(0);
      const choice = await pending();
      await interactions.resolve(OWNER, chatId, choice.interaction_id, { kind: 'account_choice',
        baseRevision: Number(choice.revision), connectionId: row.id });
      expect((await tools.call(binding, send)).content[0]).toMatchObject({ text: expect.stringContaining('asked to approve') });
      expect(sends()).toBe(0);
      const approval = await pending();
      await interactions.resolve(OWNER, chatId, approval.interaction_id, { kind: 'approval',
        baseRevision: Number(approval.revision), decision: 'approve' });
      expect((await tools.call({ ...binding, runId: 'run_directmail2' }, send)).ok).toBe(true);
      expect(sends()).toBe(1); expect(legacy.proxyPost).not.toHaveBeenCalled(); expect(legacy.runAction).not.toHaveBeenCalled();
      await tools.call({ ...binding, runId: 'run_directmail3' }, send);
      expect(sends()).toBe(1);
    } finally { await state.destroy(); }
  });
});
