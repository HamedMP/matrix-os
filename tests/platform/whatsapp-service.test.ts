import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWhatsAppService } from '../../packages/platform/src/whatsapp/service.js';
import { readWhatsAppConfig } from '../../packages/platform/src/whatsapp/config.js';
import { WhatsAppSendError } from '../../packages/platform/src/whatsapp/cloud-api.js';
import { createWhatsAppAgentClient } from '../../packages/platform/src/whatsapp/agent-client.js';
import type { WhatsAppConnection, WhatsAppJob } from '../../packages/platform/src/whatsapp/repository-types.js';
import { createWhatsAppRepository } from '../../packages/platform/src/whatsapp/repository.js';
import { decryptWhatsAppPayload } from '../../packages/platform/src/whatsapp/crypto.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { sql } from 'kysely';

const sender = '46701234567';
const owner = 'user_owner';
const config = readWhatsAppConfig({ WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_ACCESS_TOKEN: 'private-token', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_ENCRYPTION_KEY: 'a'.repeat(64), WHATSAPP_PUBLIC_URL: 'https://app.example.com', WHATSAPP_ALLOWED_SENDERS: sender })!;
const checkpoint = { machineId: 'machine_1', chatId: 'chat_1', runId: 'run_1' };
const connection: WhatsAppConnection = { id: 'connection_1', owner, sender, machineId: 'machine_1', chatId: 'chat_1', consentVersion: 'whatsapp-general-agent-v1' };
const repo = { cleanup: vi.fn(), lease: vi.fn(), getConnectionBySender: vi.fn(), getConnection: vi.fn(),
  enqueue: vi.fn(), stop: vi.fn(), isChallengeActive: vi.fn(), markSending: vi.fn(), finish: vi.fn(),
  checkpoint: vi.fn(), retry: vi.fn(), bindChat: vi.fn(), startLink: vi.fn() };
