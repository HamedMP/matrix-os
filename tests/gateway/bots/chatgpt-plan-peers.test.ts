import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatGptPlanPeerRequestId, chatGptPlanPeerProof } from '@matrix-os/contracts';
import { createChatGptPlanPeers } from '../../../packages/gateway/src/bots/chatgpt-plan-peers.js';
import { createBotStateDatabase } from './bot-state-support.js';
const keys = generateKeyPairSync('ed25519');
const der = keys.publicKey.export({ type: 'spki', format: 'der' });
const snapshot = { deviceId: createHash('sha256').update(der).digest('hex'), accountId: 'account_own', grantRevision: 3, enabled: true, background: false,
    models: [{ id: 'gpt-server', displayName: 'Server model', input: ['text' as const], contextWindow: 128000, maxOutputTokens: 8192 }] };
import { Hono } from 'hono';
import { createChatGptPlanPeerRoutes } from '../../../packages/gateway/src/bots/chatgpt-plan-peer-routes.js';
import { markVerifiedRuntimeBearer } from '../../../packages/gateway/src/request-principal.js';
import { requestPlanResponse } from '../../../desktop/src/main/chatgpt-plan/responses';
describe('authenticated owner-local ChatGPT peer', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => { for (const f of cleanups.splice(0))
        await f(); });
    async function fixture() {
        const db = await createBotStateDatabase();
        cleanups.push(db.destroy);
        let now = 1000000;
        const peer = createChatGptPlanPeers({ db: db.db, ownerId: 'owner', computerId: 'computer', now: () => now });
        cleanups.push(async () => peer.close());
        const challenge = peer.challenge('owner');
        const input = { version: 1, challenge: challenge.challenge, publicKey: der.toString('base64url'), snapshot,
            signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString('base64url') };
        return { peer, input, expire: () => { now += 31000; } };
    }
    it('validates signed owner/Computer proof and projects only nonsecret models', async () => {
        const { peer, input } = await fixture();
        await peer.connect('owner', input);
        expect(await peer.observe('owner')).toMatchObject({ availability: 'available', accountId: 'account_own', authorization: { revision: 3, enabled: true } });
        const route = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [{ id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }] }, 'owner', 'interactive');
        expect(route).toMatchObject({ accessSourceId: 'matrix_chatgpt_plan', route: { api: 'openai-responses' }, subscription: { accountId: 'account_own', computerId: 'computer', grantRevision: 3 } });
        await expect(peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server' }, 'owner', 'interactive')).rejects.toThrow();
        await expect(peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [{ id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }] }, 'owner', 'background')).rejects.toThrow();
    });
    it('rejects a superseded signed challenge and duplicate selection options', async () => {
        const { peer, input } = await fixture();
        const challenge = peer.challenge('owner');
        await expect(peer.connect('owner', input)).rejects.toThrow('invalid_request');
        const fresh = { ...input, challenge: challenge.challenge,
            signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot })), keys.privateKey).toString('base64url') };
        await peer.connect('owner', fresh);
        await expect(peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [
                { id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }, { id: 'accountId', value: 'account_own' },
            ] }, 'owner', 'interactive')).rejects.toThrow();
    });
    it('rejects forged/replayed/cross-owner enrollment', async () => {
        const { peer, input } = await fixture();
        await expect(peer.connect('other', input)).rejects.toThrow('forbidden');
        await expect(peer.connect('owner', { ...input, signature: 'a'.repeat(86) })).rejects.toThrow();
        await expect(peer.connect('owner', input)).rejects.toThrow();
    });
    it('disconnect and heartbeat expiration revoke route without fallback', async () => {
        const { peer, input, expire } = await fixture();
        const session = await peer.connect('owner', input);
        expire();
        expect((await peer.observe('owner')).availability).toBe('unavailable');
        await expect(peer.poll('owner', session)).rejects.toThrow();
    });
    it('routes one exact inference to the native peer and accepts its bounded reply only once', async () => {
        const { peer, input } = await fixture();
        const session = await peer.connect('owner', input);
        const selected = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [{ id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }] }, 'owner', 'interactive');
        const binding = { ownerId: 'owner', runId: 'run_test', runtimeHandle: `runtime_${'b'.repeat(32)}`, executionGeneration: '2', chatId: 'chat_test', requestClass: 'interactive', ...selected } as never;
        const inference = peer.infer(binding, '{"model":"gpt-server","input":[],"store":false,"stream":true}', new AbortController().signal);
        const polled = await peer.poll('owner', session);
        expect(polled.requests).toHaveLength(1);
        const request = polled.requests[0]!;
        expect(request).toMatchObject({ action: 'infer', accountId: 'account_own', computerId: 'computer', grantRevision: 3, model: 'gpt-server', requestClass: 'interactive' });
        const reply = { ...session, id: request.id, ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {}\n\n' };
        peer.reply('owner', reply);
        expect(await inference).toMatchObject({ status: 200 });
        expect(() => peer.reply('owner', reply)).toThrow('conflict');
        peer.disconnect('owner', session);
        expect(await peer.revalidate(binding, new AbortController().signal)).toBe(false);
    });
    it('Stop reaches the native peer and rejects pending inference without another account', async () => {
        const { peer, input } = await fixture();
        const session = await peer.connect('owner', input);
        const selected = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [{ id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }] }, 'owner', 'interactive');
        const stop = new AbortController();
        const inference = peer.infer({ ownerId: 'owner', runId: 'run_test', requestClass: 'interactive', ...selected } as never, '{}', stop.signal);
        const rejection = expect(inference).rejects.toThrow('unavailable');
        const polled = await peer.poll('owner', session);
        stop.abort();
        expect((await peer.poll('owner', session)).requests).toEqual([{ version: 1, action: 'cancel', id: polled.requests[0]!.id }]);
        await rejection;
    });
    it('pins the public key and does not overwrite it with another authenticated device', async () => {
        const { peer, input } = await fixture();
        await peer.connect('owner', input);
        const other = generateKeyPairSync('ed25519');
        const pub = other.publicKey.export({ type: 'spki', format: 'der' });
        const challenge = peer.challenge('owner');
        const replacement = { ...snapshot, deviceId: createHash('sha256').update(pub).digest('hex') };
        await expect(peer.connect('owner', { version: 1, challenge: challenge.challenge, publicKey: pub.toString('base64url'), snapshot: replacement, signature: sign(null, Buffer.from(chatGptPlanPeerProof({ ...challenge, snapshot: replacement })), other.privateKey).toString('base64url') })).rejects.toThrow('conflict');
        expect((await peer.observe('owner')).availability).toBe('available');
    });
    it('issues increasing session-bound IDs beyond 64 requests without replacing admitted peer authority', async () => {
        const { peer, input } = await fixture();
        const session = await peer.connect('owner', input);
        const selected = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [{ id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }] }, 'owner', 'interactive');
        const binding = { ownerId: 'owner', runId: 'run_test', requestClass: 'interactive', ...selected } as never;
        const stop = new AbortController();
        const held = peer.infer(binding, '{}', stop.signal);
        const rejection = expect(held).rejects.toThrow('unavailable');
        const heldRequest = (await peer.poll('owner', session)).requests[0]!;
        for (let sequence = 2; sequence <= 70; sequence++) {
            const pending = peer.infer(binding, '{}', new AbortController().signal);
            const request = (await peer.poll('owner', session)).requests[0]!;
            expect(request).toMatchObject({ sequence, id: chatGptPlanPeerRequestId(session.sessionId, sequence), expiresAt: new Date(1120000).toISOString() });
            peer.reply('owner', { ...session, id: request.id, ok: false, error: 'unavailable' });
            await expect(pending).rejects.toThrow('unavailable');
            expect(await peer.revalidate(binding, new AbortController().signal)).toBe(true);
        }
        expect(heldRequest).toMatchObject({ sequence: 1 });
        stop.abort(); await rejection;
    });
    it('transports a native-validated near-limit escaped UTF-8 response through the real reply route', async () => {
        const { peer, input } = await fixture();
        const session = await peer.connect('owner', input);
        const selected = await peer.resolve({ instanceId: 'matrix_chatgpt_plan', model: 'gpt-server', options: [{ id: 'accountId', value: 'account_own' }, { id: 'grantRevision', value: '3' }] }, 'owner', 'interactive');
        const wire = JSON.stringify({ model: 'gpt-server', input: [{ role: 'user', content: 'fixture' }], store: false, stream: true });
        const inference = peer.infer({ ownerId: 'owner', runId: 'run_test', requestClass: 'interactive', ...selected } as never, wire, new AbortController().signal);
        const request = (await peer.poll('owner', session)).requests[0]!;
        const terminal = 'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-server"}}\n\n';
        const pattern = '😀"\\\u0001';
        const prefix = `: ${pattern.repeat(Math.floor((1024 * 1024 - terminal.length - 5) / Buffer.byteLength(pattern)))}`;
        const raw = `${prefix}\n\n${terminal}`;
        const body = await requestPlanResponse({ fetchFn: vi.fn(async () => new Response(raw)) as typeof fetch, body: wire, model: 'gpt-server', signal: new AbortController().signal, accessToken: async () => 'fixture-token', validate: () => {} });
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024 * 1024);
        const envelope = { ...session, id: request.id, ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body };
        expect(Buffer.byteLength(JSON.stringify(envelope))).toBeGreaterThan(1100000);
        const app = new Hono();
        app.use('*', async (c, next) => { markVerifiedRuntimeBearer(c); await next(); });
        app.route('/', createChatGptPlanPeerRoutes({ peers: peer, getPrincipal: () => ({ userId: 'owner', source: 'jwt' }) }));
        expect((await app.request('/api/chatgpt-plan/device/reply', { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(envelope) })).status).toBe(200);
        expect(await inference).toMatchObject({ body });
    });

});
