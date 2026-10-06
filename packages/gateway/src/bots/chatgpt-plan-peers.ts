import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { ChatGptPlanPeerConnectSchema, ChatGptPlanPeerReplySchema, ChatGptPlanPeerSessionSchema, chatGptPlanPeerProof, type ChatGptPlanPeerRequest, type ChatGptPlanPeerSnapshot, type BotProviderConnection, type CanonicalChatModelSelection } from '@matrix-os/contracts';
import type { BotExecutor } from './repositories/shared.js';
import type { PiRuntimeBinding } from './runtime-registry.js';
import { BotRouteError } from './route-resolver.js';
import type { ChatGptPlanAuthority } from './chatgpt-plan.js';
export class ChatGptPlanPeerError extends Error {
    constructor(readonly code: 'forbidden' | 'invalid_request' | 'unavailable' | 'conflict') {
        super(code);
    }
}
type InferenceReply = {
    status: number;
    headers: Record<string, string>;
    body: string;
};
type Pending = {
    resolve(reply: InferenceReply): void;
    reject(error: unknown): void;
    abort(): void;
    signal: AbortSignal;
    timer: ReturnType<typeof setTimeout>;
};
type Peer = {
    sessionId: string;
    snapshot: ChatGptPlanPeerSnapshot;
    lastTouched: number;
    requests: ChatGptPlanPeerRequest[];
    pending: Map<string, Pending>;
    wake?: () => void;
    polling: boolean;
};
/** Owner-authenticated local device, pinned public key, and one explicit source.
 * Holds no OAuth token and never contacts OpenAI from the managed gateway. */
