import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createWhatsAppRepository } from '../../packages/platform/src/whatsapp/repository.js';
import { readWhatsAppConfig } from '../../packages/platform/src/whatsapp/config.js';
import { createWhatsAppService } from '../../packages/platform/src/whatsapp/service.js';
import { createWhatsAppRoutes } from '../../packages/platform/src/whatsapp/routes.js';
import { createWhatsAppAgentClient } from '../../packages/platform/src/whatsapp/agent-client.js';
import { createWhatsAppAgentApiFixture } from './whatsapp-agent-fixtures.js';
import { detail, message, record, selection } from './whatsapp-agent-fixtures.js';
import { decryptWhatsAppPayload } from '../../packages/platform/src/whatsapp/crypto.js';
import { sql } from 'kysely';

const sender = '46701234567';
const owner = 'user_owner';
const origin = 'https://app.example.com';
const config = readWhatsAppConfig({
  WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-secret',
  WHATSAPP_ACCESS_TOKEN: 'private-token', WHATSAPP_PHONE_NUMBER_ID: '123456',
  WHATSAPP_GRAPH_API_VERSION: 'v25.0', WHATSAPP_ENCRYPTION_KEY: 'a'.repeat(64),
  WHATSAPP_PUBLIC_URL: origin, WHATSAPP_ALLOWED_SENDERS: sender,
})!;
let db: Awaited<ReturnType<typeof createTestPlatformDb>>['db'];
let now: number;
let repo: ReturnType<typeof createWhatsAppRepository>;
let service: ReturnType<typeof createWhatsAppService>;
let routes: ReturnType<typeof createWhatsAppRoutes>;
let sends: { to: string; text: string }[];
let reactions: { to: string; messageId: string; emoji: string }[];
let api: ReturnType<typeof createWhatsAppAgentApiFixture>;
let agent: ReturnType<typeof createWhatsAppAgentClient>;
beforeEach(async () => {
  db = (await createTestPlatformDb()).db;
  now = Date.UTC(2026, 9, 2, 12);
  repo = createWhatsAppRepository(db, config.encryptionKey, () => now);
  sends = []; reactions = []; vi.clearAllMocks();
  api = createWhatsAppAgentApiFixture(owner);
  agent = createWhatsAppAgentClient(api.resolveTarget, api.fetchImpl);
  vi.spyOn(agent, 'start');
  service = createWhatsAppService({ react: async (to, messageId, emoji) => { reactions.push({ to, messageId, emoji }); }, config, repository: repo, agent, now: () => now,
    send: async (to, text) => { sends.push({ to, text }); return 'wamid.reply'; },
  });
  routes = createWhatsAppRoutes({ config, repository: repo, service,
    authenticate: async (token) => token === 'owner-token' ? owner : null,
    publishableKey: 'pk_test_example', now: () => now,
  });
});
afterEach(async () => { await service.shutdown(); await destroyTestPlatformDb(db); });
function event(id: string, text: string) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '999', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: config.phoneNumberId },
    messages: [{ id, from: sender, timestamp: String(now / 1000), type: 'text', text: { body: text } }],
  } }] }] });
}
function webhook(id: string, text: string) {
  const raw = event(id, text);
  return routes.request('/whatsapp/webhook', { method: 'POST', body: raw, headers: {
    'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', config.appSecret).update(raw).digest('hex')}`,
  } });
}
function call(path: string, payload: unknown, token = 'owner-token', requestOrigin = origin) {
  return routes.request(path, { method: 'POST', body: JSON.stringify(payload), headers: {
    'content-type': 'application/json', authorization: `Bearer ${token}`, origin: requestOrigin,
  } });
}

describe('WhatsApp account linking and delivery', () => {
  it('waits for lease recovery after a prepared snapshot commits but its response is lost', async () => {
    const { token } = await repo.startLink(sender, 'link-unknown-preparation');
    await repo.claim(token, owner);
    const proof = await repo.lease();
    const code = String(proof!.payload.text).match(/\b\d{6}\b/)![0];
    await repo.finish(proof!.id, proof!.fence, 'complete');
    await repo.confirm(token, owner, code, 'whatsapp-general-agent-v1');
    await service.tick();
    expect(sends.at(-1)?.text).toContain('connected to WhatsApp');
    sends = [];
    const original = repo.checkpoint;
    let interrupted = false;
    const save = vi.spyOn(repo, 'checkpoint').mockImplementation(async (id, fence, payload) => {
      const committed = await original(id, fence, payload);
      if (!interrupted && payload.preparedAdmission) { interrupted = true; throw new Error('Commit response lost'); }
      return committed;
    });
    service = createWhatsAppService({ react: vi.fn(async () => {}), config, repository: repo, agent, now: () => now,
      send: async (to, text) => { sends.push({ to, text }); return 'wamid.reply'; }, logError: () => {},
    });
    try {
      await service.ingest([{ id: 'wamid.unknown-preparation', sender, timestamp: now / 1000, type: 'text', text: 'Hello' }]);
      await service.tick();
      expect(api.admissionCount).toBe(0);
      const stored = await sql<{ payload: string; state: string }>`SELECT payload,state FROM whatsapp_jobs WHERE id='wamid.unknown-preparation'`.execute(db.kysely);
      expect(stored.rows[0]!.state).toBe('leased');
      expect(decryptWhatsAppPayload(stored.rows[0]!.payload, Buffer.from(config.encryptionKey, 'hex')))
        .toMatchObject({ kind: 'incoming', preparedAdmission: { machineId: 'machine_1', chatId: 'chat_whatsapp' } });
      now += 60_001;
      await service.tick();
      expect(api.admissionCount).toBe(1);
      expect(await repo.getConnection(owner)).toMatchObject({ chatId: 'chat_whatsapp' });
      expect(api.calls.filter((call) => call.url.includes('chat-providers'))).toHaveLength(1);
    } finally { save.mockRestore(); }
  });
  it('recovers the durable original admission after a lost response and model changes beyond 200 messages', async () => {
    const { token } = await repo.startLink(sender, 'link-recovery');
    await repo.claim(token, owner);
    const proof = await repo.lease();
    const code = String(proof!.payload.text).match(/\b\d{6}\b/)![0];
    await repo.finish(proof!.id, proof!.fence, 'complete');
    await repo.confirm(token, owner, code, 'whatsapp-general-agent-v1');
    await service.tick();
    expect(sends.at(-1)?.text).toContain('connected to WhatsApp');
    sends = [];
    let lost = false;
    agent = createWhatsAppAgentClient(api.resolveTarget, async (input, init) => {
      if (lost && init?.method === 'GET' && String(input).includes('/api/chats/')) {
        return Response.json({ ...detail(), record: { chat: { ...record(owner, 1000).chat,
          messageCount: 1000, currentSelection: { ...selection, model: 'changed-model' } } },
        messages: Array.from({ length: 200 }, (_, index) => ({ ...message(`msg_recent_${index}`), seq: 801 + index })),
        nextCursor: 'chatcur_older' });
      }
      const response = await api.fetchImpl(input, init);
      if (!lost && String(input).endsWith('/turns')) { lost = true; throw new Error('Response lost after admission'); }
      return response;
    });
    service = createWhatsAppService({ react: vi.fn(async () => {}), config, repository: repo, agent, now: () => now,
      send: async (to, text) => { sends.push({ to, text }); return 'wamid.reply'; }, logError: () => {},
    });
    await service.ingest([{ id: 'wamid.recovery', sender, timestamp: now / 1000, type: 'text', text: 'Hello' }]);
    await service.tick();
    expect(api.admissionCount).toBe(1);
    now += 31_000;
    await service.tick();
    expect(await repo.getConnection(owner)).toMatchObject({ machineId: 'machine_1', chatId: 'chat_whatsapp' });
    expect(api.admissionCount).toBe(1);
    const admissions = api.calls.filter((call) => call.url.endsWith('/turns'));
    expect(admissions).toHaveLength(2);
    expect(admissions[1]!.body).toMatchObject({ ...(admissions[0]!.body as object), baseRevision: 1000 });
    expect(api.calls.filter((call) => call.url.includes('chat-providers'))).toHaveLength(1);
  });
  it('does not admit an agent turn if STOP arrives while the model catalog is loading', async () => {
    const { token } = await repo.startLink(sender, 'link-stop-race');
    await repo.claim(token, owner);
    const proof = await repo.lease();
    const code = String(proof!.payload.text).match(/\b\d{6}\b/)![0];
    await repo.finish(proof!.id, proof!.fence, 'complete');
    await repo.confirm(token, owner, code, 'whatsapp-general-agent-v1');
    await service.tick();
    expect(sends.at(-1)?.text).toContain('connected to WhatsApp');
    sends = [];
    let catalogReached!: () => void;
    let releaseCatalog!: () => void;
    const reached = new Promise<void>((resolve) => { catalogReached = resolve; });
    const release = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    agent = createWhatsAppAgentClient(api.resolveTarget, async (input, init) => {
      if (String(input).includes('/api/chat-providers')) { catalogReached(); await release; }
      return api.fetchImpl(input, init);
    });
    service = createWhatsAppService({ react: vi.fn(async () => {}), config, repository: repo, agent, now: () => now,
      send: async (to, text) => { sends.push({ to, text }); return 'wamid.reply'; }, logError: () => {},
    });
    routes = createWhatsAppRoutes({ config, repository: repo, service,
      authenticate: async () => owner, publishableKey: 'pk_test_example',
    });
    await webhook('wamid.stop-race-question', 'Start a task');
    const dispatch = service.tick();
    await reached;
    await webhook('wamid.stop-race-stop', 'STOP');
    releaseCatalog();
    await dispatch;
    expect(await repo.getConnection(owner)).toBeNull();
    expect(api.admissionCount).toBe(0);
  });
  it('returns a safe recovery message when the connected agent remains unavailable', async () => {
    const { token } = await repo.startLink(sender, 'link-unavailable');
    await repo.claim(token, owner);
    const proof = await repo.lease();
    const code = String(proof!.payload.text).match(/\b\d{6}\b/)![0];
    await repo.finish(proof!.id, proof!.fence, 'complete');
    await repo.confirm(token, owner, code, 'whatsapp-general-agent-v1');
    await service.tick();
    expect(sends.at(-1)?.text).toContain('connected to WhatsApp');
    sends = [];
    vi.mocked(agent.start).mockRejectedValue(new Error('private provider diagnostic'));
    service = createWhatsAppService({ react: vi.fn(async () => {}), config, repository: repo, agent, now: () => now,
      send: async (to, text) => { sends.push({ to, text }); return 'wamid.reply'; }, logError: () => {},
    });
    routes = createWhatsAppRoutes({ config, repository: repo, service,
      authenticate: async () => owner, publishableKey: 'pk_test_example',
    });
    await webhook('wamid.unavailable', 'Do something for me');
    for (let attempt = 0; attempt < 5; attempt++) { await service.tick(); now += 31_000; }
    expect(sends).toEqual([{ to: sender, text: `Your Matrix agent is temporarily unavailable. Open Matrix to check your agent and try again: ${origin}` }]);
    expect(sends[0]!.text).not.toContain('private provider diagnostic');
    await service.tick();
    expect(sends).toHaveLength(1);
  });
  it('crosses signed webhook, durable linking proof, canonical agent and reply; deduplicates redelivery', async () => {
    expect((await webhook('wamid.hello', 'Hey Matrix')).status).toBe(200);
    await service.tick();
    expect(sends[0]?.to).toBe(sender);
    const link = sends[0]!.text.match(/https:\/\/\S+/)![0];
    const token = new URL(link).searchParams.get('token')!;
    expect(agent.start).not.toHaveBeenCalled();
    const claim = await call('/api/whatsapp/claim', { token });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ maskedSender: '••••4567' });
    await service.tick();
    const code = sends[1]!.text.match(/\b\d{6}\b/)![0];
    expect((await call('/api/whatsapp/confirm', { token, code, consentVersion: 'whatsapp-general-agent-v1' })).status).toBe(200);
    await service.tick();
    expect(sends[2]).toEqual({ to: sender, text: expect.stringContaining('connected to WhatsApp') });
    expect(agent.start).not.toHaveBeenCalled();
    expect(reactions).toEqual([]);
    expect((await webhook('wamid.question', 'Who are you?')).status).toBe(200);
    await service.tick();
    expect(reactions).toEqual([{ to: sender, messageId: 'wamid.question', emoji: '👀' }]);
    await service.tick();
    expect(agent.start).toHaveBeenCalledWith(expect.objectContaining({ owner, sender, text: 'Who are you?', allowFullAccess: true }), expect.any(Function), expect.any(Function));
    expect(sends.at(-1)?.text).toBe('Your Matrix agent is here.');
    const count = sends.length;
    await webhook('wamid.question', 'Who are you?'); await service.tick();
    expect(sends).toHaveLength(count);
    expect(agent.start).toHaveBeenCalledOnce();
    expect(api.admissionCount).toBe(1);
    expect(reactions).toEqual([
      { to: sender, messageId: 'wamid.question', emoji: '👀' },
      { to: sender, messageId: 'wamid.question', emoji: '✅' },
    ]);
  });
  it('rejects forged events, unauthenticated owners, foreign origins and oversized bodies', async () => {
    expect((await routes.request('/whatsapp/webhook', { method: 'POST', body: event('wamid.bad', 'hi') })).status).toBe(401);
    expect((await call('/api/whatsapp/claim', { token: 'a'.repeat(43) }, 'bad')).status).toBe(401);
    expect((await call('/api/whatsapp/claim', { token: 'a'.repeat(43) }, 'owner-token', 'https://evil.example')).status).toBe(403);
    expect((await routes.request('/whatsapp/webhook', { method: 'POST', body: 'x'.repeat(262145) })).status).toBe(413);
  });
  it('verifies Meta challenge without leaking secrets and serves a branded no-referrer linking page', async () => {
    expect((await routes.request('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status).toBe(403);
    const challenge = await routes.request('/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=123');
    expect(await challenge.text()).toBe('123');
    const page = await routes.request('/whatsapp/connect');
    expect(page.status).toBe(200);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Connect my agent');
  });
  it('blocks expired reply windows and disconnect stops pending runs', async () => {
    await webhook('wamid.expire', 'hi'); now += 86_400_000;
    await service.tick(); expect(sends).toHaveLength(0);
    const { token } = await repo.startLink(sender, 'link');
    await repo.claim(token, owner);
    const proof = await repo.lease();
    const code = String(proof!.payload.text).match(/\b\d{6}\b/)![0];
    await repo.finish(proof!.id, proof!.fence, 'complete');
    await repo.confirm(token, owner, code, 'whatsapp-general-agent-v1');
    await service.tick();
    expect(sends.at(-1)?.text).toContain('connected to WhatsApp');
    sends = [];
    await webhook('wamid.stop', 'STOP'); await service.tick();
    expect(await repo.getConnection(owner)).toBeNull();
    expect(agent.start).not.toHaveBeenCalled();
  });
});
