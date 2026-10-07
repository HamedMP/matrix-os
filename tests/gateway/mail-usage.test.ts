import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { createMailWorker } from '../../packages/gateway/src/mail/worker.js';
import { createMailGmailAdapter } from '../../packages/gateway/src/mail/gmail.js';
import { JEV_EMAIL_TRIAGE_ANSWER_IDS } from '@matrix-os/contracts';
import { mailTestDatabase } from './mail-test-database.js';
import { MailArchiveRepository } from '../../packages/gateway/src/mail/repository.js';
import { createObservedMailTransport } from '../../packages/gateway/src/mail/usage.js';
describe('mail progress and observed account usage', () => {
    let repository: MailArchiveRepository;
    let close: () => Promise<void>;
    const key = { ownerId: 'owner', accountId: 'account' };
    beforeEach(async () => {
        const fixture = await mailTestDatabase();
        close = fixture.cleanup;
        repository = new MailArchiveRepository(fixture.dialect);
        await repository.bootstrap();
        await repository.registerSource({ ...key, provider: 'gmail', connectionId: 'conn', email: 'a@example.com', accountLabel: 'Personal', group: 'personal' });
        await repository.grantConsumer({ ...key, appId: 'edition', from: '2026-07-01T00:00:00Z', until: '2026-10-07T00:00:00Z' });
    });
    afterEach(async () => {
        await repository.destroy();
        await close();
    });
    async function save(id: string, options: {
        partial?: boolean;
        date?: string;
        probability?: number;
        urgent?: number;
        context?: 'verified' | 'snippet';
        stale?: boolean;
    } = {}) {
        const source = (await repository.getSource(key))!;
        const digest = id.charCodeAt(0).toString(16).padStart(2, '0').repeat(32);
        const saved = await repository.saveMessage({ ...key, messageId: id, threadId: id, subject: 'Letter', sender: 'Publisher', receivedAt: options.date ?? '2026-09-01T00:00:00Z', labels: ['INBOX'], object: options.partial ? null : { namespace: source.namespace, digest, sizeBytes: 10 }, ...(options.partial ? { partialReason: 'content_too_large' } : {}) });
        if (saved.kind !== 'saved')
            throw Error('save');
        if (options.probability !== undefined)
            await repository.saveClassification({ ...key, messageId: id, classification: { fingerprint: options.stale ? 'f'.repeat(64) : digest, contextKind: options.context ?? 'verified', modelPolicyVersion: 'newsletter-jev-v1', recipe: 'email-triage-v1', result: { requestId: 'jev_req_1234567890', recipe: 'email-triage-v1', model: 'typesafe/jev', latencyMs: 1, answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => ({ id, type: 'boolean', probability: id === 'newsletter' ? options.probability! : id === 'urgent' ? options.urgent ?? 0 : 0 })) } } });
        return saved.message;
    }
    it('counts durable current granted content and derives Review with the shared policy', async () => {
        await save('a', { probability: .99 });
        await save('b', { probability: .65 });
        await save('c', { probability: .99, urgent: .3 });
        await save('d', { probability: .99, context: 'snippet' });
        await save('e', { probability: .1 });
        await save('f');
        await save('g', { partial: true });
        await save('h', { probability: .99, stale: true });
        const manual = await save('i');
        await repository.setCorrection({ ...key, appId: 'edition', id: manual.id, baseRevision: 1, correction: 'not_newsletter' });
        await save('j', { date: '2026-01-01T00:00:00Z' });
        await save('k', { date: '2026-11-01T00:00:00Z' });
        await save('l');
        await repository.suppressMessage({ ...key, messageId: 'l' });
        expect(await repository.getUsageSummary({ ...key, appId: 'edition' })).toMatchObject({ retainedCount: 8, partialCount: 1, classifiedCount: 5, reviewPendingCount: 6, billedUsage: null, observedScope: 'account_total', observed: { connectorCalls: 0, messageRetrievals: 0, reusedBodies: 0, aiClassificationCalls: 0, classificationReuse: 0 } });
    });
    it('increments related fixed counters atomically without lost updates and isolates owner/account', async () => {
        await Promise.all(Array.from({ length: 40 }, () => repository.recordUsage({ ...key, events: ['connectorCalls', 'messageRetrievals', 'get_message'] })));
        expect((await repository.getUsageSummary({ ...key, appId: 'edition' })).observed).toMatchObject({ connectorCalls: 40, messageRetrievals: 40, byAction: { get_message: 40 } });
        await repository.registerSource({ ...key, accountId: 'other', provider: 'gmail', connectionId: 'other', email: 'b@example.com', group: 'work' });
        await repository.grantConsumer({ ...key, accountId: 'other', appId: 'edition' });
        expect((await repository.getUsageSummary({ ...key, accountId: 'other', appId: 'edition' })).observed.connectorCalls).toBe(0);
        await expect(repository.getUsageSummary({ ...key, ownerId: 'other', appId: 'edition' })).rejects.toMatchObject({ code: 'denied' });
        await expect(repository.recordUsage({ ...key, events: ['connectorCalls', 'secret'] as never })).rejects.toThrow();
        await expect(repository.recordUsage({ ...key, events: ['connectorCalls', 'connectorCalls'] })).rejects.toThrow();
        expect((await repository.getUsageSummary({ ...key, appId: 'edition' })).observed.connectorCalls).toBe(40);
        await repository.revokeConsumer({ ...key, appId: 'edition' });
        await expect(repository.recordUsage({ ...key, events: ['connectorCalls'] })).rejects.toMatchObject({ code: 'denied' });
        await expect(repository.getUsageSummary({ ...key, appId: 'edition' })).rejects.toMatchObject({ code: 'denied' });
    });
    it('observes real durable worker reuse across historical replay and unchanged delta without repeated body or AI requests', async () => {
        const source = (await repository.getSource(key))!;
        const contents = new Map<string, Buffer>();
        const objects = { put: async (namespace: string, bytes: Uint8Array) => {
                const digest = createHash('sha256').update(bytes).digest('hex');
                contents.set(digest, Buffer.from(bytes));
                return { namespace, digest, sizeBytes: bytes.byteLength };
            }, read: async (object: {
                digest: string;
            }) => contents.get(object.digest)! };
        const call = vi.fn(async (_owner: string, _binding: unknown, action: string) => {
            if (action === 'get_profile')
                return { emailAddress: source.email, historyId: '100' };
            if (action === 'search')
                return { messages: [{ id: 'm1' }] };
            if (action === 'list_history')
                return { historyId: '101', history: [] };
            if (action === 'get_message')
                return { id: 'm1', internalDate: String(Date.parse('2026-09-01T00:00:00Z')), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', body: { data: Buffer.from('Weekly letter').toString('base64url') } } };
            if (action === 'get_metadata')
                return { id: 'm1', labelIds: ['INBOX'] };
            throw Error('unexpected');
        });
        const transport = createObservedMailTransport({ repository, transport: { call, inventory: vi.fn() } as never });
        const evaluate = vi.fn(async () => ({ requestId: 'jev_req_1234567890', recipe: 'email-triage-v1' as const, model: 'typesafe/jev' as const, latencyMs: 1, answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => ({ id, type: 'boolean' as const, probability: id === 'newsletter' ? .99 : 0 })) }));
        const worker = createMailWorker({ repository, objects, ownerId: key.ownerId, authorize: async () => {
            }, fundedReady: async () => true, jev: { evaluate }, observeUsage: (source, event) => repository.recordUsage({ ...source, events: [event] }), gmailForSource: (source, signal) => createMailGmailAdapter({ signal, authorize: async () => {
                }, transport: (action, params, signal) => transport.call(source.ownerId, { service: 'gmail', connectionId: source.connectionId, expectedEmail: source.email, accountLabel: source.accountLabel }, action, params, signal) }) } as Parameters<typeof createMailWorker>[0]);
        const until = '2026-10-07T00:00:00Z';
        await repository.enqueueSync({ ...key, rangeFrom: '2026-07-01T00:00:00Z', rangeUntil: until });
        await worker.sync(source);
        await repository.enqueueSync({ ...key, rangeFrom: '2026-06-01T00:00:00Z', rangeUntil: until });
        await worker.sync(source);
        await repository.enqueueSync({ ...key, rangeFrom: '2026-06-01T00:00:00Z', rangeUntil: until });
        await worker.sync(source);
        const summary = await repository.getUsageSummary({ ...key, appId: 'edition' });
        expect(summary).toMatchObject({ retainedCount: 1, classifiedCount: 1, reviewPendingCount: 0, observed: { messageRetrievals: 1, reusedBodies: 1, aiClassificationCalls: 1, classificationReuse: 1, connectorCalls: call.mock.calls.length, byAction: { get_message: 1 } } });
        expect(evaluate).toHaveBeenCalledOnce();
        expect(call.mock.calls.filter(c => c[2] === 'get_message')).toHaveLength(1);
    });
    it('records the bounded legacy list_messages action without accepting arbitrary counter names', async () => {
        const call = vi.fn(async () => ({ messages: [] }));
        const transport = createObservedMailTransport({ repository, transport: { call, inventory: vi.fn() } as never });
        await transport.call('owner', { service: 'gmail', connectionId: 'conn', expectedEmail: 'a@example.com', accountLabel: 'Personal' }, 'list_messages', {query:'after:2026/07/01'});
        expect((await repository.getUsageSummary({ ...key, appId: 'edition' })).observed.byAction).toMatchObject({ list_messages: 1 });
    });
    it('rolls back all related increments on saturation and preserves data across repeated bootstrap', async () => {
        await repository.recordUsage({ ...key, events: ['connectorCalls', 'messageRetrievals'] });
        await sql `UPDATE mail_usage SET count=${Number.MAX_SAFE_INTEGER} WHERE kind='messageRetrievals'`.execute(repository.kysely);
        await expect(repository.recordUsage({ ...key, events: ['connectorCalls', 'messageRetrievals'] })).rejects.toThrow();
        await repository.bootstrap();
        expect((await repository.getUsageSummary({ ...key, appId: 'edition' })).observed.connectorCalls).toBe(1);
    });
    it('records exact-bound observed requests including failed attempts, never ungranted/invalid bindings', async () => {
        const call = vi.fn(async () => ({ ok: true }));
        const inventory = vi.fn(async () => []);
        const transport = createObservedMailTransport({ repository, transport: { call, inventory } as never });
        await transport.inventory('owner');
        expect(inventory).toHaveBeenCalledExactlyOnceWith('owner');
        const binding = { service: 'gmail' as const, connectionId: 'conn', expectedEmail: 'a@example.com', accountLabel: 'Personal' };
        await transport.call('owner', binding, 'get_message', { messageId: 'm1' });
        call.mockRejectedValueOnce(Error('timeout'));
        await expect(transport.call('owner', binding, 'get_metadata', { messageId: 'm1' })).rejects.toThrow();
        expect((await repository.getUsageSummary({ ...key, appId: 'edition' })).observed).toMatchObject({ connectorCalls: 2, messageRetrievals: 1, byAction: { get_message: 1, get_metadata: 1 } });
        await expect(transport.call('owner', { ...binding, accountLabel: 'Changed' }, 'get_message', { messageId: 'm1' })).rejects.toMatchObject({ code: 'denied' });
        await expect(transport.call('owner', binding, 'arbitrary', {})).rejects.toThrow();
        expect(call).toHaveBeenCalledTimes(2);
        await repository.revokeConsumer({ ...key, appId: 'edition' });
        await transport.call('owner', binding, 'get_profile', {});
        expect(call).toHaveBeenCalledTimes(3);
    });
});
