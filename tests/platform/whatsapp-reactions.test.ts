import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWhatsAppConfig } from '../../packages/platform/src/whatsapp/config.js';
import { sendWhatsAppReaction } from '../../packages/platform/src/whatsapp/cloud-api.js';
import { createWhatsAppService } from '../../packages/platform/src/whatsapp/service.js';

const phone = '46701234567';
const config = readWhatsAppConfig({ WHATSAPP_APP_SECRET: 'app-secret', WHATSAPP_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_ACCESS_TOKEN: 'private-token', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_ENCRYPTION_KEY: 'a'.repeat(64), WHATSAPP_PUBLIC_URL: 'https://app.example.com', WHATSAPP_ALLOWED_SENDERS: phone })!;
const now = Date.UTC(2026, 9, 3, 12);
const owner = 'user_owner';
const connection = { id: 'connection', owner, sender: phone, chatId: 'chat_1', machineId: 'machine_1', consentVersion: 'whatsapp-general-agent-v1' };
const checkpoint = { machineId: 'machine_1', chatId: 'chat_1', runId: 'run_1' };
type Dependencies = Parameters<typeof createWhatsAppService>[0];
const repo = { cleanup: vi.fn(), lease: vi.fn(), finish: vi.fn(), markSending: vi.fn(), checkpoint: vi.fn(),
  retry: vi.fn(), getConnectionBySender: vi.fn(), getConnection: vi.fn(), bindChat: vi.fn(), enqueue: vi.fn() };