const agent = { start: vi.fn(), poll: vi.fn() };
const send = vi.fn();
const logError = vi.fn();
let now: number;
let service: ReturnType<typeof createWhatsAppService>;
type ServiceDependencies = Parameters<typeof createWhatsAppService>[0];
function compose(options: Partial<ServiceDependencies> = {}) {
  service = createWhatsAppService({ config, repository: repo as unknown as ServiceDependencies['repository'],
    agent, now: () => now, send, logError, ...options });
  return service;
}
function job(payload: Record<string, unknown>, options: Partial<WhatsAppJob> = {}): WhatsAppJob {
  return { id: 'wamid.message', sender, fence: 'fence_1', attempts: 1, expiresAt: now + 60_000, payload, ...options };
}
function incoming(text?: string, linked = true) {
  return { kind: 'incoming', type: 'text', timestamp: now / 1000, text,
    owner: linked ? owner : null, connectionId: linked ? connection.id : null };
}
function run(failures = 0) { return { kind: 'run', owner, connectionId: connection.id, checkpoint, failures }; }
async function process(payload: Record<string, unknown>, options: Partial<WhatsAppJob> = {}) {
  const value = job(payload, options); repo.lease.mockResolvedValueOnce(value);
  await service.tick(); return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks(); now = Date.UTC(2026, 9, 2, 12);
  repo.lease.mockResolvedValue(null); repo.getConnectionBySender.mockResolvedValue(connection);
  repo.getConnection.mockResolvedValue(connection); repo.isChallengeActive.mockResolvedValue(true);
  for (const fn of [repo.checkpoint, repo.markSending, repo.finish, repo.retry, repo.enqueue]) fn.mockResolvedValue(true);
  repo.startLink.mockResolvedValue({ token: 'link_token' }); repo.bindChat.mockResolvedValue(connection);
  agent.start.mockResolvedValue(checkpoint); agent.poll.mockResolvedValue({ state: 'pending' });
  send.mockResolvedValue('wamid.reply'); compose();
});
afterEach(async () => { await service.shutdown(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WhatsApp delivery boundaries', () => {
  it('rejects ineligible or stale identities and snapshots admitted association', async () => {
    await service.ingest([
      { id: 'bad-market', sender: '12025550123', type: 'text', timestamp: now / 1000 },
      { id: 'stale', sender, type: 'text', timestamp: now / 1000 - 86_401 },
      { id: 'allowed', sender, type: 'text', timestamp: now / 1000 - 10, text: 'Hello' },
    ]);
    expect(repo.enqueue).toHaveBeenCalledOnce();
    expect(repo.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'allowed',
      payload: expect.objectContaining({ owner, connectionId: connection.id }), expiresAt: now - 10_000 + 86_400_000 }));
  });
  it('admits a previously verified eligible BSUID when its phone disappears', async () => {
    await service.ingest([{ id: 'bsuid', sender: 'SE.opaque', type: 'text', timestamp: now / 1000 }]);
    expect(repo.enqueue).toHaveBeenCalledOnce();
    repo.getConnectionBySender.mockResolvedValue(null);
    await service.ingest([{ id: 'unlinked', sender: 'SE.other', type: 'text', timestamp: now / 1000 }]);
    expect(repo.enqueue).toHaveBeenCalledOnce();
    await service.ingest([{ id: 'fresh-unlinked', sender, type: 'text', timestamp: now / 1000 }]);
    expect(repo.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ owner: null, connectionId: null }) }));
  });
  it.each(['STOP', ' /disconnect '])('revokes immediately for %s without queueing agent work', async (text) => {
    await service.ingest([{ id: 'stop', sender, text, type: 'text', timestamp: now / 1000 }]);
    expect(repo.stop).toHaveBeenCalledWith(sender, 'stop', now + 86_400_000, now);
    expect(repo.enqueue).not.toHaveBeenCalled();
    await process(incoming(text)); expect(repo.stop).toHaveBeenCalledTimes(2); expect(agent.start).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'invalid' }, { kind: 'reply', text: '' }])('quarantines invalid durable payload %j', async (payload) => {
    await process(payload); expect(repo.finish).toHaveBeenCalledWith('wamid.message', 'fence_1', 'failed'); expect(send).not.toHaveBeenCalled();
  });
  it('does not deliver an expired job even when the payload is valid', async () => {
    await process({ kind: 'reply', text: 'Expired' }, { expiresAt: now }); expect(send).not.toHaveBeenCalled();
  });
  it.each(['HELP', undefined])('handles support or unsupported type locally: %s', async (text) => {
    await process({ ...incoming(text), type: text ? 'text' : 'image' });
    expect(agent.start).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toContain(text ? 'human help' : 'accepts text messages');
  });
  it('passes the original reply deadline into linking and never starts an unlinked greeting', async () => {
    const value = await process(incoming('Hello', false));
    expect(repo.startLink).toHaveBeenCalledWith(sender, value.id, value.expiresAt);
    expect(send).toHaveBeenCalledWith(sender, expect.stringContaining('/whatsapp/connect?token=link_token'));
    expect(agent.start).not.toHaveBeenCalled();
  });
  it('requires active sender proof before sending a verification code', async () => {
    repo.isChallengeActive.mockResolvedValue(false);
    await process({ kind: 'verification', owner, tokenHash: 'a'.repeat(64), text: '123456' });
    expect(repo.markSending).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('marks a live verification code sending before contacting WhatsApp', async () => {
    await process({ kind: 'verification', owner, tokenHash: 'a'.repeat(64), text: '123456' });
    expect(send).toHaveBeenCalledWith(sender, '123456');
    expect(repo.markSending.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(repo.finish).toHaveBeenCalledWith('wamid.message', 'fence_1', 'complete');
  });
  it.each([null, { ...connection, owner: 'other' }, { ...connection, id: 'new_epoch' }, { ...connection, consentVersion: 'old' }])(
    'never executes or replies for a revoked or mismatched connection: %j', async (current) => {
      repo.getConnectionBySender.mockResolvedValue(current);
      await process(run()); await process(incoming('Do work')); await process({ kind: 'reply', text: 'Private result', owner, connectionId: connection.id });
      expect(agent.start).not.toHaveBeenCalled(); expect(agent.poll).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    },
  );
  it('refuses sends when the durable fence is lost', async () => {
    repo.markSending.mockResolvedValue(false);
    await process({ kind: 'reply', text: 'Late worker' }); expect(send).not.toHaveBeenCalled(); expect(repo.finish).not.toHaveBeenCalled();
  });
  it.each([[new WhatsAppSendError(false), 'failed'], [new WhatsAppSendError(true), 'unknown'], [new Error('broken connection'), 'unknown']])(
    'makes rejected and ambiguous sends terminal: %j', async (error, terminal) => {
      send.mockRejectedValue(error); await process({ kind: 'reply', text: 'Result' });
      expect(repo.finish).toHaveBeenCalledWith('wamid.message', 'fence_1', terminal);
      expect(repo.retry).not.toHaveBeenCalled(); expect(logError).toHaveBeenCalledWith(error);
    },
  );
  it('sends a stored BSUID reply through the configured official transport', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ messages: [{ id: 'wamid.reply' }] }));
    vi.stubGlobal('fetch', fetcher); compose({ send: undefined });
    await process({ kind: 'reply', text: 'Result' }, { sender: 'SE.opaque' });
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.recipient).toBe('SE.opaque'); expect(body.to).toBeUndefined();
  });
});

