import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPlanNativePeer } from '../../desktop/src/main/chatgpt-plan/peer';
const sessionId = '00000000-0000-4000-8000-000000000001';
const key = generateKeyPairSync('ed25519');
const binding = { runtimeSlot: 'primary', authGeneration: 1, ownerId: 'owner', computerId: 'computer', origin: 'https://matrix.test', bearer: 'fixture', privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
function request(sequence: number, overrides = {}) {
  return { version: 1, action: 'infer', id: `${sessionId.slice(0, 24)}${sequence.toString(16).padStart(12, '0')}`, sequence, expiresAt: new Date(Date.now() + 120000).toISOString(), accountId: 'account', grantRevision: 1, computerId: 'computer', requestClass: 'interactive', runId: 'run', model: 'model', body: '{}', ...overrides };
}
async function fixture() {
  const replies: Array<Record<string, unknown>> = [];
  const requests: unknown[] = [];
  let wake: (() => void) | undefined;
  let current = true;
  const infer = vi.fn(async (_request, signal: AbortSignal) => {
    if (_request.runId === 'held') await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'data: {}\n\n';
  });
  const connected = vi.fn();
  const peer = createPlanNativePeer({ current: () => current, infer, connected,
    fetchFn: vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname.split('/').at(-1);
      if (path === 'challenge') return Response.json({ version: 1, challenge: 'a'.repeat(64), ownerId: 'owner', computerId: 'computer', expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (path === 'connect') return Response.json({ version: 1, sessionId });
      if (path === 'reply') { replies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
      if (path === 'disconnect') return Response.json({ ok: true });
      if (path === 'poll') {
        if (!requests.length) await new Promise<void>(resolve => {
          const signal = init!.signal!;
          const finish = () => { signal.removeEventListener('abort', finish); wake = undefined; resolve(); };
          wake = finish; signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
        const batch = requests.splice(0, 32);
        return Response.json({ version: 1, requests: batch });
      }
      throw new Error('fixture route');
    }) as typeof fetch });
  await peer.start(binding, { deviceId: 'a'.repeat(64), accountId: 'account', grantRevision: 1, enabled: true, background: false, models: [{ id: 'model', displayName: 'Model', input: ['text'], contextWindow: 8192, maxOutputTokens: 256 }] });
  return { peer, infer, replies, connected, queue: (...batch: unknown[]) => { requests.push(...batch); wake?.(); }, switchRuntime: () => { current = false; wake?.(); } };
}
describe('bounded native peer replay admission', () => {
  it('keeps one connection and an active call across more than 64 sequential requests, rejecting replays', async () => {
    const x = await fixture();
    try {
      x.queue(request(1, { runId: 'held' })); await vi.waitFor(() => expect(x.infer).toHaveBeenCalledTimes(1));
      for (let sequence = 2; sequence <= 70; sequence++) {
        x.queue(request(sequence)); await vi.waitFor(() => expect(x.replies.filter(r => r.ok)).toHaveLength(sequence - 1), { interval: 1 });
      }
      x.queue(request(1), request(2), request(71, { id: request(2).id }), request(72, { expiresAt: new Date(Date.now() - 1).toISOString() }), request(73, { expiresAt: new Date(Date.now() + 300000).toISOString() }));
      await vi.waitFor(() => expect(x.replies).toHaveLength(71), { interval: 1 });
      x.queue(request(72)); // An expired sequence cannot be reused with a new expiry.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(x.replies).toHaveLength(71);
      expect(x.infer).toHaveBeenCalledTimes(70);
      expect(x.infer.mock.calls[0]![1].aborted).toBe(false);
      expect(x.connected.mock.calls).toEqual([[false], [true]]);
      x.queue({ version: 1, action: 'cancel', id: request(1).id });
      await vi.waitFor(() => expect(x.infer.mock.calls[0]![1].aborted).toBe(true));
      x.queue(request(74)); await vi.waitFor(() => expect(x.replies.filter(r => r.ok)).toHaveLength(70));
    } finally { await x.peer.stop(); }
  });
  it('keeps the concurrency cap without cancelling admitted work and fences runtime changes', async () => {
    const x = await fixture();
    try {
      x.queue(...[1, 2, 3, 4, 5].map(sequence => request(sequence, { runId: 'held' })));
      await vi.waitFor(() => expect(x.replies).toHaveLength(1));
      expect(x.infer).toHaveBeenCalledTimes(4); expect(x.replies[0]).toMatchObject({ ok: false });
      expect(x.infer.mock.calls.every(call => !call[1].aborted)).toBe(true);
      x.switchRuntime(); await vi.waitFor(() => expect(x.infer.mock.calls.every(call => call[1].aborted)).toBe(true));
    } finally { await x.peer.stop(); }
  });
  it('bounds clock skew and rejects expired requests without extending native inference past 120s', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const x = await fixture();
    try {
      x.queue(request(1, { runId: 'held', expiresAt: new Date(Date.now() + 124000).toISOString() }));
      await vi.waitFor(() => expect(x.infer).toHaveBeenCalledTimes(1));
      x.queue(request(2, { expiresAt: new Date(Date.now() + 126000).toISOString() }), request(3, { expiresAt: new Date(Date.now() - 1).toISOString() }));
      await vi.waitFor(() => expect(x.replies).toHaveLength(2));
      expect(x.infer.mock.calls[0]![1].aborted).toBe(false);
      expect(timeout).toHaveBeenCalledWith(120000);
      expect(timeout.mock.calls.every(([ms]) => ms <= 120000)).toBe(true);
      expect(x.infer).toHaveBeenCalledTimes(1);
    } finally { await x.peer.stop(); clock.mockRestore(); timeout.mockRestore(); }
  });

});
