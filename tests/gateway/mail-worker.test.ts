import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { JevServiceError } from '../../packages/gateway/src/jev/service.js';
import { createMailWorker } from '../../packages/gateway/src/mail/worker.js';
import { JEV_EMAIL_TRIAGE_ANSWER_IDS } from '@matrix-os/contracts';
const source = { ownerId: 'owner', accountId: 'account', provider: 'gmail' as const, connectionId: 'connection', email: 'me@example.com', accountLabel: 'Personal', group: 'personal' as const, namespace: 'a'.repeat(64), quotaBytes: 1024 ** 3, usedBytes: 0, cursor: null, revision: 0 };
const result = { requestId: 'jev_req_1234567890', recipe: 'email-triage-v1' as const, model: 'typesafe/jev' as const, latencyMs: 1, answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id => ({ id, type: 'boolean' as const, probability: id === 'newsletter' ? .99 : 0 })) };
function fixture() {
    let state: any;
    const rows = new Map<string, any>();
    const payloads = new Map<string, Buffer>();
    let classifications = new Map();
    const deferred = new Set<string>();
    const repository = { recordSyncFailure: vi.fn(async () => true), leaseImport: vi.fn(async () => ({ token: 'import', namespace: source.namespace })), releaseObjectLease: vi.fn(async () => {
        }), getSyncJob: vi.fn(async () => ({ id: 'job', ...source, rangeFrom: new Date(0).toISOString(), rangeUntil: new Date(1000).toISOString(), checkpoint: state, status: 'pending', token: null, workerId: null, leaseUntil: null })), claimSync: vi.fn(async () => ({ ...await repository.getSyncJob(), token: 'lease' })), renewSync: vi.fn(async () => true), checkpointSync: vi.fn(async (input: any) => {
            state = input.checkpoint;
            return true;
        }), completeSync: vi.fn(async () => true), releaseSync: vi.fn(async () => true), getSource: vi.fn(async () => source), advanceCursor: vi.fn(async () => true), getStoredMessage: vi.fn(async (input: any) => rows.get(input.messageId) ?? null), isSuppressed: vi.fn(async () => false), saveMessage: vi.fn(async (input: any) => {
            const message = { ...input, id: 'stored-' + input.messageId, revision: 1, correction: null, classification: null };
            rows.set(input.messageId, message);
            return { kind: 'saved', message };
        }), updateLabels: vi.fn(async () => true), getClassification: vi.fn(async (input: any) => classifications.get(input.fingerprint) ?? null), saveClassification: vi.fn(async (input: any) => {
            classifications.set(input.classification.fingerprint, input.classification);
        }), recordDeferredClassification: vi.fn(async (input: any) => {
            deferred.add(input.fingerprint);
        }), listClassificationCandidates: vi.fn(async () => Array.from(rows.values()).filter(row => row.object && !classifications.has(row.object.digest) && !deferred.has(row.object.digest)).slice(0, 20)), listMessages: vi.fn(async () => Array.from(rows.values())) };
    const objects = { put: vi.fn(async (namespace: string, bytes: Buffer) => {
            const digest = createHash('sha256').update(bytes).digest('hex');
            payloads.set(digest, bytes);
            return { namespace, digest, sizeBytes: bytes.length };
        }), read: vi.fn(async (object: any) => payloads.get(object.digest)!) };
    const gmail = { profile: vi.fn(async () => ({ emailAddress: source.email, historyId: '90071992547409931' })), messages: vi.fn(async () => ({ messages: [{ id: 'm1' }] })), message: vi.fn(async () => ({ messageId: 'm1', threadId: 'thread', subject: 'Weekly', sender: 'Publisher', receivedAt: 1, labels: ['INBOX'], text: 'Hello', html: '', source: { id: 'm1' } })), metadata: vi.fn(async () => ({ id: 'm1', labelIds: ['INBOX'] })), history: vi.fn(async () => ({ historyId: '90071992547409932', history: [] })), archive: vi.fn(), restoreInbox: vi.fn() };
    const jev = { evaluate: vi.fn(async () => result) };
    const fundedReady = vi.fn(async () => true);
    const notify = vi.fn(async () => {
    });
    return { repository, objects, gmail, jev, fundedReady, notify, authorize: vi.fn(async () => {
        }), ownerId: source.ownerId, gmailForSource: vi.fn(async () => gmail), rows, checkpoint: () => state };
}
describe('archive runtime worker', () => {
    it('saves one exact source payload and classifies it once across incremental requests', async () => {
        const f = fixture();
        const worker = createMailWorker(f);
        expect((await worker.sync(source)).savedCount).toBe(1);
        expect(f.jev.evaluate).toHaveBeenCalledOnce();
        await worker.sync(source);
        expect(f.gmail.message).toHaveBeenCalledOnce();
        expect(f.jev.evaluate).toHaveBeenCalledOnce();
        expect(f.repository.advanceCursor).toHaveBeenCalled();
        expect(f.objects.put.mock.calls[0][1].toString()).toContain('"source":{"id":"m1"}');
    });
    it('never reads an account when its job lease is owned elsewhere', async () => {
        const f = fixture();
        f.repository.claimSync.mockResolvedValueOnce(null as any);
        expect((await createMailWorker(f).sync(source)).state).toBe('busy');
        expect(f.gmail.profile).not.toHaveBeenCalled();
    });
    it('retains imported history while funding is unavailable then classifies backlog later', async () => {
        const f = fixture();
        f.fundedReady.mockResolvedValue(false);
        await createMailWorker(f).sync(source);
        expect(f.repository.saveMessage).toHaveBeenCalledOnce();
        expect(f.jev.evaluate).not.toHaveBeenCalled();
        f.fundedReady.mockResolvedValue(true);
        await createMailWorker(f).sync(source);
        expect(f.jev.evaluate).toHaveBeenCalledOnce();
    });
    it('releases resumable job after typed provider timeout without declaring completion', async () => {
        const f = fixture();
        f.gmail.history.mockRejectedValueOnce(Object.assign(Error('timeout'), { name: 'TimeoutError' }));
        await expect(createMailWorker(f).sync(source)).rejects.toThrow();
        expect(f.repository.releaseSync).toHaveBeenCalled();
        expect(f.repository.completeSync).not.toHaveBeenCalled();
        expect(f.checkpoint().cursor).toBe('90071992547409931');
    });
    it('prevents another owner and expires before network dispatch on cancellation', async () => {
        const f = fixture();
        const worker = createMailWorker(f);
        await expect(worker.sync({ ...source, ownerId: 'other' })).rejects.toThrow();
        const controller = new AbortController();
        controller.abort();
        await expect(worker.sync(source, controller.signal)).rejects.toThrow();
        expect(f.gmail.message).not.toHaveBeenCalled();
    });
    it('retains oversize records as partial without object bytes or paid evaluation', async () => {
        const f = fixture();
        f.gmail.message.mockResolvedValueOnce({ ...await f.gmail.message(), text: 'x'.repeat(2 * 1024 * 1024) });
        await createMailWorker(f).sync(source);
        expect(f.objects.put).not.toHaveBeenCalled();
        expect(f.rows.get('m1').partialReason).toBe('content_too_large');
        expect(f.jev.evaluate).not.toHaveBeenCalled();
    });
});
describe('worker authority and durable recovery', () => {
    it('persists confirmed sync time and protects staged bytes until metadata retain completes', async () => {
        const f = fixture();
        await createMailWorker(f).sync(source);
        expect(Date.parse(f.checkpoint().completedAt)).toBeGreaterThan(0);
        expect(f.repository.leaseImport.mock.invocationCallOrder[0]).toBeLessThan(f.objects.put.mock.invocationCallOrder[0]);
        expect(f.repository.releaseObjectLease.mock.invocationCallOrder[0]).toBeGreaterThan(f.repository.saveMessage.mock.invocationCallOrder[0]);
    });
    it('stops revoked consent, changed binding and expired worker leases before reads', async () => {
        for (const kind of ['consent', 'binding', 'lease']) {
            const f = fixture();
            if (kind === 'consent')
                f.authorize.mockRejectedValueOnce(Error('revoked'));
            if (kind === 'binding')
                f.repository.getSource.mockResolvedValueOnce({ ...source, connectionId: 'other' });
            if (kind === 'lease')
                f.repository.renewSync.mockResolvedValueOnce(false);
            await expect(createMailWorker(f).sync(source)).rejects.toThrow();
            expect(f.gmail.message).not.toHaveBeenCalled();
            expect(f.repository.releaseSync).toHaveBeenCalled();
        }
    });
    it('releases the exact object lease on quota or object integrity failure', async () => {
        for (const kind of ['quota', 'integrity']) {
            const f = fixture();
            if (kind === 'quota')
                f.repository.saveMessage.mockRejectedValueOnce(Error('quota'));
            else
                f.objects.put.mockResolvedValueOnce({ namespace: source.namespace, digest: 'b'.repeat(64), sizeBytes: 0 });
            await expect(createMailWorker(f).sync(source)).rejects.toThrow();
            expect(f.repository.releaseObjectLease).toHaveBeenCalledOnce();
            expect(f.repository.completeSync).not.toHaveBeenCalled();
        }
    });
    it('keeps durable import independent from ambiguous classification and catches notification failure', async () => {
        const f = fixture();
        f.jev.evaluate.mockRejectedValueOnce(Object.assign(Error('unknown'), { code: 'unknown' }));
        f.notify.mockRejectedValueOnce(Error('notify'));
        expect((await createMailWorker(f).sync(source)).classifiedCount).toBe(0);
        expect(f.repository.completeSync).toHaveBeenCalled();
        expect(f.repository.saveClassification).not.toHaveBeenCalled();
    });
    it('checks funding again at paid dispatch and permits unsupported classifier runtimes', async () => {
        const f = fixture();
        f.fundedReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect((await createMailWorker(f).sync(source)).classifiedCount).toBe(0);
        expect(f.jev.evaluate).not.toHaveBeenCalled();
        const g = fixture();
        await createMailWorker({ ...g, jev: null }).sync(source);
        expect(g.repository.saveMessage).toHaveBeenCalledOnce();
    });
    it('reuses existing persisted scores even when a backlog listing includes cached rows', async () => {
        const f = fixture();
        const worker = createMailWorker(f);
        await worker.sync(source);
        f.repository.listClassificationCandidates.mockImplementation(async () => Array.from(f.rows.values()));
        await worker.sync(source);
        expect(f.jev.evaluate).toHaveBeenCalledOnce();
    });
    it('retains durable partial messages without repeating body retrieval on reconciliation', async () => {
        const f = fixture();
        f.gmail.message.mockResolvedValueOnce({ ...await f.gmail.message(), text: 'x'.repeat(2 * 1024 * 1024) });
        await createMailWorker(f).sync(source);
        const priorCalls = f.gmail.message.mock.calls.length;
        f.repository.getSyncJob.mockImplementation(async () => ({ id: 'job', ...source, rangeFrom: new Date(0).toISOString(), rangeUntil: new Date(1000).toISOString(), checkpoint: null, status: 'pending', token: null, workerId: null, leaseUntil: null }));
        await createMailWorker(f).sync(source);
        expect(f.gmail.message.mock.calls.length).toBe(priorCalls);
    });
    it('stops shutdown before dispatch and rejects invalid or conflicting checkpoints', async () => {
        const a = fixture();
        const controller = new AbortController();
        controller.abort();
        await expect(createMailWorker({ ...a, signal: controller.signal }).sync(source)).rejects.toThrow();
        expect(a.repository.claimSync).not.toHaveBeenCalled();
        const b = fixture();
        b.repository.getSyncJob.mockImplementation(async () => ({ id: 'job', ...source, rangeFrom: new Date(0).toISOString(), rangeUntil: new Date(1000).toISOString(), checkpoint: { bad: true }, status: 'pending', token: null, workerId: null, leaseUntil: null }));
        await expect(createMailWorker(b).sync(source)).rejects.toThrow();
        expect(b.repository.releaseSync).toHaveBeenCalled();
        const c = fixture();
        c.repository.checkpointSync.mockResolvedValueOnce(false);
        await expect(createMailWorker(c).sync(source)).rejects.toThrow();
        expect(c.repository.releaseSync).toHaveBeenCalled();
    });
    it('does not complete a cursor when its optimistic DB update or completion loses a race', async () => {
        for (const kind of ['cursor', 'completion']) {
            const f = fixture();
            if (kind === 'cursor')
                f.repository.advanceCursor.mockResolvedValueOnce(false);
            else
                f.repository.completeSync.mockResolvedValueOnce(false);
            await expect(createMailWorker(f).sync(source)).rejects.toThrow();
            expect(f.repository.releaseSync).toHaveBeenCalled();
        }
    });
});
describe('worker bounded backlog and resumability', () => {
    it('leaves unfinished historical pages pending and refreshes missing payload references', async () => {
        const f = fixture();
        f.rows.set('m1', { ...source, messageId: 'm1', object: null, labels: [], revision: 1 });
        let n = 0;
        f.gmail.messages.mockImplementation(async () => ({ messages: [{ id: 'm1' }], nextPageToken: `page_${++n}` }));
        const synced = await createMailWorker(f).sync(source);
        expect(synced.processed).toBe(10);
        expect(f.repository.completeSync).not.toHaveBeenCalled();
        expect(f.repository.releaseSync).toHaveBeenCalled();
        expect(f.gmail.message).toHaveBeenCalledOnce();
    });
    it('skips stale and partial classification candidates, caps the backlog at20', async () => {
        const f = fixture();
        await createMailWorker(f).sync(source);
        const row = f.rows.get('m1');
        f.repository.listClassificationCandidates.mockResolvedValueOnce([{ ...row, messageId: 'gone' }, ...Array.from({ length: 30 }, () => row)]);
        expect((await createMailWorker(f).sync(source)).classifiedCount).toBe(19);
        expect(f.jev.evaluate).toHaveBeenCalledOnce();
        f.rows.set('m1', { ...row, partialReason: 'partial' });
        f.repository.listClassificationCandidates.mockResolvedValueOnce([f.rows.get('m1')]);
        expect((await createMailWorker(f).sync(source)).classifiedCount).toBe(0);
    });
    it('respects manual exclusions, snippet context and empty plain-text fallback', async () => {
        const f = fixture();
        await createMailWorker(f).sync(source);
        const row = f.rows.get('m1');
        f.rows.set('m1', { ...row, correction: 'not_newsletter' });
        f.repository.getClassification.mockResolvedValueOnce(null);
        f.repository.listClassificationCandidates.mockResolvedValueOnce([f.rows.get('m1')]);
        f.objects.read.mockResolvedValueOnce(Buffer.from(JSON.stringify({ subject: '', sender: '', text: '', html: '' })));
        await createMailWorker({ ...f, appId: 'edition', modelPolicyVersion: 'newsletter-v2' }).sync(source);
        expect(f.repository.saveClassification.mock.calls.at(-1)?.[0].classification.contextKind).toBe('snippet');
    });
    it('completes without duplicate cursor writes when source already matches and permits missing notification callback', async () => {
        const f = fixture();
        f.repository.getSource.mockResolvedValue({ ...source, cursor: '90071992547409932' } as any);
        await createMailWorker({ ...f, notify: undefined }).sync(source, new AbortController().signal);
        expect(f.repository.advanceCursor).not.toHaveBeenCalled();
        expect(f.repository.completeSync).toHaveBeenCalled();
    });
    it('fails closed when source disappears, namespace changes, or email changes', async () => {
        for (const value of [null, { ...source, namespace: 'b'.repeat(64) }, { ...source, email: 'other@example.com' }]) {
            const f = fixture();
            f.repository.getSource.mockResolvedValueOnce(value as any);
            await expect(createMailWorker(f).sync(source)).rejects.toThrow();
            expect(f.gmail.message).not.toHaveBeenCalled();
        }
    });
    it('ends classification on shutdown while keeping resumable imported state', async () => {
        const f = fixture();
        const shutdown = new AbortController();
        f.jev.evaluate.mockImplementation(async () => {
            shutdown.abort();
            throw 'shutdown';
        });
        await expect(createMailWorker({ ...f, signal: shutdown.signal }).sync(source)).rejects.toThrow();
        expect(f.repository.completeSync).not.toHaveBeenCalled();
        expect(f.repository.releaseSync).toHaveBeenCalled();
    });
});
it('falls back to message identity when source thread is absent', async () => {
    const f = fixture();
    f.gmail.message.mockResolvedValueOnce({ ...await f.gmail.message(), threadId: undefined as any });
    await createMailWorker(f).sync(source);
    expect(f.rows.get('m1').threadId).toBe('m1');
});
it('handles shutdown during backlog discovery and source removal during final cursor settlement', async () => {
    const a = fixture();
    const shutdown = new AbortController();
    a.repository.listClassificationCandidates.mockImplementation(async () => {
        shutdown.abort();
        return Array.from(a.rows.values());
    });
    await expect(createMailWorker({ ...a, signal: shutdown.signal }).sync(source)).rejects.toThrow();
    expect(a.jev.evaluate).not.toHaveBeenCalled();
    const b = fixture();
    b.repository.getSource.mockImplementation(async () => b.checkpoint()?.completedAt ? null as any : source);
    await expect(createMailWorker(b).sync(source)).rejects.toThrow('source unavailable');
    expect(b.repository.completeSync).not.toHaveBeenCalled();
});
it('retains explicitly partial provider summaries and keeps syncing other messages without classification', async () => {
    const f = fixture();
    f.gmail.messages.mockResolvedValueOnce({ messages: [{ id: 'm1' }, { id: 'm2' }] });
    const baseline = await f.gmail.message();
    f.gmail.message.mockResolvedValueOnce({ ...baseline, partialReason: 'content_too_large', text: '' } as any).mockResolvedValueOnce({ ...baseline, messageId: 'm2' });
    expect((await createMailWorker(f).sync(source)).savedCount).toBe(2);
    expect(f.rows.get('m1').object).toBeNull();
    expect(f.rows.get('m1').partialReason).toBe('content_too_large');
    expect(f.rows.get('m2').object).not.toBeNull();
    expect(f.jev.evaluate).toHaveBeenCalledOnce();
    expect(f.objects.put).toHaveBeenCalledOnce();
});
it('continues a real adapter backfill after decoded MIME oversize and reuses the partial summary on historical replay', async () => {
    const { createMailGmailAdapter } = await import('../../packages/gateway/src/mail/gmail.js');
    const f = fixture();
    const transport = vi.fn(async (action: string, params: any) => {
        if (action === 'get_profile')
            return { emailAddress: source.email, historyId: '90071992547409931' };
        if (action === 'search')
            return { messages: [{ id: 'm1' }, { id: 'm2' }] };
        if (action === 'list_history')
            return { historyId: '90071992547409932', history: [] };
        if (action === 'get_metadata')
            return { id: params.messageId, labelIds: ['INBOX'] };
        if (action === 'get_message_summary')
            return { id: 'm1', internalDate: '1', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Large edition' }] } };
        if (action === 'get_message')
            return { id: params.messageId, internalDate: '1', labelIds: ['INBOX'], payload: { mimeType: 'text/plain', body: { data: Buffer.from(params.messageId === 'm1' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'Weekly reading').toString('base64url') } } };
        throw Error('unexpected action');
    });
    const worker = createMailWorker({ ...f, gmailForSource: async (_source, signal) => createMailGmailAdapter({ transport, authorize: async () => {
            }, signal }) });
    expect((await worker.sync(source)).savedCount).toBe(2);
    expect(f.rows.get('m1').partialReason).toBe('content_too_large');
    expect(f.rows.get('m2').object).not.toBeNull();
    expect(f.jev.evaluate).toHaveBeenCalledOnce();
    f.repository.getSyncJob.mockImplementation(async () => ({ id: 'job', ...source, rangeFrom: new Date(0).toISOString(), rangeUntil: new Date(1000).toISOString(), checkpoint: null, status: 'pending', token: null, workerId: null, leaseUntil: null }));
    expect((await worker.sync(source)).savedCount).toBe(0);
    expect(transport.mock.calls.filter(([action]) => action === 'get_message')).toHaveLength(2);
    expect(transport.mock.calls.filter(([action]) => action === 'get_message_summary')).toHaveLength(1);
    expect(f.jev.evaluate).toHaveBeenCalledOnce();
});
it('preserves a durable page position and expanded recovery window across worker restarts', async () => {
    const f = fixture();
    const originalJob = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...originalJob, checkpoint: { revision: 3, phase: 'backfill', from: 0, until: 5000, startHistoryId: '100', pageOffset: 1, pageFingerprint: createHash('sha256').update(JSON.stringify(['already_saved', 'after_initial_window'])).digest('hex') } });
    f.gmail.messages.mockResolvedValue({ messages: [{ id: 'already_saved' }, { id: 'after_initial_window' }] });
    f.gmail.message.mockResolvedValue({ ...await f.gmail.message(), messageId: 'after_initial_window', receivedAt: 4000 });
    f.gmail.message.mockClear();
    await createMailWorker(f).sync(source);
    expect(f.gmail.message).toHaveBeenCalledExactlyOnceWith('after_initial_window');
    expect(f.rows.has('after_initial_window')).toBe(true);
    expect(f.checkpoint().until).toBe(5000);
    expect(f.checkpoint().pageOffset).toBe(0);
});
it('rejects an unbounded persisted page position before provider dispatch', async () => {
    const f = fixture();
    const job = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: { revision: 0, phase: 'backfill', from: 0, until: 1000, pageOffset: 501 } });
    await expect(createMailWorker(f).sync(source)).rejects.toThrow();
    expect(f.gmail.profile).not.toHaveBeenCalled();
    expect(f.repository.releaseSync).toHaveBeenCalledOnce();
});
it.each(['unknown', 'result_expired'] as const)('durably defers %s outcomes so later backlog messages can be classified', async (outcome) => {
    const f = fixture();
    f.gmail.messages.mockResolvedValue({ messages: Array.from({ length: 21 }, (_, i) => ({ id: `m${i}` })) });
    const original = f.gmail.message.getMockImplementation()!;
    f.gmail.message.mockImplementation(async (id: any) => ({ ...await original(), messageId: id }));
    for (let i = 0; i < 20; i++)
        f.jev.evaluate.mockRejectedValueOnce(new JevServiceError(outcome));
    const worker = createMailWorker(f);
    await worker.sync(source);
    expect(f.repository.recordDeferredClassification).toHaveBeenCalledTimes(20);
    expect(f.repository.recordDeferredClassification).toHaveBeenCalledWith(expect.objectContaining({ outcome, contextKind: 'verified', modelPolicyVersion: 'newsletter-jev-v1' }));
    await worker.sync(source);
    expect(f.jev.evaluate).toHaveBeenCalledTimes(21);
    expect(f.repository.saveClassification).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'm20' }));
});
it('keeps ordinary transient classification failures retryable', async () => {
    const f = fixture();
    f.jev.evaluate.mockRejectedValueOnce(new JevServiceError('unavailable'));
    const worker = createMailWorker(f);
    await worker.sync(source);
    await worker.sync(source);
    expect(f.repository.recordDeferredClassification).not.toHaveBeenCalled();
    expect(f.jev.evaluate).toHaveBeenCalledTimes(2);
    expect(f.repository.saveClassification).toHaveBeenCalledOnce();
});
it('observes successful body and classification reuse without repeated fetch or paid service calls', async () => {
    const f = fixture();
    const observeUsage = vi.fn();
    const worker = createMailWorker({ ...f, observeUsage });
    await worker.sync(source);
    expect(observeUsage).toHaveBeenCalledExactlyOnceWith(source, 'aiClassificationCalls');
    // Force a historical reconciliation; the durable object and seven answers are reused.
    const originalJob = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...originalJob, checkpoint: null });
    const row = f.rows.get('m1');
    row.classification = await f.repository.getClassification({ fingerprint: row.object.digest });
    await worker.sync(source);
    expect(observeUsage).toHaveBeenCalledWith(source, 'reusedBodies');
    expect(observeUsage).toHaveBeenCalledWith(source, 'classificationReuse');
    expect(f.gmail.message).toHaveBeenCalledOnce();
    expect(f.jev.evaluate).toHaveBeenCalledOnce();
    f.repository.listClassificationCandidates.mockResolvedValueOnce([row]);
    await worker.sync(source);
    expect(observeUsage.mock.calls.filter(([, event]) => event === 'classificationReuse')).toHaveLength(2);
});
it('does not count partial records, failed integrity reads, or unfunded AI as reuse/paid attempts', async () => {
    const f = fixture();
    const observeUsage = vi.fn();
    f.fundedReady.mockResolvedValue(false);
    await createMailWorker({ ...f, observeUsage }).sync(source);
    expect(observeUsage).not.toHaveBeenCalled();
    const job = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: null });
    f.objects.read.mockRejectedValueOnce(Error('integrity'));
    await expect(createMailWorker({ ...f, observeUsage }).sync(source)).rejects.toThrow();
    expect(observeUsage).not.toHaveBeenCalled();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: null });
    f.rows.set('m1', { ...f.rows.get('m1'), partialReason: 'content_too_large', object: null });
    await createMailWorker({ ...f, observeUsage }).sync(source);
    expect(observeUsage).not.toHaveBeenCalled();
});
it.each(['missing', 'corrupt'] as const)('refetches a %s retained object once while reusing its durable Jev scores', async (kind) => {
    const { MailContentIntegrityError } = await import('../../packages/gateway/src/mail/types.js');
    const f = fixture();
    const worker = createMailWorker(f);
    await worker.sync(source);
    const job = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: null });
    f.objects.read.mockRejectedValueOnce(kind === 'missing' ? Object.assign(Error('missing'), { code: 'ENOENT' }) : new MailContentIntegrityError());
    expect((await worker.sync(source)).savedCount).toBe(1);
    expect(f.gmail.message).toHaveBeenCalledTimes(2);
    expect(f.jev.evaluate).toHaveBeenCalledOnce();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: null });
    await worker.sync(source);
    expect(f.gmail.message).toHaveBeenCalledTimes(2);
});
it('preserves disk authorization/outage failures rather than treating them as a missing body', async () => {
    const f = fixture();
    const worker = createMailWorker(f);
    await worker.sync(source);
    const job = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: null });
    f.objects.read.mockRejectedValueOnce(Object.assign(Error('denied'), { code: 'EACCES' }));
    await expect(worker.sync(source)).rejects.toThrow('denied');
    expect(f.gmail.message).toHaveBeenCalledOnce();
});
it('persists generic source failure after a timeout and clears it only after successful durable progress', async () => {
    const f = fixture();
    const recordSyncFailure = vi.fn(async (input: any) => {
        await f.repository.checkpointSync({ ...input, checkpoint: { ...input.checkpoint, revision: input.baseRevision + 1, lastError: 'sync_unavailable', failureAt: input.failureAt } });
        return true;
    });
    const worker = createMailWorker({ ...f, repository: { ...f.repository, recordSyncFailure } });
    f.gmail.history.mockRejectedValueOnce(Error('secret provider timeout'));
    await expect(worker.sync(source)).rejects.toThrow();
    expect(f.checkpoint()).toMatchObject({ lastError: 'sync_unavailable', failureAt: expect.any(String) });
    expect(JSON.stringify(f.checkpoint())).not.toContain('secret');
    await worker.sync(source);
    expect(f.checkpoint().lastError).toBeUndefined();
    expect(f.checkpoint().failureAt).toBeUndefined();
});
it('does not interpret a private-directory integrity failure as damaged message content', async () => {
    const { MailArchiveError } = await import('../../packages/gateway/src/mail/types.js');
    const f = fixture();
    const worker = createMailWorker(f);
    await worker.sync(source);
    const job = await f.repository.getSyncJob();
    f.repository.getSyncJob.mockResolvedValueOnce({ ...job, checkpoint: null });
    f.objects.read.mockRejectedValueOnce(new MailArchiveError('integrity'));
    await expect(worker.sync(source)).rejects.toBeInstanceOf(MailArchiveError);
    expect(f.gmail.message).toHaveBeenCalledOnce();
});
it('keeps the last real successful synchronization timestamp while a later delta fails', async () => {
    const f = fixture();
    const recordSyncFailure = vi.fn(async (input: any) => {
        await f.repository.checkpointSync({ ...input, checkpoint: { ...input.checkpoint, revision: input.baseRevision + 1, lastError: 'sync_unavailable', failureAt: input.failureAt } });
        return true;
    });
    const worker = createMailWorker({ ...f, repository: { ...f.repository, recordSyncFailure } });
    await worker.sync(source);
    const completedAt = f.checkpoint().completedAt;
    f.gmail.history.mockRejectedValueOnce(Error('timeout'));
    await expect(worker.sync(source)).rejects.toThrow();
    expect(f.checkpoint().completedAt).toBe(completedAt);
    expect(f.checkpoint().lastError).toBe('sync_unavailable');
});
it('preserves the source failure and releases its job even when error-state storage is unavailable', async () => {
    const f = fixture();
    f.gmail.history.mockRejectedValueOnce(Error('source timeout'));
    f.repository.recordSyncFailure.mockRejectedValueOnce(Error('database outage'));
    await expect(createMailWorker(f).sync(source)).rejects.toThrow('source timeout');
    expect(f.repository.releaseSync).toHaveBeenCalledOnce();
});
