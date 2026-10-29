import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatGptPlanPeerProof } from '@matrix-os/contracts';
import { createChatGptPlanPeers } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';
import { createBotStateDatabase } from './bot-state-support.js';

describe('ChatGPT subscription peer stream inactivity', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.useRealTimers();
  });

  async function connected() {
    const db = await createBotStateDatabase();
    cleanups.push(db.destroy);
    // Keep device presence independent from the inference timer under test.
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
    peer.capabilities('owner', session, false, true);
    const selected = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [
      { id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' },
    ] }, 'owner', 'interactive');
    const binding = { ownerId: 'owner', runId: 'run_stream_idle', requestClass: 'interactive', ...selected } as never;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const revoke = async () => {
      const next = peer.challenge('owner');
      const revoked = { ...snapshot, enabled: false, grantRevision: 4 };
      return peer.connect('owner', { version: 1, challenge: next.challenge, publicKey, snapshot: revoked,
        signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...next, snapshot: revoked })), keys.privateKey).toString('base64url'),
      });
    };
    return { peer, session, binding, revoke };
  }

  async function backpressured() {
    const fixture = await connected();
    const stop = new AbortController();
    const response = await fixture.peer.inferStream(fixture.binding, '{}', stop.signal);
    const request = (await fixture.peer.poll('owner', fixture.session)).requests[0]!;
    const body = 'data: held valid output\n\n';
    const ack = fixture.peer.reply('owner', { ...fixture.session, id: request.id, ok: true,
      stream: 'chunk', sequence: 0, body });
    let ackSettled = false;
    // Observe rejections immediately; RED must report the premature expiry,
    // rather than an unhandled rejection from the intentionally held reply.
    void Promise.resolve(ack).then(() => { ackSettled = true; }, () => { ackSettled = true; });
    return { ...fixture, stop, request, body, ack, acknowledged: () => ackSettled,
      iterator: response.body[Symbol.asyncIterator]() };
  }

  it('keeps an ordered active stream alive beyond 120 seconds and accepts its EOF', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    const iterator = response.body[Symbol.asyncIterator]();

    for (let sequence = 0; sequence < 3; sequence++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const body = `data: active-${sequence}\n\n`;
      const ack = peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence, body });
      expect(await iterator.next()).toEqual({ value: body, done: false });
      await ack;
    }

    expect(peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 3 }))
      .toMatchObject({ id: request.id, sequence: 3 });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('expires after a full 120 seconds without stream activity and frees admission', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    let settled = false;
    const read = response.body[Symbol.asyncIterator]().next();
    void read.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(read).rejects.toThrow('unavailable');

    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect((await peer.poll('owner', session)).requests).toEqual([{ version: 1, action: 'cancel', id: request.id }]);
    expect(vi.getTimerCount()).toBe(0);
    const replacement = await peer.inferStream(binding, '{}', new AbortController().signal);
    await replacement.body[Symbol.asyncIterator]().return?.();
  });

  it('does not renew stream inactivity for a consumed empty chunk', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    const iterator = response.body[Symbol.asyncIterator]();
    await vi.advanceTimersByTimeAsync(60_000);
    const ack = peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 0, body: '' });
    expect(await iterator.next()).toEqual({ value: '', done: false });
    await ack;
    const rejected = expect(iterator.next()).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect((await peer.poll('owner', session)).requests).toEqual([{ version: 1, action: 'cancel', id: request.id }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew stream inactivity for an out-of-order chunk', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'chunk', sequence: 1, body: 'data: invalid\n\n' }))
      .toThrow('conflict');
    const rejected = expect(response.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['Stop', 'revoke', 'shutdown'] as const)('%s drains readers and held acknowledgements and clears idle timers', async cause => {
    const { peer, session, binding, revoke } = await connected();
    const stop = new AbortController();
    const [reading, buffered] = await Promise.all([
      peer.inferStream(binding, '{}', stop.signal),
      peer.inferStream(binding, '{}', stop.signal),
    ]);
    const requests = (await peer.poll('owner', session)).requests;
    const readRejected = expect(reading.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    const ackRejected = expect(peer.reply('owner', { ...session, id: requests[1]!.id, ok: true,
      stream: 'chunk', sequence: 0, body: 'data: held\n\n' })).rejects.toThrow('unavailable');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    if (cause === 'Stop') stop.abort();
    else if (cause === 'revoke') await revoke();
    else peer.close();

    await Promise.all([readRejected, ackRejected]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(buffered.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    expect(() => peer.reply('owner', { ...session, id: requests[0]!.id, ok: true, stream: 'end', sequence: 0 })).toThrow();
    if (cause === 'revoke') expect(await peer.revalidate(binding, new AbortController().signal)).toBe(false);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its idle timer and Stop listener at EOF without queuing a late cancel', async () => {
    const { peer, session, binding } = await connected();
    const stop = new AbortController();
    const response = await peer.inferStream(binding, '{}', stop.signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    peer.reply('owner', { ...session, id: request.id, ok: true, stream: 'end', sequence: 0 });
    expect(await response.body[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
    expect(vi.getTimerCount()).toBe(0);
    stop.abort();
    await vi.advanceTimersByTimeAsync(240_000);
    const poll = peer.poll('owner', session);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await poll).requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the four-request admission cap and 120-second absolute deadline for legacy replies', async () => {
    const { peer, session, binding } = await connected();
    const legacy = Array.from({ length: 4 }, () => peer.infer(binding, '{}', new AbortController().signal));
    const rejected = legacy.map(pending => expect(pending).rejects.toThrow('unavailable'));
    const requests = (await peer.poll('owner', session)).requests;
    expect(requests).toHaveLength(4);
    await expect(peer.inferStream(binding, '{}', new AbortController().signal)).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.all(rejected);
    expect((await peer.poll('owner', session)).requests).toEqual(requests.map(request => ({ version: 1, action: 'cancel', id: request.id })));
    expect(vi.getTimerCount()).toBe(0);
    const replacement = await peer.inferStream(binding, '{}', new AbortController().signal);
    await replacement.body[Symbol.asyncIterator]().return?.();
  });

  it('preserves a nonempty chunk under downstream backpressure beyond 120 seconds and accepts EOF after consumption', async () => {
    const held = await backpressured();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(held.acknowledged()).toBe(false);
    expect(() => held.peer.reply('owner', { ...held.session, id: held.request.id, ok: true,
      stream: 'chunk', sequence: 1, body: 'data: cannot queue a second chunk\n\n' })).toThrow('conflict');
    expect(await held.iterator.next()).toEqual({ value: held.body, done: false });
    await held.ack;
    expect(held.peer.reply('owner', { ...held.session, id: held.request.id, ok: true, stream: 'end', sequence: 1 }))
      .toMatchObject({ id: held.request.id, sequence: 1 });
    expect(await held.iterator.next()).toEqual({ value: undefined, done: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a fresh 120-second idle interval when a backpressured nonempty chunk is consumed', async () => {
    const held = await backpressured();
    await vi.advanceTimersByTimeAsync(240_000);
    expect(held.acknowledged()).toBe(false);
    expect(await held.iterator.next()).toEqual({ value: held.body, done: false });
    await held.ack;
    let settled = false;
    const read = held.iterator.next();
    void read.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(read).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect((await held.peer.poll('owner', held.session)).requests)
      .toEqual([{ version: 1, action: 'cancel', id: held.request.id }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['Stop', 'revoke', 'shutdown'] as const)('%s still cancels a chunk backpressured for more than 120 seconds', async cause => {
    const held = await backpressured();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(held.acknowledged()).toBe(false);
    const rejected = expect(held.ack).rejects.toThrow('unavailable');
    if (cause === 'Stop') held.stop.abort();
    else if (cause === 'revoke') await held.revoke();
    else held.peer.close();
    await rejected;
    await expect(held.iterator.next()).rejects.toThrow('unavailable');
    expect(() => held.peer.reply('owner', { ...held.session, id: held.request.id, ok: true, stream: 'end', sequence: 1 })).toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not pause inactivity for an unconsumed empty chunk', async () => {
    const { peer, session, binding } = await connected();
    const response = await peer.inferStream(binding, '{}', new AbortController().signal);
    const request = (await peer.poll('owner', session)).requests[0]!;
    await vi.advanceTimersByTimeAsync(60_000);
    const rejected = expect(peer.reply('owner', { ...session, id: request.id, ok: true,
      stream: 'chunk', sequence: 0, body: '' })).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    await expect(response.body[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable');
    expect((await peer.poll('owner', session)).requests).toEqual([{ version: 1, action: 'cancel', id: request.id }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