describe('WhatsApp agent checkpoint and retry lifecycle', () => {
  it.each(['fetch', 'stream'])('logs the real client %s failure cause while sending only safe recovery text', async (failure) => {
    const diagnostic = new Error('private-token at /private/runtime connection failure');
    const fetcher = vi.fn(async () => {
      if (failure === 'fetch') throw diagnostic;
      return new Response(new ReadableStream({ start(controller) { controller.error(diagnostic); } }));
    });
    const client = createWhatsAppAgentClient(async () => ({ machineId: checkpoint.machineId,
      gatewayUrl: 'https://runtime.example', token: 'runtime-owner-token' }), fetcher);
    compose({ agent: client });
    await process(run(4));
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'request_failed', message: 'Matrix is temporarily unavailable.', cause: diagnostic,
    }));
    expect(send).toHaveBeenCalledWith(sender, expect.stringContaining('temporarily unavailable'));
    expect(send.mock.calls[0]![1]).not.toContain(diagnostic.message);
    expect(send.mock.calls[0]![1]).not.toContain('private-token');
  });
  it.each(['run release', 'pending poll release', 'reply admission', 'uncertain run checkpoint', 'uncertain reply checkpoint'])(
    'keeps persisted progress through %s failure without restarting the agent', async (failure) => {
      const { db } = await createTestPlatformDb();
      const durable = createWhatsAppRepository(db, config.encryptionKey, () => now);
      const runtime = createWhatsAppService({ config, repository: durable, agent, send, logError, now: () => now });
      const spies: Array<{ mockRestore(): void }> = [];
      try {
        await sql`INSERT INTO whatsapp_connections(id,owner,sender,machine_id,chat_id,consent_version,created_at)
          VALUES(${connection.id},${owner},${sender},${checkpoint.machineId},${checkpoint.chatId},${connection.consentVersion},${now})`.execute(db.kysely);
        const replyStage = failure.includes('reply');
        const pendingRun = failure === 'pending poll release';
        agent.poll.mockResolvedValue(replyStage ? { state: 'complete', text: 'Saved private result' } : { state: 'pending' });
        await durable.enqueue({ id: 'wamid.progress', sender, payload: replyStage || pendingRun ? run(pendingRun ? 4 : 0) : incoming('Do work'), expiresAt: now + 120_000 });
        const diagnostic = new Error('Database response unavailable');
        if (failure.endsWith('release')) spies.push(vi.spyOn(durable, 'retry').mockRejectedValueOnce(diagnostic));
        else if (failure === 'reply admission') spies.push(vi.spyOn(durable, 'markSending').mockRejectedValueOnce(diagnostic));
        else {
          const original = durable.checkpoint;
          let interrupted = false;
          spies.push(vi.spyOn(durable, 'checkpoint').mockImplementation(async (id, fence, payload) => {
            const saved = await original(id, fence, payload);
            if (!interrupted && payload.kind === (replyStage ? 'reply' : 'run')) {
              interrupted = true;
              throw diagnostic;
            }
            return saved;
          }));
        }
        await runtime.tick();
        const persisted = await sql<{ payload: string; state: string }>`SELECT payload,state FROM whatsapp_jobs WHERE id='wamid.progress'`.execute(db.kysely);
        const payload = decryptWhatsAppPayload(persisted.rows[0]!.payload, Buffer.from(config.encryptionKey, 'hex'));
        expect(payload.kind).toBe(replyStage ? 'reply' : 'run');
        expect(payload.failures).toBe(failure.startsWith('uncertain') ? undefined : 1);
        expect(send).not.toHaveBeenCalled();
        expect(agent.start).toHaveBeenCalledTimes(replyStage || pendingRun ? 0 : 1);
        now += failure.startsWith('uncertain') ? 60_001 : 2001;
        await runtime.tick();
        expect(agent.start).toHaveBeenCalledTimes(replyStage || pendingRun ? 0 : 1);
        expect(agent.poll).toHaveBeenCalledTimes(pendingRun ? 2 : 1);
        if (replyStage) expect(send).toHaveBeenCalledExactlyOnceWith(sender, 'Saved private result');
        else expect(send).not.toHaveBeenCalled();
      } finally {
        await runtime.shutdown();
        for (const spy of spies) spy.mockRestore();
        await destroyTestPlatformDb(db);
      }
    },
  );
  it('releases pending polls for two seconds and clears previous failures', async () => {
    await process(run(3));
    expect(repo.checkpoint).toHaveBeenCalledWith('wamid.message', 'fence_1', expect.objectContaining({ failures: 0 }));
    expect(repo.retry).toHaveBeenCalledWith('wamid.message', 'fence_1', 2000); expect(send).not.toHaveBeenCalled();
  });
  it('does not retry pending work when its checkpoint fence fails', async () => {
    repo.checkpoint.mockResolvedValue(false); await process(run()); expect(repo.retry).not.toHaveBeenCalled();
  });
  it.each([{ state: 'attention' }, { state: 'complete', text: 'Your answer' }, { state: 'complete', text: '' }])(
    'delivers only terminal result or Matrix attention: %j', async (result) => {
      agent.poll.mockResolvedValue(result); await process(run()); expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]![1]).toContain(result.state === 'attention' ? 'needs your attention' : result.text || 'agent finished');
    },
  );
  it('binds an admitted run to its verified epoch and checks consent immediately before dispatch', async () => {
    agent.start.mockImplementation(async (_input, authorize) => { expect(await authorize()).toBe(true); return checkpoint; });
    await process(incoming('Do work'));
    expect(repo.bindChat).toHaveBeenCalledWith(owner, sender, checkpoint.machineId, checkpoint.chatId, connection.id);
    expect(repo.checkpoint).toHaveBeenCalledWith('wamid.message', 'fence_1', expect.objectContaining({ kind: 'run', checkpoint }));
    expect(repo.retry).toHaveBeenCalledWith('wamid.message', 'fence_1', 0);
  });
  it('passes the expected old Chat only for recovery and persists a plain run checkpoint', async () => {
    agent.start.mockResolvedValue({ ...checkpoint, chatId: 'chat_replacement', replacedChatId: connection.chatId });
    const value = await process(incoming('Do work'));
    expect(repo.bindChat).toHaveBeenCalledWith(owner, sender, checkpoint.machineId, 'chat_replacement', connection.id, connection.chatId);
    expect(value.payload).toEqual({ kind: 'run', owner, connectionId: connection.id,
      checkpoint: { machineId: checkpoint.machineId, chatId: 'chat_replacement', runId: checkpoint.runId } });
    expect(value.payload).not.toHaveProperty('checkpoint.replacedChatId');
  });
  it('does not bind a result when the owner disconnects during dispatch', async () => {
    agent.start.mockImplementation(async () => { repo.getConnectionBySender.mockResolvedValue(null); return checkpoint; });
    await process(incoming('Do work')); expect(repo.bindChat).not.toHaveBeenCalled(); expect(repo.retry).not.toHaveBeenCalled();
  });
  it('does not start work when the initial fence is lost', async () => {
    repo.checkpoint.mockResolvedValue(false); await process(incoming('Do work')); expect(agent.start).not.toHaveBeenCalled();
  });
  it('does not retry an admitted run when checkpoint persistence lost its fence', async () => {
    repo.checkpoint.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await process(incoming()); expect(repo.bindChat).toHaveBeenCalledOnce(); expect(repo.retry).not.toHaveBeenCalled();
  });
  it.each([undefined, -1, 2, 4])('bounds agent failures and returns safe recovery after exhaustion: %s', async (failures) => {
    agent.poll.mockRejectedValue(new Error('private provider diagnostic'));
    await process({ ...run(), failures });
    if (failures === 4) {
      expect(send).toHaveBeenCalledWith(sender, expect.stringContaining('temporarily unavailable'));
      expect(send.mock.calls[0]![1]).not.toContain('private provider diagnostic'); expect(repo.retry).not.toHaveBeenCalled();
    } else {
      expect(repo.retry).toHaveBeenCalledWith('wamid.message', 'fence_1', failures === 2 ? 8000 : 2000); expect(send).not.toHaveBeenCalled();
    }
  });
  it('does not retry a failed agent operation under a stale fence', async () => {
    agent.poll.mockRejectedValue(new Error('agent failed')); repo.checkpoint.mockResolvedValue(false);
    await process(run()); expect(repo.retry).not.toHaveBeenCalled();
  });
  it('terminates exhausted unlinked work rather than generating repeated linking replies', async () => {
    repo.startLink.mockRejectedValue(new Error('unavailable'));
    await process({ ...incoming('Hello', false), failures: 4 });
    expect(repo.finish).toHaveBeenCalledWith('wamid.message', 'fence_1', 'failed'); expect(send).not.toHaveBeenCalled();
  });
});

