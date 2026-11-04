import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { CHATGPT_PLAN_PEER_MAX_SEQUENCE, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS, chatGptPlanPeerRequestId, ChatGptPlanPeerConnectSchema, ChatGptPlanPeerReplySchema, ChatGptPlanPeerSessionSchema, ChatGptPlanPeerPollV2RequestSchema, chatGptPlanPeerProof, type ChatGptPlanPeerRequest, type ChatGptPlanPeerSnapshot, type BotProviderConnection, type CanonicalChatModelSelection } from '@matrix-os/contracts';
import type { BotExecutor } from './repositories/shared.js';
import type { PiRuntimeBinding } from './runtime-registry.js';
import { isManagedPiBinding } from './runtime-registry.js';
import { BotRouteError } from './route-resolver.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
import { createChunkReceipt, createPeerReplyReceipts } from './chatgpt-plan-reply-receipts.js';
import { createPeerPollDelivery } from './chatgpt-plan-poll-delivery.js';
import { ChatGptPlanPeerError } from './chatgpt-plan-peer-error.js';
import { inferenceChunks } from './inference-stream.js';
import { ChatGptPlanApprovedRoutineSchema, type ChatGptPlanApprovedRoutine } from '@matrix-os/contracts';
export { ChatGptPlanPeerError } from './chatgpt-plan-peer-error.js';
type InferenceReply = {
    status: number;
    headers: Record<string, string>;
    body: string;
};
type PendingBase = {
    reject(error: unknown): void;
    abort(): void;
    signal: AbortSignal;
    timer: ReturnType<typeof setTimeout>;
};
type Pending = PendingBase & (
    { kind: 'legacy'; resolve(reply: InferenceReply): void }
    | { kind: 'stream'; chunk(sequence: number, body: string, http: boolean): Promise<void>; end(sequence: number): void }
);
type Peer = {
    sessionId: string;
    sequence: number;
    snapshot: ChatGptPlanPeerSnapshot;
    lastTouched: number;
    requests: ChatGptPlanPeerRequest[];
    pending: Map<string, Pending>;
    wake?: () => void;
    polling: boolean;
    replyReceipts?: ReturnType<typeof createPeerReplyReceipts>;
    mode?: 1 | 2;
    delivery?: ReturnType<typeof createPeerPollDelivery>;
    inferenceStream?: true;
    approvedRoutines?: true;
};
/** Owner-authenticated local device, pinned public key, and one explicit source.
 * Holds no OAuth token and never contacts OpenAI from the managed gateway. */
