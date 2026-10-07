import { sign } from 'node:crypto';
import { CHATGPT_PLAN_PEER_CLOCK_SKEW_MS, CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS, chatGptPlanPeerRequestId, ChatGptPlanPeerChallengeSchema, ChatGptPlanPeerSessionSchema, ChatGptPlanPeerReplySchema, ChatGptPlanPeerPollSchema, chatGptPlanPeerProof, type ChatGptPlanPeerSnapshot, type ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import { logPlanFailure, PlanFailure } from './diagnostics';
import { boundedText } from './oauth';
export interface PlanPeerBinding {
    runtimeSlot: string;
    authGeneration: number;
    ownerId: string;
    computerId: string;
    origin: string;
    bearer: string;
    privateKey: string;
    publicKey: string;
}
interface PeerDependencies {
    fetchFn: typeof fetch;
    current(binding: PlanPeerBinding): boolean;
    infer(request: Extract<ChatGptPlanPeerRequest, {
        action: 'infer';
    }>, signal: AbortSignal): Promise<string>;
    connected(value: boolean): void;
}
/** Private authenticated transport. Never exposes its session nonce or OAuth material. */
export function createPlanNativePeer(deps: PeerDependencies) {
    let connection: {
        controller: AbortController;
        binding: PlanPeerBinding;
        sessionId?: string;
    } | null = null;
    let task: Promise<void> | null = null;
    const calls = new Map<string, AbortController>(); // <=4 calls, drained on every disconnect.
    async function post(binding: PlanPeerBinding, path: string, body: unknown, signal: AbortSignal, limit = 2 * 1024 * 1024) {
        if (!deps.current(binding))
            throw new Error('peer changed');
        const url = new URL(`/api/chatgpt-plan/device/${path}`, binding.origin);
        if (binding.runtimeSlot !== 'primary')
            url.searchParams.set('runtime', binding.runtimeSlot);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
            throw new Error('unsafe gateway');
        const encoded = JSON.stringify(body);
        if (path === 'reply' && Buffer.byteLength(encoded) > CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT)
            throw new Error('peer reply too large');
        const response = await deps.fetchFn(url.toString(), {
            method: 'POST', redirect: 'error', headers: {
                authorization: `Bearer ${binding.bearer}`, 'content-type': 'application/json'
            },
            body: encoded, signal: AbortSignal.any([signal, AbortSignal.timeout(path === 'poll' ? 15000 : 10000)]),
        });
        if (path === 'reply' && response.status === 409) {
            await response.body?.cancel();
            return {};
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new PlanFailure(`peer_${path}`, 'http_error', response.status);
        }
        const text = await boundedText(response, limit);
        if (!deps.current(binding))
            throw new Error('peer changed');
        return text ? JSON.parse(text) as unknown : {};
    }
    async function stop() {
        const previous = connection;
        connection = null;
        previous?.controller.abort();
        for (const controller of calls.values())
            controller.abort();
        calls.clear();
        deps.connected(false);
        if (previous?.sessionId && deps.current(previous.binding)) {
            try {
                await post(previous.binding, 'disconnect', {
                    version: 1, sessionId: previous.sessionId
                }, AbortSignal.timeout(5000));
            }
            catch (error: unknown) {
                logPlanFailure('peer_disconnect', error);
            }
        }
        await task;
    }
    async function start(binding: PlanPeerBinding, snapshot: ChatGptPlanPeerSnapshot) {
        await stop();
        const controller = new AbortController();
        const value = {
            controller, binding, sessionId: undefined as string | undefined
        };
        connection = value;
        const challenge = ChatGptPlanPeerChallengeSchema.parse(await post(binding, 'challenge', {}, controller.signal));
        if (challenge.ownerId !== binding.ownerId || challenge.computerId !== binding.computerId || Date.parse(challenge.expiresAt) <= Date.now())
            throw new Error('peer identity mismatch');
        const proof = chatGptPlanPeerProof({
            ...challenge, snapshot
        });
        const signature = sign(null, Buffer.from(proof), binding.privateKey).toString('base64url');
        const session = ChatGptPlanPeerSessionSchema.parse(await post(binding, 'connect', {
            version: 1, challenge: challenge.challenge, publicKey: binding.publicKey, snapshot, signature
        }, controller.signal));
        value.sessionId = session.sessionId;
        if (connection !== value)
            throw new Error('peer changed');
        deps.connected(true);
        let lastSequence = 0; // Session-scoped high-water mark, never evicted.
        const pending = new Set<Promise<void>>(); // <=4 calls; drain on transport close.
        task = (async () => {
            try {
                while (connection === value && deps.current(binding)) {
                    const poll = ChatGptPlanPeerPollSchema.parse(await post(binding, 'poll', session, controller.signal));
                    for (const request of poll.requests) {
                        if (request.action === 'cancel') {
                            calls.get(request.id)?.abort();
                            continue;
                        }
                        const remaining = Date.parse(request.expiresAt) - Date.now();
                        const fresh = request.sequence > lastSequence
                            && request.id === chatGptPlanPeerRequestId(session.sessionId, request.sequence);
                        // A replay must not send a failure reply for an original still-active ID.
                        if (!fresh) continue;
                        lastSequence = request.sequence;
                        if (remaining <= 0 || remaining > CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS + CHATGPT_PLAN_PEER_CLOCK_SKEW_MS || calls.size >= 4) {
                            // Refuse this request without terminating unrelated admitted work.
                            await post(binding, 'reply', { ...session, id: request.id, ok: false, error: 'unavailable' }, controller.signal);
                            continue;
                        }
                        const call = new AbortController();
                        calls.set(request.id, call);
                        const operation = (async () => {
                            const signal = AbortSignal.any([call.signal, controller.signal, AbortSignal.timeout(Math.ceil(Math.min(remaining, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS)))]);
                            try {
                                const body = await deps.infer(request, signal);
                                signal.throwIfAborted();
                                const reply = ChatGptPlanPeerReplySchema.parse({
                                    ...session, id: request.id, ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body
                                });
                                await post(binding, 'reply', reply, controller.signal);
                            }
                            catch (error: unknown) {
                                if (controller.signal.aborted || call.signal.aborted)
                                    return;
                                logPlanFailure('responses', error);
                                try {
                                    await post(binding, 'reply', {
                                        ...session, id: request.id, ok: false, error: signal.aborted ? 'cancelled' : 'unavailable'
                                    }, controller.signal);
                                }
                                catch (replyError: unknown) {
                                    logPlanFailure('peer_reply', replyError);
                                    controller.abort();
                                }
                            }
                            finally {
                                calls.delete(request.id);
                            }
                        })();
                        pending.add(operation);
                        void operation.finally(() => pending.delete(operation));
                    }
                }
            }
            catch (error: unknown) {
                if (!controller.signal.aborted)
                    logPlanFailure('peer_poll', error);
            }
            finally {
                controller.abort();
                for (const call of calls.values())
                    call.abort();
                await Promise.allSettled(pending);
                if (connection === value) {
                    connection = null;
                    calls.clear();
                    deps.connected(false);
                }
            }
        })();
    }
    return {
        start, stop
    };
}
