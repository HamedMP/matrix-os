import { sign } from 'node:crypto';
import { z } from 'zod/v4';
import { CHATGPT_PLAN_PEER_POLL_BYTE_LIMIT, CHATGPT_PLAN_PEER_CLOCK_SKEW_MS, CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS, chatGptPlanPeerRequestId, ChatGptPlanPeerChallengeSchema, ChatGptPlanPeerSessionSchema, ChatGptPlanPeerReplySchema, ChatGptPlanPeerPollSchema, chatGptPlanPeerProof, type ChatGptPlanPeerSnapshot, type ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import { logPlanFailure, PlanFailure, planPeerNetworkFailureDiagnostic, type PlanNetworkDiagnostic } from './diagnostics';
import { sendNativeStreamReply } from './reply-delivery';
import { coalesceNativeResponse } from './stream-coalescing';
import { blocksPollDeliveryRecovery, createNativePollDelivery } from './poll-delivery';
const POST_CONFLICT = Symbol('reply already settled');
// A failed poll may already have dequeued a cancel. Only failures establishing
// the connection prove no request reached the server; resets/timeouts do not.
const PRECONNECT_CHROME_CODES = new Set(['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED']);
const PRECONNECT_NODE_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
function retryablePollConnectionFailure(error: unknown): boolean {
    if (!(error instanceof PlanFailure) || error.stage !== 'peer_poll' || error.category !== 'network_error'
        || error.networkDiagnostic?.phase !== 'before_headers') return false;
    const { chromiumCode, code, causeCode } = error.networkDiagnostic;
    for (const failureCode of [code, causeCode])
        if (failureCode !== undefined && !PRECONNECT_NODE_CODES.has(failureCode)) return false;
    if (chromiumCode !== undefined) return PRECONNECT_CHROME_CODES.has(chromiumCode);
    return code !== undefined ? PRECONNECT_NODE_CODES.has(code) : PRECONNECT_NODE_CODES.has(causeCode ?? '');
}
async function readPeerText(response: Response, limit: number, signal: AbortSignal, interruption: Promise<never>): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await Promise.race([reader.read(), interruption]);
            signal.throwIfAborted();
            if (chunk.done) return text + decoder.decode();
            bytes += chunk.value.byteLength;
            if (bytes > limit) throw new Error('response too large');
            text += decoder.decode(chunk.value, { stream: true });
        }
    } finally {
        try { void reader.cancel().catch((error: unknown) => logPlanFailure('peer_response_cleanup', error)); }
        catch (error: unknown) { logPlanFailure('peer_response_cleanup', error); }
        finally {
            try { reader.releaseLock(); }
            catch (error: unknown) { logPlanFailure('peer_response_cleanup', error); }
        }
    }
}
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
    /** Trusted composition selects v2; absence retains the strict v1 adapter. */
    deliveryVersion?: 2;
    /** Protocol support only. Each occurrence still requires durable owner approval at Gateway admission. */
    approvedRoutines?: true;
    fetchFn: typeof fetch;
    current(binding: PlanPeerBinding): boolean;
    infer(request: Extract<ChatGptPlanPeerRequest, {
        action: 'infer';
    }>, signal: AbortSignal): Promise<string>;
    inferStream?(request: Extract<ChatGptPlanPeerRequest, {
        action: 'infer';
    }>, signal: AbortSignal, progress: () => void): AsyncIterable<string>;
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
        const isPoll = path === 'poll' || path === 'poll-v2';
        const stage = isPoll ? 'peer_poll' : `peer_${path}`;
        if (!deps.current(binding))
            throw new PlanFailure(`peer_${path}`, 'stale_source', undefined, undefined, { phase: 'before_headers' });
        const url = new URL(`/api/chatgpt-plan/device/${path}`, binding.origin);
        if (path === 'capabilities' && deps.deliveryVersion === 2) url.searchParams.set('includeReplyDeliveryV2', 'true');
        if (path === 'capabilities' && deps.inferStream) url.searchParams.set('includeInferenceStream', 'true');
        if (path === 'capabilities' && deps.approvedRoutines) url.searchParams.set('includeApprovedRoutines', 'true');
        if (binding.runtimeSlot !== 'primary')
            url.searchParams.set('runtime', binding.runtimeSlot);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
            throw new Error('unsafe gateway');
        const encoded = JSON.stringify(body);
        if (path === 'reply' && Buffer.byteLength(encoded) > CHATGPT_PLAN_PEER_REPLY_BYTE_LIMIT)
            throw new Error('peer reply too large');
        const requestDeadline = AbortSignal.timeout(isPoll ? 15000 : 10000);
        const deadline = AbortSignal.any([signal, requestDeadline]);
        let interrupted!: () => void;
        const interruption = new Promise<never>((_, reject) => { interrupted = () => reject(deadline.reason); });
        deadline.addEventListener('abort', interrupted, { once: true });
        let phase: PlanNetworkDiagnostic['phase'] = 'before_headers';
        try {
            deadline.throwIfAborted();
            const response = await Promise.race([deps.fetchFn(url.toString(), {
                method: 'POST', redirect: 'error', headers: {
                    authorization: `Bearer ${binding.bearer}`, 'content-type': 'application/json'
                },
                body: encoded, signal: deadline,
            }), interruption]);
            phase = 'body_read';
            if (path === 'reply' && response.status === 409) {
                void response.body?.cancel().catch((error: unknown) => logPlanFailure('peer_reply_cleanup', error));
                return POST_CONFLICT;
            }
            if (!response.ok) {
                void response.body?.cancel().catch((error: unknown) => logPlanFailure('peer_response_cleanup', error));
                throw new PlanFailure(stage, 'http_error', response.status);
            }
            const text = await readPeerText(response, isPoll ? CHATGPT_PLAN_PEER_POLL_BYTE_LIMIT : limit, deadline, interruption);
            deadline.throwIfAborted();
            phase = 'post_read_binding';
            if (!deps.current(binding))
                throw new PlanFailure(stage, 'stale_source', undefined, undefined, { phase });
            return text ? JSON.parse(text) as unknown : {};
        } catch (error: unknown) {
            // Retain the transport boundary without exposing fetch URLs or
            // provider text. A reply timeout must not look like model timeout.
            if (error instanceof PlanFailure) throw error;
            const reason = deadline.aborted ? deadline.reason : error;
            if (reason instanceof DOMException) {
                // Only our exact POST deadline earns receipt recovery. A caller
                // abort or a coincident foreign error must never borrow its phase.
                const ownDeadline = requestDeadline.aborted && !signal.aborted && error === requestDeadline.reason;
                throw new PlanFailure(stage, reason.name === 'TimeoutError' ? 'timeout'
                    : reason.name === 'AbortError' ? 'cancelled' : 'transport_error',
                    undefined, undefined, ownDeadline ? { phase } : undefined);
            }
            if (error instanceof SyntaxError || error instanceof z.ZodError) throw new PlanFailure(stage, 'invalid_schema');
            const network = planPeerNetworkFailureDiagnostic(error, phase);
            if ((isPoll || path === 'reply') && blocksPollDeliveryRecovery(error)) network.causeCode = 'unknown';
            if (error instanceof Error && error.message === 'response too large')
                throw new PlanFailure(stage, 'response_oversize', undefined, undefined, network);
            if (error instanceof TypeError || network.chromiumCode && network.chromiumCode !== 'unknown' || network.code || network.causeCode)
                throw new PlanFailure(stage, 'network_error', undefined, undefined, network);
            if (error instanceof Error) throw new PlanFailure(stage, 'local_failure', undefined, undefined, network);
            throw error;
        } finally {
            deadline.removeEventListener('abort', interrupted);
        }
    }
    async function stop() {
        const previous = connection;
        const previousTask = task;
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
        await previousTask;
    }
    async function start(binding: PlanPeerBinding, snapshot: ChatGptPlanPeerSnapshot, qualified = () => true, replaceDevice = false) {
        await stop();
        if (!qualified()) throw new Error('source changed');
        const controller = new AbortController();
        const value = {
            controller, binding, sessionId: undefined as string | undefined
        };
        connection = value;
        const challenge = ChatGptPlanPeerChallengeSchema.parse(await post(binding, replaceDevice ? 'rebind-challenge' : 'challenge', {}, controller.signal));
        if (!qualified()) throw new Error('source changed');
        if (challenge.ownerId !== binding.ownerId || challenge.computerId !== binding.computerId || Date.parse(challenge.expiresAt) <= Date.now())
            throw new Error('peer identity mismatch');
        if (replaceDevice !== Boolean(challenge.replacement)) throw new Error('peer intent mismatch');
        const proof = chatGptPlanPeerProof({
            ...challenge, snapshot
        });
        const signature = sign(null, Buffer.from(proof), binding.privateKey).toString('base64url');
        const session = ChatGptPlanPeerSessionSchema.parse(await post(binding, 'connect', {
            version: 1, challenge: challenge.challenge, publicKey: binding.publicKey, snapshot, signature, ...(challenge.replacement ? { replacement: challenge.replacement } : {})
        }, controller.signal));
        value.sessionId = session.sessionId;
        if (connection !== value || !qualified())
            throw new Error('peer changed');
        const delivery = deps.deliveryVersion === 2 ? createNativePollDelivery({ sessionId: session.sessionId, signal: controller.signal,
            current: () => connection === value && deps.current(binding) && qualified(),
            post: (path, body, signal, limit) => post(binding, path, body, signal, limit) }) : undefined;
        let replyDeliveryV2 = false;
        try { replyDeliveryV2 = await delivery?.negotiate() ?? false; }
        catch (error: unknown) { controller.abort(); if (connection === value) { connection = null; deps.connected(false); } throw error; }
        const approvedRoutines = deps.approvedRoutines && delivery?.supportsApprovedRoutines();
        deps.connected(true);
        let lastSequence = 0; // Session-scoped high-water mark, never evicted.
        let consecutivePollFailures = 0;
        const pending = new Set<Promise<void>>(); // <=4 calls; drain on transport close.
        task = (async () => {
            try {
                while (connection === value && deps.current(binding)) {
                    let poll: { requests: ChatGptPlanPeerRequest[]; canceled?: ReadonlySet<string>; receipt?(): void };
                    try {
                        poll = delivery ? await delivery.poll() : ChatGptPlanPeerPollSchema.parse(await post(binding, 'poll', session, controller.signal));
                        consecutivePollFailures = 0;
                    } catch (error: unknown) {
                        if (!delivery && consecutivePollFailures === 0 && connection === value && !controller.signal.aborted
                            && deps.current(binding) && [...calls.values()].some(call => !call.signal.aborted)
                            && retryablePollConnectionFailure(error)) {
                            consecutivePollFailures = 1;
                            logPlanFailure('peer_poll', error);
                            continue;
                        }
                        throw error;
                    }
                    for (const id of poll.canceled ?? []) calls.get(id)?.abort();
                    for (const request of poll.requests) {
                        if (request.action === 'cancel') {
                            calls.get(request.id)?.abort();
                            poll.receipt?.();
                            continue;
                        }
                        const remaining = Date.parse(request.expiresAt) - Date.now();
                        const fresh = request.sequence > lastSequence
                            && request.id === chatGptPlanPeerRequestId(session.sessionId, request.sequence);
                        // A replay must not send a failure reply for an original still-active ID.
                        if (delivery && request.id !== chatGptPlanPeerRequestId(session.sessionId, request.sequence)) throw new PlanFailure('peer_poll', 'invalid_schema');
                        if (!fresh) { poll.receipt?.(); continue; }
                        lastSequence = request.sequence;
                        if (poll.canceled?.has(request.id)) { poll.receipt?.(); continue; }
                        if (remaining <= 0 || remaining > CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS + CHATGPT_PLAN_PEER_CLOCK_SKEW_MS || calls.size >= 4
                            || request.approvedRoutine && (!approvedRoutines || request.approvedRoutine.ownerId !== binding.ownerId)) {
                            // Refuse this request without terminating unrelated admitted work.
                            const ack = await post(binding, 'reply', { ...session, id: request.id, ok: false, error: 'unavailable' }, controller.signal);
                            if (delivery && ack !== POST_CONFLICT && !z.object({ version: z.literal(1), ok: z.literal(true) }).strict().safeParse(ack).success) {
                                throw new PlanFailure('peer_reply', 'invalid_schema');
                            }
                            poll.receipt?.();
                            continue;
                        }
                        const call = new AbortController();
                        calls.set(request.id, call);
                        const operation = (async () => {
                            const streaming = request.responseMode === 'stream';
                            const idle = streaming ? new AbortController() : null;
                            let idleTimer: ReturnType<typeof setTimeout> | undefined;
                            const signal = AbortSignal.any([call.signal, controller.signal, idle
                                ? idle.signal : AbortSignal.timeout(Math.ceil(Math.min(remaining, CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS)))]);
                            const progress = () => {
                                if (!idle || signal.aborted) return;
                                clearTimeout(idleTimer);
                                idleTimer = setTimeout(() => idle.abort(new DOMException('Inference idle', 'TimeoutError')),
                                    CHATGPT_PLAN_PEER_REQUEST_LIFETIME_MS);
                                idleTimer.unref?.();
                            };
                            progress();
                            try {
                                if (streaming) {
                                    if (!deps.inferStream) throw new Error('stream inference unavailable');
                                    let sequence = 0;
                                    const send = async (reply: unknown) => {
                                        const frame = Object.freeze(ChatGptPlanPeerReplySchema.parse(reply));
                                        const ack = await sendNativeStreamReply({ enabled: replyDeliveryV2, signal,
                                            current: () => connection === value && deps.current(binding) && qualified(),
                                            post: () => post(binding, 'reply', frame, signal) });
                                        if (ack === POST_CONFLICT) return false;
                                        const validated = z.object({ version: z.literal(1), ok: z.literal(true), sessionId: z.literal(session.sessionId),
                                            id: z.literal(request.id), sequence: z.literal(sequence) }).strict().safeParse(ack);
                                        if (!validated.success) throw new PlanFailure('peer_reply', 'invalid_schema');
                                        return true;
                                    };
                                    const inferStream = deps.inferStream;
                                    for await (const chunk of coalesceNativeResponse(
                                        sourceSignal => inferStream(request, sourceSignal, progress), signal,
                                        () => connection === value && deps.current(binding) && qualified())) {
                                        signal.throwIfAborted();
                                        if (!chunk) continue;
                                        progress();
                                        if (!await send({ ...session, id: request.id, ok: true, stream: 'chunk', sequence, body: chunk })) return;
                                        progress();
                                        sequence += 1;
                                    }
                                    signal.throwIfAborted();
                                    progress();
                                    await send({ ...session, id: request.id, ok: true, stream: 'end', sequence });
                                } else {
                                    const body = await deps.infer(request, signal);
                                    signal.throwIfAborted();
                                    const reply = ChatGptPlanPeerReplySchema.parse({
                                        ...session, id: request.id, ok: true, status: 200, headers: { 'content-type': 'text/event-stream' }, body
                                    });
                                    await post(binding, 'reply', reply, controller.signal);
                                }
                            }
                            catch (error: unknown) {
                                if (controller.signal.aborted || call.signal.aborted)
                                    return;
                                logPlanFailure('responses', error, { requestId: request.id, runId: request.runId, computerId: request.computerId, requestClass: request.requestClass });
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
                                clearTimeout(idleTimer);
                                calls.delete(request.id);
                            }
                        })();
                        pending.add(operation);
                        void operation.finally(() => pending.delete(operation));
                        poll.receipt?.();
                    }
                }
            }
            catch (error: unknown) {
                if (!controller.signal.aborted)
                    logPlanFailure('peer_poll', error);
            }
            finally {
                controller.abort();
                if (connection === value) {
                    for (const call of calls.values()) call.abort();
                }
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