const agent = { start: vi.fn(), poll: vi.fn() };
const react = vi.fn(async () => {});
const send = vi.fn(async () => 'wamid.reply');
const logError = vi.fn();
let service: ReturnType<typeof createWhatsAppService>;
beforeEach(() => {
  vi.resetAllMocks();
  repo.lease.mockResolvedValue(null); repo.getConnectionBySender.mockResolvedValue(connection); repo.getConnection.mockResolvedValue(connection);
  for (const fn of [repo.finish, repo.markSending, repo.checkpoint, repo.retry, repo.enqueue]) fn.mockResolvedValue(true);
  agent.start.mockResolvedValue(checkpoint); agent.poll.mockResolvedValue({ state: 'complete', text: 'Hello!' });
  send.mockResolvedValue('wamid.reply');
  service = createWhatsAppService({ config, repository: repo as unknown as Dependencies['repository'], agent, react, send, logError, now: () => now });
});
afterEach(async () => { await service.shutdown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function work(payload: Record<string, unknown>, overrides = {}) {
  const job = { id: 'wamid.incoming', sender: phone, fence: 'fence', attempts: 1, expiresAt: now + 60_000, payload, ...overrides };
  repo.lease.mockResolvedValueOnce(job); await service.tick(); return job;
}
const incoming = () => ({ kind: 'incoming', type: 'text', text: 'Hi', timestamp: now / 1000, owner, connectionId: connection.id });
const run = () => ({ kind: 'run', owner, connectionId: connection.id, checkpoint });

describe('WhatsApp processing reactions', () => {
  it('reacts with eyes before admitting a verified agent request', async () => {
    await work(incoming());
    expect(react).toHaveBeenCalledExactlyOnceWith(phone, 'wamid.incoming', '👀');
    expect(react.mock.invocationCallOrder[0]).toBeLessThan(agent.start.mock.invocationCallOrder[0]!);
  });
  it('does not let a worker with a stale lease overwrite a completed reaction', async () => {
    repo.checkpoint.mockResolvedValue(false);
    await work(incoming());
    expect(react).not.toHaveBeenCalled(); expect(agent.start).not.toHaveBeenCalled();
  });
  it('sets a checkmark only after successfully delivering the completed response', async () => {
    const job = await work(run());
    expect(job.payload).toMatchObject({ kind: 'reply', reaction: '✅' });
    expect(react).toHaveBeenCalledExactlyOnceWith(phone, 'wamid.incoming', '✅');
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(react.mock.invocationCallOrder[0]!);
  });
  it('keeps pending runs working and marks attention without a success checkmark', async () => {
    agent.poll.mockResolvedValueOnce({ state: 'pending' }); await work(run());
    expect(react).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    agent.poll.mockResolvedValueOnce({ state: 'attention' }); await work(run());
    expect(react).toHaveBeenCalledExactlyOnceWith(phone, 'wamid.incoming', '❌');
  });
  it('reaction failure never fails admission or replays an accepted text response', async () => {
    react.mockRejectedValue(new Error('Reaction unavailable'));
    await work(incoming()); expect(agent.start).toHaveBeenCalledOnce();
    await work(run()); expect(send).toHaveBeenCalledOnce();
    expect(repo.finish).toHaveBeenCalledWith('wamid.incoming', 'fence', 'complete');
    expect(repo.retry).toHaveBeenCalledTimes(1); expect(logError).toHaveBeenCalledTimes(2);
  });
  it('does not react to failed text delivery, linking acknowledgements or stale associations', async () => {
    send.mockRejectedValueOnce(new Error('Delivery uncertain')); await work(run());
    expect(react).not.toHaveBeenCalled();
    await work({ kind: 'reply', owner, connectionId: connection.id, text: 'Account connected' });
    expect(react).not.toHaveBeenCalled();
    repo.getConnectionBySender.mockResolvedValue({ ...connection, id: 'new-association' });
    await work(incoming()); await work(run()); expect(react).not.toHaveBeenCalled();
  });
  it('rechecks association after eyes before starting the agent', async () => {
    react.mockImplementationOnce(async () => { repo.getConnectionBySender.mockResolvedValue(null); });
    await work(incoming()); expect(agent.start).not.toHaveBeenCalled();
  });
  it('ignores incoming reactions without queueing text warnings or agent turns', async () => {
    await service.ingest([{ id: 'wamid.reaction', sender: phone, timestamp: now / 1000, type: 'reaction' }]);
    expect(repo.enqueue).not.toHaveBeenCalled();
    await work({ ...incoming(), type: 'reaction', text: undefined });
    expect(send).not.toHaveBeenCalled(); expect(agent.start).not.toHaveBeenCalled(); expect(react).not.toHaveBeenCalled();
  });
  it('restores a pending completion reaction from the durable reply checkpoint', async () => {
    await work({ kind: 'reply', owner, connectionId: connection.id, text: 'Hello!', reaction: '✅', phone }, { sender: 'SE.opaqueAccount' });
    expect(react).toHaveBeenCalledExactlyOnceWith(phone, 'wamid.incoming', '✅');
  });
  it('never reports success after a lost finish fence, expired job or disconnect during delivery', async () => {
    repo.finish.mockResolvedValueOnce(false); await work(run());
    expect(react).not.toHaveBeenCalled();
    await work(incoming(), { expiresAt: now });
    expect(react).not.toHaveBeenCalled(); expect(agent.start).not.toHaveBeenCalled();
    send.mockImplementationOnce(async () => { repo.getConnectionBySender.mockResolvedValue(null); return 'wamid.reply'; });
    await work(run()); expect(react).not.toHaveBeenCalled();
  });
  it('marks exhausted agent failures without pretending the request succeeded', async () => {
    agent.start.mockRejectedValueOnce(new Error('Unavailable'));
    await work({ ...incoming(), failures: 4 });
    expect(react.mock.calls).toEqual([
      [phone, 'wamid.incoming', '👀'], [phone, 'wamid.incoming', '❌'],
    ]);
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('official WhatsApp reaction transport', () => {
  it.each(['👀', '✅', '❌'] as const)('sends bounded %s updates on the original message', async (emoji) => {
    const fetcher = vi.fn(async () => Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.reaction' }] }));
    await expect(sendWhatsAppReaction(config, phone, 'wamid.original', emoji, fetcher)).resolves.toBe('wamid.reaction');
    const [url, options] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v25.0/123456/messages');
    expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.redirect).toBe('error');
    expect(JSON.parse(String(options.body))).toMatchObject({ to: phone, type: 'reaction', reaction: { message_id: 'wamid.original', emoji } });
  });
  it('rejects invalid recipients, message IDs and arbitrary emoji without calling Meta', async () => {
    const fetcher = vi.fn();
    for (const [recipient, id, emoji] of [['12025550123', 'wamid.test', '👀'], [phone, '../invalid id', '👀'], [phone, 'wamid.test', 'secret text']]) {
      await expect(sendWhatsAppReaction(config, recipient!, id!, emoji! as '👀', fetcher)).rejects.toMatchObject({ ambiguous: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry ambiguous reaction calls', async () => {
    const fetcher = vi.fn(async () => { throw new Error('private transport detail'); });
    await expect(sendWhatsAppReaction(config, phone, 'wamid.test', '👀', fetcher)).rejects.toMatchObject({ ambiguous: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('caps a stalled reaction request at 1.5 seconds without retrying', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn((_url: string | URL | Request, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    await expect(sendWhatsAppReaction(config, phone, 'wamid.test', '👀', fetcher)).rejects.toMatchObject({ ambiguous: true });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(1500);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