describe('WhatsApp worker scheduling and shutdown', () => {
  it('does not overlap concurrent ticks and shutdown waits for the active operation', async () => {
    const pending = deferred<null>(); repo.lease.mockReturnValue(pending.promise);
    const first = service.tick(); const second = service.tick();
    await vi.waitFor(() => expect(repo.lease).toHaveBeenCalledOnce());
    let closed = false; const closing = service.shutdown().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    pending.resolve(null); await Promise.all([first, second, closing]);
    await service.tick(); service.start(); expect(repo.lease).toHaveBeenCalledOnce();
  });
  it('schedules one recurring timer and performs bounded recurring cleanup', async () => {
    vi.useFakeTimers(); service.start(); service.start(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); expect(repo.lease).toHaveBeenCalledOnce(); expect(repo.cleanup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(repo.cleanup).toHaveBeenCalledOnce();
    now += 60_000; await vi.advanceTimersByTimeAsync(1000); expect(repo.cleanup).toHaveBeenCalledTimes(2);
    await service.shutdown(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000); expect(repo.lease).toHaveBeenCalledTimes(3);
  });
  it('logs cleanup failures and permits the next tick to recover', async () => {
    const error = new Error('private database diagnostic'); repo.cleanup.mockRejectedValueOnce(error);
    await service.tick(); expect(logError).toHaveBeenCalledWith(error); expect(repo.lease).not.toHaveBeenCalled();
    await service.tick(); expect(repo.lease).toHaveBeenCalledOnce();
  });
  it('uses a server log by default when its queue dependency fails', async () => {
    const error = new Error('queue unavailable'); const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    compose({ logError: undefined }); repo.lease.mockRejectedValue(error); await service.tick();
    expect(spy).toHaveBeenCalledWith('[whatsapp] Delivery failed', error); spy.mockRestore();
  });
});