export function createChatGptPlanPeers(deps: {
    db: BotExecutor;
    ownerId: string;
    computerId: string;
    now?: () => number;
}) {
    const now = deps.now ?? Date.now;
    const compatible = (model: ChatGptPlanPeerSnapshot['models'][number]) => model.contextWindow >= 8192 && model.maxOutputTokens >= 256;
    const challenges = new Map<string, { expires: number; epoch: number }>(); // cap32, expire before admission
    let peer: Peer | undefined;
    let challengeEpoch = 0;
    let closed = false;
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
        for (const p of previous.pending.values()) {
            clearTimeout(p.timer);
            p.signal.removeEventListener('abort', p.abort);
            p.reject(new ChatGptPlanPeerError('unavailable'));
        }
        previous.pending.clear();
        previous.requests.length = 0;
    };
    const current = () => {
        if (peer && now() - peer.lastTouched > 30000) {
            drop();
        }
        return peer;
    };
    const session = (owner: string, input: unknown) => {
        scope(owner);
        const parsed = ChatGptPlanPeerSessionSchema.safeParse(input);
        const selected = current();
        if (!parsed.success)
            throw new ChatGptPlanPeerError('invalid_request');
        if (!selected || !timingSafeEqual(Buffer.from(parsed.data.sessionId), Buffer.from(selected.sessionId)))
            throw new ChatGptPlanPeerError('unavailable');
        selected.lastTouched = now();
        return selected;
    };
    const timer = setInterval(current, 5000);
    timer.unref();
    const service = {
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
        async connect(owner: string, input: unknown) {
            scope(owner);
            const parsed = ChatGptPlanPeerConnectSchema.safeParse(input);
            if (!parsed.success)
                throw new ChatGptPlanPeerError('invalid_request');
            const { challenge, publicKey, signature, snapshot } = parsed.data;
            const attempt = challenges.get(challenge);
            challenges.delete(challenge);
            if (!attempt || attempt.expires <= now() || attempt.epoch !== challengeEpoch)
                throw new ChatGptPlanPeerError('invalid_request');
            const der = Buffer.from(publicKey, 'base64url');
            try {
                const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
                if (key.asymmetricKeyType !== 'ed25519' || createHash('sha256').update(der).digest('hex') !== snapshot.deviceId
                    || !verify(null, Buffer.from(chatGptPlanPeerProof({ challenge, ownerId: deps.ownerId, computerId: deps.computerId, snapshot })), key, Buffer.from(signature, 'base64url')))
                    throw new ChatGptPlanPeerError('invalid_request');
            }
            catch (error) {
                if (!(error instanceof ChatGptPlanPeerError))
                    console.warn('[chatgpt-plan] Device proof rejected:', error instanceof Error ? error.name : 'UnknownError');
                throw new ChatGptPlanPeerError('invalid_request');
            }
            await deps.db.insertInto('bot_chatgpt_plan_devices').values({ owner_id: owner, computer_id: deps.computerId, device_id: snapshot.deviceId, public_key: publicKey })
                .onConflict(c => c.columns(['owner_id', 'computer_id']).doNothing()).execute();
            const pin = await deps.db.selectFrom('bot_chatgpt_plan_devices').selectAll().where('owner_id', '=', owner).where('computer_id', '=', deps.computerId).executeTakeFirst();
            if (!pin || pin.device_id !== snapshot.deviceId || pin.public_key !== publicKey)
                throw new ChatGptPlanPeerError('conflict');
            if (closed || attempt.epoch !== challengeEpoch)
                throw new ChatGptPlanPeerError('unavailable');
            drop();
            peer = { sessionId: randomUUID(), snapshot, lastTouched: now(), requests: [], pending: new Map(), polling: false };
            return { version: 1 as const, sessionId: peer.sessionId };
        },
        async poll(owner: string, input: unknown) {
            const p = session(owner, input);
            if (p.polling)
                throw new ChatGptPlanPeerError('conflict');
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
        reply(owner: string, input: unknown) {
            const parsed = ChatGptPlanPeerReplySchema.safeParse(input);
            if (!parsed.success)
                throw new ChatGptPlanPeerError('invalid_request');
            const p = session(owner, { version: 1, sessionId: parsed.data.sessionId });
            const pending = p.pending.get(parsed.data.id);
            if (!pending)
                throw new ChatGptPlanPeerError('conflict');
            p.pending.delete(parsed.data.id);
            clearTimeout(pending.timer);
            pending.signal.removeEventListener('abort', pending.abort);
            if (parsed.data.ok)
                pending.resolve({ status: parsed.data.status, headers: parsed.data.headers, body: parsed.data.body });
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
                models: saved?.accountId ? saved.models.filter(compatible).map(m => ({ id: m.id, displayName: m.displayName })) : [],
                authorization: { revision: saved?.grantRevision ?? 0, enabled: !reason, background: !reason && Boolean(saved?.background) }, coordinatorFunding: 'subscription' };
        },
        async resolve(selection: CanonicalChatModelSelection, owner: string, requestClass: 'interactive' | 'background') {
            scope(owner);
            const selected = current();
            const saved = selected?.snapshot;
            const opts = new Map(selection.options?.map(o => [o.id, o.value]));
            const model = saved?.models.find(m => m.id === selection.model && compatible(m));
            if (selection.instanceId !== 'matrix_chatgpt_plan' || !selected || !saved?.enabled || !saved.accountId || !model || opts.size !== 2 || selection.options?.length !== 2
                || opts.get('accountId') !== saved.accountId || opts.get('grantRevision') !== String(saved.grantRevision)
                || requestClass === 'background' && !saved.background)
                throw new BotRouteError('model_unavailable');
            return { route: { api: 'openai-responses' as const, modelId: model.id, input: model.input, contextWindow: model.contextWindow, maxOutputTokens: Math.min(16384, model.maxOutputTokens) },
                accessSourceId: 'matrix_chatgpt_plan' as const, subscription: { accountId: saved.accountId, computerId: deps.computerId, grantRevision: saved.grantRevision, peerId: selected.sessionId } };
        },
        async revalidate(binding: PiRuntimeBinding, signal: AbortSignal) {
            const selected = current();
            const s = selected?.snapshot;
            const b = binding.subscription;
            return !closed && !signal.aborted && binding.ownerId === deps.ownerId && b?.computerId === deps.computerId && b.peerId === selected?.sessionId
                && Boolean(s?.enabled && s.accountId === b?.accountId && s.grantRevision === b?.grantRevision && s.models.some(m => m.id === binding.route.modelId)
                    && (binding.requestClass === 'interactive' || s.background));
        },
        async infer(binding: PiRuntimeBinding, body: string, signal: AbortSignal): Promise<InferenceReply> {
            if (!await service.revalidate(binding, signal))
                throw new ChatGptPlanPeerError('unavailable');
            const p = current()!;
            if (p.pending.size >= 4 || p.requests.length >= 32)
                throw new ChatGptPlanPeerError('unavailable');
            const id = randomUUID();
            return new Promise<InferenceReply>((resolve, reject) => {
                const abort = () => {
                    const pending = p.pending.get(id);
                    if (!pending)
                        return;
                    p.pending.delete(id);
                    clearTimeout(pending.timer);
                    signal.removeEventListener('abort', abort);
                    p.requests = p.requests.filter(r => r.id !== id);
                    if (p.requests.length < 32)
                        p.requests.push({ version: 1, action: 'cancel', id });
                    p.wake?.();
                    reject(new ChatGptPlanPeerError('unavailable'));
                };
                const timeout = setTimeout(abort, 120000);
                p.pending.set(id, { resolve, reject, signal, abort, timer: timeout });
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) {
                    abort();
                    return;
                }
                p.requests.push({ version: 1, action: 'infer', id, accountId: binding.subscription!.accountId, grantRevision: binding.subscription!.grantRevision,
                    computerId: deps.computerId, requestClass: binding.requestClass, runId: binding.runId, model: binding.route.modelId, body });
                p.wake?.();
            });
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
