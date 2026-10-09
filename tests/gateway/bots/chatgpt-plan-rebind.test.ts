import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { chatGptPlanPeerProof } from '@matrix-os/contracts';
import { createChatGptPlanPeers } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';
import { createBotStateDatabase } from './bot-state-support.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
function device() {
  const keys = generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  const snapshot = { deviceId: createHash('sha256').update(der).digest('hex'), accountId: 'account', grantRevision: 1, enabled: true, background: false,
    models: [{ id: 'gpt', displayName: 'GPT', input: ['text' as const], contextWindow: 128000, maxOutputTokens: 8192 }] };
  return { snapshot, sign(challenge: ReturnType<ReturnType<typeof createChatGptPlanPeers>['challenge']>) {
    return { version: 1, challenge: challenge.challenge, publicKey: der.toString('base64url'), snapshot,
      ...('replacement' in challenge ? { replacement: challenge.replacement } : {}),
      signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString('base64url') };
  } };
}
async function fixture() {
  const db = await createBotStateDatabase(); cleanups.push(db.destroy);
  const peer = createChatGptPlanPeers({ db: db.db, ownerId: 'owner', computerId: 'computer' }); cleanups.push(() => peer.close());
  const old = device(); const session = await peer.connect('owner', old.sign(peer.challenge('owner')));
  return { db: db.db, peer, old, session };
}
it('only an explicit signed recovery replaces the pin, rejects pending work and restores models', async () => {
  const { peer, old, session } = await fixture(); const next = device();
  await expect(peer.connect('owner', next.sign(peer.challenge('owner')))).rejects.toThrow('conflict');
  const selection = { instanceId: 'matrix_chatgpt_plan', model: 'gpt', options: [{ id: 'accountId', value: 'account' }, { id: 'grantRevision', value: '1' }] };
  const route = await peer.resolve(selection, 'owner', 'interactive');
  const binding = { ownerId: 'owner', runId: 'run', requestClass: 'interactive', ...route } as never;
  const pending = peer.infer(binding, '{}', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('unavailable');
  const challenge = await peer.rebindChallenge('owner');
  const input = next.sign(challenge);
  await peer.connect('owner', input); await rejected;
  await expect(peer.poll('owner', session)).rejects.toThrow('unavailable');
  expect(await peer.revalidate(binding, new AbortController().signal)).toBe(false);
  expect(await peer.observe('owner')).toMatchObject({ availability: 'available', models: [{ id: 'gpt' }] });
  await expect(peer.connect('owner', input)).rejects.toThrow('invalid_request');
  await expect(peer.connect('owner', old.sign(peer.challenge('owner')))).rejects.toThrow('conflict');
  await peer.connect('owner', next.sign(peer.challenge('owner'))); // same-device reconnect
});
it('binds replacement intent to one fresh owner challenge and verifies CAS against durable state', async () => {
  const { peer, db } = await fixture(); const next = device();
  await expect(peer.rebindChallenge('foreign')).rejects.toThrow('forbidden');
  const challenge = await peer.rebindChallenge('owner');
  const input = next.sign(challenge);
  await expect(peer.connect('owner', { ...input, replacement: undefined })).rejects.toThrow('invalid_request');
  const forged = next.sign(await peer.rebindChallenge('owner'));
  await expect(peer.connect('owner', { ...forged, signature: 'a'.repeat(86) })).rejects.toThrow('invalid_request');
  const stale = next.sign(await peer.rebindChallenge('owner'));
  await db.updateTable('bot_chatgpt_plan_devices').set({ device_id: 'f'.repeat(64), public_key: 'c'.repeat(64) }).execute();
  await expect(peer.connect('owner', stale)).rejects.toThrow('conflict');
  expect((await db.selectFrom('bot_chatgpt_plan_devices').selectAll().executeTakeFirstOrThrow()).device_id).toBe('f'.repeat(64));
});

it('successful CAS revokes old work even when post-write publication fails', async () => {
  const { peer, db, session } = await fixture(); const next = device();
  const route = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt', options: [{ id: 'accountId', value: 'account' }, { id: 'grantRevision', value: '1' }] }, 'owner', 'interactive');
  const pending = peer.infer({ ownerId: 'owner', runId: 'run', requestClass: 'interactive', ...route } as never, '{}', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('unavailable');
  const input = next.sign(await peer.rebindChallenge('owner'));
  const read = vi.spyOn(db, 'selectFrom').mockImplementationOnce(() => { throw new Error('read unavailable'); });
  await expect(peer.connect('owner', input)).rejects.toThrow('read unavailable'); read.mockRestore();
  await rejected; await expect(peer.poll('owner', session)).rejects.toThrow('unavailable');
  expect((await peer.observe('owner')).availability).toBe('unavailable');
  await peer.connect('owner', next.sign(peer.challenge('owner')));
  expect((await peer.observe('owner')).availability).toBe('available');
});
it('bounds concurrent connect and does not publish an older in-flight replacement', async () => {
  const { peer, session } = await fixture(); const next = device();
  const input = next.sign(await peer.rebindChallenge('owner'));
  // Start while the real Postgres write is awaiting I/O, then supersede its challenge.
  const connecting = peer.connect('owner', input);
  const rejection = expect(connecting).rejects.toThrow('unavailable');
  const newer = next.sign(peer.challenge('owner'));
  await expect(peer.connect('owner', newer)).rejects.toThrow('unavailable');
  await rejection;
  await expect(peer.poll('owner', session)).rejects.toThrow('unavailable');
  await peer.connect('owner', next.sign(peer.challenge('owner')));
  expect((await peer.observe('owner')).availability).toBe('available');
});

it('audits only successful durable replacement without credential or device identifiers', async () => {
  const { peer } = await fixture(); const next = device();
  const audit = vi.spyOn(console, 'info').mockImplementation(() => {});
  await expect(peer.connect('owner', next.sign(peer.challenge('owner')))).rejects.toThrow('conflict');
  expect(audit).not.toHaveBeenCalled();
  await peer.connect('owner', next.sign(await peer.rebindChallenge('owner')));
  expect(audit.mock.calls).toEqual([['[chatgpt-plan] Device binding replaced']]);
});