export function createChatGptPlanPeers(deps: {
    db: BotExecutor;
    ownerId: string;
    computerId: string;
    now?: () => number;
    /** Must check current durable approval, private target, definition/source and execution lease. */
    authorizeRoutine?(binding: PiRuntimeBinding, signal: AbortSignal): Promise<ChatGptPlanApprovedRoutine>;
}) {
    const now = deps.now ?? Date.now;
    const compatible = (model: ChatGptPlanPeerSnapshot['models'][number]) => model.contextWindow >= 8192 && model.maxOutputTokens >= 256;
    const challenges = new Map<string, { expires: number; epoch: number; replacement?: { deviceId: string; publicKey: string } }>(); // cap32, expire before admission
    let peer: Peer | undefined;
    let challengeEpoch = 0;
    let closed = false;
    let connecting = false;
    const scope = (owner: string) => {
        if (closed || !deps.ownerId || !deps.computerId)
            throw new ChatGptPlanPeerError('unavailable');
        if (owner !== deps.ownerId)
            throw new ChatGptPlanPeerError('forbidden');
    };
    const drop = () => {
        const previous = peer;
        peer = undefined;
        if (!previous)
            return;
        previous.wake?.();
        previous.delivery?.close();
        previous.replyReceipts?.close();
        for (const p of previous.pending.values()) {
            clearTimeout(p.timer);
            p.signal.removeEventListener('abort', p.abort);
            p.reject(new ChatGptPlanPeerError('unavailable'));
        }
        previous.pending.clear();
        previous.requests.length = 0;
    };
    const current = () => {
        if (peer && (now() - peer.lastTouched > 30000 || peer.delivery?.expired())) {
            drop();
        }
        return peer;
    };
    const session = (owner: string, input: unknown, touch = true) => {
        scope(owner);
        const parsed = ChatGptPlanPeerSessionSchema.safeParse(input);
        const selected = current();
        if (!parsed.success)
            throw new ChatGptPlanPeerError('invalid_request');
        if (!selected || !timingSafeEqual(Buffer.from(parsed.data.sessionId), Buffer.from(selected.sessionId)))
            throw new ChatGptPlanPeerError('unavailable');
        if (touch) selected.lastTouched = now();
        return selected;
    };
    const timer = setInterval(current, 5000);
    timer.unref();
    const enqueue = (p: Peer, request: ChatGptPlanPeerRequest) => {
        if (p.delivery) p.delivery.enqueue(request);
        else { p.requests.push(request); p.wake?.(); }
    };
    const cancel = (p: Peer, id: string) => {
        if (p.delivery) p.delivery.cancel(id);
        else {
            p.requests = p.requests.filter(request => request.id !== id);
            if (p.requests.length < 32) p.requests.push({ version: 1, action: 'cancel', id });
            p.wake?.();
        }
    };
    const authorize = async (binding: PiRuntimeBinding, signal: AbortSignal) => {
        const selected = current();
        const matches = () => {
            const s = selected?.snapshot, b = binding.subscription;
            return !closed && !signal.aborted && selected !== undefined && current() === selected && binding.ownerId === deps.ownerId
                && b?.computerId === deps.computerId && b.peerId === selected.sessionId
                && Boolean(s?.enabled && s.accountId === b?.accountId && s.grantRevision === b?.grantRevision
                    && s.models.some(m => m.id === binding.route.modelId));
        };
        if (!matches()) throw new ChatGptPlanPeerError('unavailable');
        let approvedRoutine: ChatGptPlanApprovedRoutine | undefined;
        if (binding.requestClass === 'background' && !selected!.snapshot.background) {
            if (isManagedPiBinding(binding) || !selected!.approvedRoutines || !deps.authorizeRoutine) throw new ChatGptPlanPeerError('unavailable');
            approvedRoutine = ChatGptPlanApprovedRoutineSchema.parse(await deps.authorizeRoutine(binding, signal));
            if (approvedRoutine.ownerId !== binding.ownerId || approvedRoutine.botId !== binding.botId
                || approvedRoutine.chatId !== binding.chatId || approvedRoutine.taskId !== binding.taskId || approvedRoutine.runId !== binding.runId)
                throw new ChatGptPlanPeerError('unavailable');
        }
        // A database wait cannot lend old approval to a replacement/revoked peer.
        if (!matches()) throw new ChatGptPlanPeerError('unavailable');
        return { peer: selected!, approvedRoutine };
    };
    const command = (p: Peer, binding: PiRuntimeBinding, body: string, stream = false, approvedRoutine?: ChatGptPlanApprovedRoutine) => {
        const sequence = p.sequence + 1;
        const request: Extract<ChatGptPlanPeerRequest, { action: 'infer' }> = { version: 1, action: 'infer',
            id: chatGptPlanPeerRequestId(p.sessionId, sequence), sequence, expiresAt: new Date(now() + CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS).toISOString(),
            accountId: binding.subscription!.accountId, grantRevision: binding.subscription!.grantRevision, computerId: deps.computerId,
            requestClass: binding.requestClass, runId: binding.runId, model: binding.route.modelId, body, ...(stream ? { responseMode: 'stream' } : {}),
            ...(approvedRoutine ? { approvedRoutine } : {}) };
        if (p.delivery && !p.delivery.canAdmit(request)) throw new ChatGptPlanPeerError('unavailable');
        p.sequence = sequence;
        return request;
    };
    const service = {
        authorizeReply(owner: string) { scope(owner); },
        capabilities(owner: string, input: unknown, includeReplyDeliveryV2 = false, includeInferenceStream = false, includeApprovedRoutines = false) {
            const p = session(owner, input, false);
            if (includeReplyDeliveryV2 && !p.replyReceipts) {
                if (p.mode !== undefined) throw new ChatGptPlanPeerError('conflict');
                p.replyReceipts = createPeerReplyReceipts(now);
            }
            if (includeInferenceStream) p.inferenceStream = true;
            if (includeApprovedRoutines && deps.authorizeRoutine) p.approvedRoutines = true;
            return { version: 1 as const, sessionId: p.sessionId, pollDeliveryVersion: 2 as const,
                ...(includeInferenceStream ? { inferenceStream: true as const } : {}),
                ...(includeApprovedRoutines && p.approvedRoutines ? { approvedRoutines: true as const } : {}),
                ...(includeReplyDeliveryV2 ? { replyDeliveryVersion: 2 as const } : {}) };
        },
        challenge(owner: string) {
            scope(owner);
            for (const [id, at] of challenges)
                if (at.expires <= now())
                    challenges.delete(id);
            if (challenges.size >= 32)
                throw new ChatGptPlanPeerError('unavailable');
            const challenge = randomBytes(32).toString('hex');
            const expires = now() + 120000;
            challenges.set(challenge, { expires, epoch: ++challengeEpoch });
            return { version: 1 as const, challenge, ownerId: deps.ownerId, computerId: deps.computerId, expiresAt: new Date(expires).toISOString() };
        },
        async rebindChallenge(owner: string) {
            scope(owner);
            const pin = await deps.db.selectFrom('bot_chatgpt_plan_devices').selectAll()
                .where('owner_id', '=', owner).where('computer_id', '=', deps.computerId).executeTakeFirst();
            if (!pin) throw new ChatGptPlanPeerError('conflict');
            const challenge = service.challenge(owner);
            const attempt = challenges.get(challenge.challenge)!;
            attempt.replacement = { deviceId: pin.device_id, publicKey: pin.public_key };
            return { ...challenge, replacement: { expectedDeviceId: pin.device_id } };
        },
        async connect(owner: string, input: unknown) {
            scope(owner);
            // One registry owns this Computer's peer. Bound enrollment concurrency
            // so a slow previous write cannot publish or drop a newer session.
            if (connecting) throw new ChatGptPlanPeerError('unavailable');
            connecting = true;
            try {
                const parsed = ChatGptPlanPeerConnectSchema.safeParse(input);
                if (!parsed.success)
                    throw new ChatGptPlanPeerError('invalid_request');
                const { challenge, publicKey, signature, snapshot, replacement } = parsed.data;
                const attempt = challenges.get(challenge);
                challenges.delete(challenge);
                if (!attempt || attempt.expires <= now() || attempt.epoch !== challengeEpoch
                    || attempt.replacement?.deviceId !== replacement?.expectedDeviceId)
                    throw new ChatGptPlanPeerError('invalid_request');
                const der = Buffer.from(publicKey, 'base64url');
                try {
                    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
                    if (key.asymmetricKeyType !== 'ed25519' || createHash('sha256').update(der).digest('hex') !== snapshot.deviceId
                        || !verify(null, Buffer.from(chatGptPlanPeerProof({ challenge, ownerId: deps.ownerId, computerId: deps.computerId, snapshot, replacement })), key, Buffer.from(signature, 'base64url')))
                        throw new ChatGptPlanPeerError('invalid_request');
                }
                catch (error) {
                    if (!(error instanceof ChatGptPlanPeerError))
                        console.warn('[chatgpt-plan] Device proof rejected:', error instanceof Error ? error.name : 'UnknownError');
                    throw new ChatGptPlanPeerError('invalid_request');
                }
                // A single conditional write is the replacement authority. Never upsert a
                // different key from ordinary reconnect or retry. The saved old key is
                // server-owned and the expected device ID is included in signed bytes.
                if (attempt.replacement) {
                    const updated = await deps.db.updateTable('bot_chatgpt_plan_devices')
                        .set({ device_id: snapshot.deviceId, public_key: publicKey })
                        .where('owner_id', '=', owner).where('computer_id', '=', deps.computerId)
                        .where('device_id', '=', attempt.replacement.deviceId)
                        .where('public_key', '=', attempt.replacement.publicKey)
                        .returning('device_id').executeTakeFirst();
                    if (!updated) throw new ChatGptPlanPeerError('conflict');
                    drop(); // Durable replacement immediately revokes the previous peer.
                    console.info('[chatgpt-plan] Device binding replaced');
                } else await deps.db.insertInto('bot_chatgpt_plan_devices').values({ owner_id: owner, computer_id: deps.computerId, device_id: snapshot.deviceId, public_key: publicKey })
                    .onConflict(c => c.columns(['owner_id', 'computer_id']).doNothing()).execute();
                const pin = await deps.db.selectFrom('bot_chatgpt_plan_devices').selectAll().where('owner_id', '=', owner).where('computer_id', '=', deps.computerId).executeTakeFirst();
                if (!pin || pin.device_id !== snapshot.deviceId || pin.public_key !== publicKey)
                    throw new ChatGptPlanPeerError('conflict');
                if (closed || attempt.epoch !== challengeEpoch)
                    throw new ChatGptPlanPeerError('unavailable');
                drop();
                peer = { sessionId: randomUUID(), sequence: 0, snapshot, lastTouched: now(), requests: [], pending: new Map(), polling: false };
                return { version: 1 as const, sessionId: peer.sessionId };
            } finally { connecting = false; }
        },
        async poll(owner: string, input: unknown) {
            const p = session(owner, input, false);
            if (p.polling || p.mode === 2)
                throw new ChatGptPlanPeerError('conflict');
            p.lastTouched = now();
            p.mode = 1;
            p.polling = true;
            try {
                if (!p.requests.length)
                    await new Promise<void>(resolve => {
                        const timeout = setTimeout(() => {
                            if (p.wake === wake) p.wake = undefined;
                            resolve();
                        }, 10000);
                        const wake = () => {
                            clearTimeout(timeout);
                            p.wake = undefined;
                            resolve();
                        };
                        p.wake = wake;
                    });
                if (current() !== p)
                    throw new ChatGptPlanPeerError('unavailable');
                p.lastTouched = now();
                return { version: 1 as const, requests: p.requests.splice(0, 32) };
            }
            finally {
                p.polling = false;
            }
        },
        pollV2(owner: string, input: unknown, signal: AbortSignal) {
            scope(owner);
            const parsed = ChatGptPlanPeerPollV2RequestSchema.safeParse(input);
            if (!parsed.success) throw new ChatGptPlanPeerError('invalid_request');
            const p = session(owner, { version: 1, sessionId: parsed.data.sessionId }, false);
            if (p.mode === 1) throw new ChatGptPlanPeerError('conflict');
            const delivery = p.delivery ?? createPeerPollDelivery({ sessionId: p.sessionId, now,
                current: () => current() === p, expire: () => { if (peer === p) drop(); } });
            try {
                if (!p.delivery) for (const request of p.requests) if (request.action === 'infer') delivery.enqueue(request);
                const result = delivery.poll(parsed.data.ackThrough, signal);
                p.delivery = delivery; p.mode = 2; p.requests = []; p.lastTouched = now();
                return result.then(emission => { emission.verify(); p.lastTouched = now(); return emission; });
            } catch (error: unknown) { if (!p.delivery) delivery.close(); throw error; }
        },
        reply(owner: string, input: unknown, httpSignal?: AbortSignal) {
            httpSignal?.throwIfAborted();
            const parsed = ChatGptPlanPeerReplySchema.safeParse(input);
            if (!parsed.success)
                throw new ChatGptPlanPeerError('invalid_request');
            const p = session(owner, { version: 1, sessionId: parsed.data.sessionId });
            const pending = p.pending.get(parsed.data.id);
            const reply = parsed.data;
            if (!pending) {
                if (reply.ok && 'stream' in reply && reply.stream === 'end' && p.replyReceipts?.ended(reply.id, reply.sequence))
                    return { version: 1 as const, ok: true as const, sessionId: reply.sessionId, id: reply.id, sequence: reply.sequence };
                throw new ChatGptPlanPeerError('conflict');
            }
            if (reply.ok && 'stream' in reply) {
                if (pending.kind !== 'stream') throw new ChatGptPlanPeerError('conflict');
                if (reply.stream === 'chunk') {
                    const { sessionId, id, sequence } = reply;
                    return pending.chunk(sequence, reply.body, Boolean(httpSignal)).then(() => ({ version: 1 as const, ok: true as const, sessionId, id, sequence }));
                }
                pending.end(reply.sequence);
                p.replyReceipts?.remember(reply.id, reply.sequence);
                return { version: 1 as const, ok: true as const, sessionId: reply.sessionId, id: reply.id, sequence: reply.sequence };
            }
            if (reply.ok && (pending.kind !== 'legacy' || !('status' in reply))) throw new ChatGptPlanPeerError('conflict');
            p.pending.delete(parsed.data.id);
            clearTimeout(pending.timer);
            pending.signal.removeEventListener('abort', pending.abort);
            if (reply.ok && 'status' in reply && pending.kind === 'legacy')
                pending.resolve({ status: reply.status, headers: reply.headers, body: reply.body });
            else
                pending.reject(new ChatGptPlanPeerError('unavailable'));
            return { version: 1 as const, ok: true as const };
        },
        disconnect(owner: string, input: unknown) {
            session(owner, input);
            drop();
            return { version: 1 as const, ok: true as const };
        },
        async observe(owner: string): Promise<BotProviderConnection> {
            scope(owner);
            const selected = current();
            const saved = selected?.snapshot;
            const reason = !selected ? 'unsupported_runtime' : !saved?.accountId ? 'authentication_required' : !saved.enabled || !saved.models.some(compatible) ? 'authorization_required' : undefined;
            return { id: 'matrix_chatgpt_plan', providerId: 'openai', executionKind: 'direct_pi', availability: reason ? selected && saved?.accountId ? 'setup_required' : 'unavailable' : 'available',
                ...(reason ? { unavailableReason: reason } : {}), ...(saved?.accountId ? { accountId: saved.accountId } : {}),
                models: saved?.accountId ? saved.models.filter(compatible).map(m => ({ id: m.id, displayName: m.displayName, input: m.input })) : [],
                authorization: { revision: saved?.grantRevision ?? 0, enabled: !reason, background: !reason && Boolean(saved?.background) }, coordinatorFunding: 'subscription' };
        },
        async resolve(selection: CanonicalChatModelSelection, owner: string, requestClass: 'interactive' | 'background' | 'routine') {
            scope(owner);
            const selected = current();
            const saved = selected?.snapshot;
            const opts = new Map(selection.options?.map(o => [o.id, o.value]));
            const model = saved?.models.find(m => m.id === selection.model && compatible(m));
            if (selection.instanceId !== 'matrix_chatgpt_plan' || !selected || !saved?.enabled || !saved.accountId || !model || opts.size !== 2 || selection.options?.length !== 2
                || opts.get('accountId') !== saved.accountId || opts.get('grantRevision') !== String(saved.grantRevision)
                || requestClass === 'background' && !saved.background
                || requestClass === 'routine' && !saved.background && !selected.approvedRoutines)
                throw new BotRouteError('model_unavailable');
            return { route: { api: 'openai-responses' as const, modelId: model.id, input: model.input, contextWindow: model.contextWindow, maxOutputTokens: Math.min(16384, model.maxOutputTokens) },
                accessSourceId: 'matrix_chatgpt_plan' as const, subscription: { accountId: saved.accountId, computerId: deps.computerId, grantRevision: saved.grantRevision, peerId: selected.sessionId } };
        },
        async revalidate(binding: PiRuntimeBinding, signal: AbortSignal) {
            try { await authorize(binding, signal); return true; }
            catch (error: unknown) {
                if (!(error instanceof ChatGptPlanPeerError)) console.warn('[chatgpt-plan] Occurrence unavailable', error instanceof Error ? error.name : 'UnknownError');
                return false;
            }
        },
        async infer(binding: PiRuntimeBinding, body: string, signal: AbortSignal): Promise<InferenceReply> {
            if (!await service.revalidate(binding, signal) || signal.aborted)
                throw new ChatGptPlanPeerError('unavailable');
            const { peer: p, approvedRoutine } = await authorize(binding, signal);
            if (p.pending.size >= 4 || p.requests.length >= 32 || p.sequence >= CHATGPT_PLAN_PEER_MAX_SEQUENCE)
                throw new ChatGptPlanPeerError('unavailable');
            const request = command(p, binding, body, false, approvedRoutine);
            const { id } = request;
            return new Promise<InferenceReply>((resolve, reject) => {
                const abort = () => {
                    const pending = p.pending.get(id);
                    if (!pending)
                        return;
                    p.pending.delete(id);
                    clearTimeout(pending.timer);
                    signal.removeEventListener('abort', abort);
                    cancel(p, id);
                    reject(new ChatGptPlanPeerError('unavailable'));
                };
                const timeout = setTimeout(abort, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS);
                p.pending.set(id, { kind: 'legacy', resolve, reject, signal, abort, timer: timeout });
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) {
                    abort();
                    return;
                }
                enqueue(p, request);
            });
        },
        async inferStream(binding: PiRuntimeBinding, body: string, signal: AbortSignal): Promise<Omit<InferenceReply, 'body'> & { body: AsyncIterableIterator<string> }> {
            if (!await service.revalidate(binding, signal) || signal.aborted)
                throw new ChatGptPlanPeerError('unavailable');
            const { peer: p, approvedRoutine } = await authorize(binding, signal);
            if (!p || p.sessionId !== binding.subscription?.peerId)
                throw new ChatGptPlanPeerError('unavailable');
            // Released native peers have strict schemas. Select their bounded
            // whole-body path before dispatch; never replay a streamed request.
            if (!p.inferenceStream) {
                const response = await service.infer(binding, body, signal);
                return { ...response, body: (async function* () {
                    for (const chunk of inferenceChunks(response.body)) {
                        signal.throwIfAborted();
                        yield chunk;
                    }
                })() };
            }
            if (p.pending.size >= 4 || p.requests.length >= 32 || p.sequence >= CHATGPT_PLAN_PEER_MAX_SEQUENCE)
                throw new ChatGptPlanPeerError('unavailable');
            const request = command(p, binding, body, true, approvedRoutine);
            const { id } = request;
            type Read = { resolve(value: IteratorResult<string>): void; reject(error: unknown): void };
            type Chunk = { value: string; acknowledge(): void; reject(error: unknown): void };
            let waiting: Read | undefined;
            let buffered: Chunk | undefined;
            const receiptChunk = createChunkReceipt();
            let nextSequence = 0;
            let ended = false;
            let failure: unknown;
            const unavailable = () => new ChatGptPlanPeerError('unavailable');
            const fail = (error: unknown) => {
                failure = error;
                buffered?.reject(error);
                buffered = undefined;
                waiting?.reject(error);
                waiting = undefined;
            };
            const remove = () => {
                const pending = p.pending.get(id);
                if (!pending) return false;
                p.pending.delete(id);
                clearTimeout(pending.timer);
                signal.removeEventListener('abort', pending.abort);
                return true;
            };
            const abort = () => {
                if (!remove()) return;
                cancel(p, id);
                fail(unavailable());
            };
            const resumeIdle = () => {
                if (!p.pending.has(id) || signal.aborted) return;
                clearTimeout(pending.timer);
                pending.timer = setTimeout(abort, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS);
            };
            const iterator: AsyncIterableIterator<string> = {
                [Symbol.asyncIterator]() { return this; },
                next() {
                    if (failure) return Promise.reject(failure);
                    if (buffered) {
                        const chunk = buffered;
                        buffered = undefined;
                        if (chunk.value.length) resumeIdle();
                        chunk.acknowledge();
                        return Promise.resolve({ value: chunk.value, done: false as const });
                    }
                    if (ended) return Promise.resolve({ value: undefined, done: true as const });
                    if (waiting) return Promise.reject(new ChatGptPlanPeerError('conflict'));
                    return new Promise<IteratorResult<string>>((resolve, reject) => { waiting = { resolve, reject }; });
                },
                async return() {
                    abort();
                    return { value: undefined, done: true as const };
                },
            };
            // expiresAt fences admission/replay. An admitted stream keeps its
            // bounded idle lease only through valid, nonempty ordered chunks.
            // A bounded received chunk awaiting consumption is backpressure.
            const timer = setTimeout(abort, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS);
            const pending: Pending = {
                kind: 'stream', signal, abort, timer, reject: fail,
                chunk(chunkSequence, value, http) {
                    const accept = () => {
                        if (chunkSequence !== nextSequence || buffered || ended || failure || signal.aborted)
                            throw new ChatGptPlanPeerError('conflict');
                        nextSequence += 1;
                        return new Promise<void>((acknowledge, reject) => {
                            if (waiting) {
                                if (value.length) resumeIdle();
                                const read = waiting;
                                waiting = undefined;
                                read.resolve({ value, done: false });
                                acknowledge();
                            } else {
                                if (value.length) clearTimeout(pending.timer);
                                buffered = { value, acknowledge, reject };
                            }
                        });
                    };
                    return p.replyReceipts ? receiptChunk(chunkSequence, value, accept, http) : accept();
                },
                end(endSequence) {
                    if (endSequence !== nextSequence || buffered || ended || failure)
                        throw new ChatGptPlanPeerError('conflict');
                    ended = true;
                    remove();
                    waiting?.resolve({ value: undefined, done: true });
                    waiting = undefined;
                },
            };
            p.pending.set(id, pending);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) {
                abort();
                throw unavailable();
            }
            else {
                enqueue(p, request);
            }
            return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: iterator };
        },
        close() {
            closed = true;
            clearInterval(timer);
            drop();
            challenges.clear();
        },
    } satisfies ChatGptPlanAuthority & Record<string, unknown>;
    return service;
}
export type ChatGptPlanPeers = ReturnType<typeof createChatGptPlanPeers>;
