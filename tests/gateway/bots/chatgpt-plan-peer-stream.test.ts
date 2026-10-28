import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS, chatGptPlanPeerProof } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { createChatGptPlanPeers } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';
import { createChatGptPlanPeerRoutes } from '../../../packages/gateway/src/bots/chatgpt-plan-peer-routes.js';
import { markVerifiedRuntimeBearer } from '../../../packages/gateway/src/request-principal.js';
import { createBotStateDatabase } from './bot-state-support.js';

describe('ChatGPT subscription peer streaming', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function connected() {
    const db = await createBotStateDatabase();
    cleanups.push(db.destroy);
    const peer = createChatGptPlanPeers({ db: db.db, ownerId: 'owner', computerId: 'computer', now: () => 1_000_000 });
    cleanups.push(() => peer.close());
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const snapshot = {
      deviceId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'),
      accountId: 'account_own', grantRevision: 3, enabled: true, background: false,
      models: [{ id: 'gpt-server', displayName: 'Server model', input: ['text' as const], contextWindow: 128_000, maxOutputTokens: 8_192 }],
    };
    const challenge = peer.challenge('owner');
    const session = await peer.connect('owner', {
      version: 1, challenge: challenge.challenge, publicKey, snapshot,
      signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString('base64url'),
    });
    const selected = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [
      { id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' },
    ] }, 'owner', 'interactive');
    const binding = { ownerId: 'owner', runId: 'run_stream', requestClass: 'interactive', ...selected } as never;
    const reconnect = async () => {
      const next = peer.challenge('owner');
      return peer.connect('owner', { version: 1, challenge: next.challenge, publicKey, snapshot,
        signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...next, snapshot })), keys.privateKey).toString('base64url'),
      });
    };
    return { peer, session, binding, reconnect };
  }

  it('returns a stream before the first chunk and acknowledges only a consumed chunk', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    expect(response).toMatchObject({ status: 200, headers: { 'content-type': 'text/event-stream' } });
    const request = (await peer.poll('owner', session)).requests[0]!;
    expect(request).toMatchObject({ action: 'infer', responseMode: 'stream' });

    let acknowledged = false;
    const first = peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: first\n\n' });
    void Promise.resolve(first).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 1, body: 'data: second\n\n' })).toThrow('conflict');

    const iterator = response.body[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 'data: first\n\n', done: false });
    await first;
    expect(acknowledged).toBe(true);
    const second = peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 1, body: 'data: second\n\n' });
    expect(await iterator.next()).toEqual({ value: 'data: second\n\n', done: false });
    await second;
    expect(peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 2 })).toEqual({ version: 1, ok: true, sessionId: session.sessionId, id: request.id, sequence: 2 });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 2 })).toThrow('conflict');
  });

  it('cancels an unconsumed chunk and frees its bounded inference slot', async () => {
    const { peer, session, binding } = await connected();
    const streams = await Promise.all(Array.from({ length: 4 }, () => peer.inferStream(binding, '{}', new AbortController().signal)));
    const requests = (await peer.poll('owner', session)).requests;
    expect(requests).toHaveLength(4);
    await expect(peer.inferStream(binding, '{}', new AbortController().signal)).rejects.toThrow('unavailable');

    const firstAck = peer.reply('owner', { ...session, id: requests[0]!.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: held\n\n' });
    const rejectedAck = expect(firstAck).rejects.toThrow('unavailable');
    await streams[0]!.body[Symbol.asyncIterator]().return?.();
    await rejectedAck;
    expect((await peer.poll('owner', session)).requests).toContainEqual({ version: 1, action: 'cancel', id: requests[0]!.id });
    expect(() => peer.reply('owner', { ...session, id: requests[0]!.id, ok: true, stream: 'end', sequence: 1 })).toThrow('conflict');
    const replacement = await peer.inferStream(binding, '{}', new AbortController().signal);
    expect(replacement.status).toBe(200);
    await replacement.body[Symbol.asyncIterator]().return?.();
  });

  it('rejects out-of-order and premature terminal frames without losing the current stream', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 1, body: 'wrong' })).toThrow('conflict');
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 1 })).toThrow('conflict');
    const firstAck = peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: valid\n\n' });
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 1 })).toThrow('conflict');
    const iterator = response.body[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 'data: valid\n\n', done: false });
    await firstAck;
    expect(peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 1 })).toMatchObject({ id: request.id, sequence: 1 });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('holds the authenticated reply HTTP response until the gateway consumer pulls its chunk', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    const app = new Hono();
    app.use('*', async (c, next) => { markVerifiedRuntimeBearer(c); await next(); });
    app.route('/', createChatGptPlanPeerRoutes({ peers: peer, getPrincipal: () => ({ userId: 'owner', source: 'jwt' }) }));
    let settled = false;
    const posted = app.request('/api/chatgpt-plan/device/reply', { method: 'POST', headers: {
      authorization: 'Bearer fixture', 'content-type': 'application/json',
    }, body: JSON.stringify({ ...session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: route\n\n' }) }).then(value => { settled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await response.body[Symbol.asyncIterator]().next()).toEqual({ value: 'data: route\n\n', done: false });
    const result = await posted;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ version: 1, ok: true, sessionId: session.sessionId, id: request.id, sequence: 0 });
  });

  it('rejects waiting readers and unacknowledged replies when the native session disconnects', async () => {
    const { peer, session, binding } = await connected();
    const [reading, buffered] = await Promise.all([
      peer.inferStream(binding, '{}', new AbortController().signal),
      peer.inferStream(binding, '{}', new AbortController().signal),
    ]);
    const [readRequest, bufferedRequest] = (await peer.poll('owner', session)).requests;
    const waitingRead = expect(reading.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    const waitingAck = expect(peer.reply('owner', { ...session, id: bufferedRequest!.id, ok: true,
      stream: 'chunk', sequence: 0, body: 'data: held\n\n' })).rejects.toThrow('unavailable');
    peer.disconnect('owner', session);
    await Promise.all([waitingRead, waitingAck]);
    expect(() => peer.reply('owner', { ...session, id: readRequest!.id, ok: true, stream: 'end', sequence: 0 })).toThrow('unavailable');
    await expect(peer.inferStream(binding, '{}', new AbortController().signal)).rejects.toThrow('unavailable');
    await buffered.body[Symbol.asyncIterator]().return?.();
  });

  it('expires empty-chunk inactivity, releases admission, and refuses late success', async () => {
    const { peer, session, binding } = await connected();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    const waitingAck = expect(peer.reply('owner', { ...session, id: request.id, ok: true,
      stream: 'chunk', sequence: 0, body: '' })).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS);
    await waitingAck;
    await expect(response.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    expect((await peer.poll('owner', session)).requests).toEqual([{ version: 1, action: 'cancel', id: request.id }]);
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 1 })).toThrow('conflict');
    const replacement = await peer.inferStream(binding, '{}', new AbortController().signal);
    expect(replacement.status).toBe(200);
    await replacement.body[Symbol.asyncIterator]().return?.();
  });

  it('rejects a multi-byte chunk exceeding 64 KiB before advancing the stream sequence', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true,
      stream: 'chunk', sequence: 0, body: 'é'.repeat(32_769) })).toThrow('invalid_request');
    const iterator = response.body[Symbol.asyncIterator]();
    const waiting = iterator.next();
    const ack = peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: valid\n\n' });
    expect(await waiting).toEqual({ value: 'data: valid\n\n', done: false });
    await ack;
    expect(peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 1 })).toMatchObject({ sequence: 1 });
  });

  it('revokes an old stream and binding when the pinned device opens a new session', async () => {
    const { peer, session, binding, reconnect } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    const waitingAck = expect(peer.reply('owner', { ...session, id: request.id, ok: true,
      stream: 'chunk', sequence: 0, body: 'data: old\n\n' })).rejects.toThrow('unavailable');
    const newSession = await reconnect();
    expect(newSession.sessionId).not.toBe(session.sessionId);
    await waitingAck;
    await expect(response.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 1 })).toThrow('unavailable');
    await expect(peer.inferStream(binding, '{}', new AbortController().signal)).rejects.toThrow('unavailable');
    expect((await peer.observe('owner')).availability).toBe('available');
  });

  it('drains a held reply on shutdown and never acknowledges the former owner session', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    const frame = { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: 'data: held\n\n' };
    expect(() => peer.reply('other', frame)).toThrow('forbidden');
    const waitingAck = expect(peer.reply('owner', frame)).rejects.toThrow('unavailable');
    peer.close();
    await waitingAck;
    await expect(response.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    expect(() => peer.reply('owner', frame)).toThrow('unavailable');
  });
});
