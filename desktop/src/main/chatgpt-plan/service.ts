import { createPlanCatalogRefresh } from './catalog-refresh';
import { rejectedPlanCredential } from './credential-failure';
import { logPlanFailure } from './diagnostics';
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import type { AuthService } from '../auth/auth-service';
import { CHATGPT_PLAN_INVOKE, type ChatgptPlanSession, type ChatgptPlanStatus, type ChatgptPlanModel } from '../../shared/chatgpt-plan-ipc';
import { PLAN_RESOURCE, planJson, validatePlanTokens } from './oauth';
import { requestPlanResponse } from './responses';
import { planCatalog, planJwks, revokePlanAccount } from './provider';
import { startPlanLoopback } from './loopback';
import { createPlanNativePeer, type PlanPeerBinding } from './peer';
import type { PlanAccount, PlanVault, PlanVaultRecord } from './vault';
type Bound = ChatgptPlanSession & {
    ownerId: string;
    computerId: string;
    origin: string;
    bearer: string;
};
interface Dependencies {
    auth: Pick<AuthService, 'getStatus' | 'getToken' | 'getGatewayOrigin'>;
    vault: PlanVault;
    openBrowser(url: string): Promise<void>;
    fetchFn?: typeof fetch;
}
/** OAuth custody and provider I/O remain in Electron's trusted main process. */
export function createNativeChatgptPlanService(deps: Dependencies) {
    const fetchFn = deps.fetchFn ?? fetch;
    let record: PlanVaultRecord | null = null;
    let loadedOwner: string | null = null;
    let loadedScope: Bound | null = null;
    let loadTask: {
        value: Bound;
        task: Promise<void>;
    } | null = null;
    let models: ChatgptPlanModel[] = [];
    let catalogAt = 0;
    let state: ChatgptPlanStatus['state'] = 'disconnected';
    let revocation: ChatgptPlanStatus['revocation'] = 'none';
    let bridgeConnected = false;
    let peerSignature: string | null = null;
    let peerSyncTask: Promise<void> | null = null;
    let pending: {
        controller: AbortController;
        bound: Bound;
        close?: () => Promise<void>;
    } | null = null;
    let disposed = false;
    let disconnecting = false;
    let generation = 0;
    let mutationTail: Promise<unknown> = Promise.resolve();
    let refreshTask: Promise<void> | null = null;
    let lifecycleTask: Promise<void> | null = null;
    const refreshCatalog = createPlanCatalogRefresh();
    const requests = new Set<AbortController>(); // <=4 native calls; peer enforces admission.
    function bound(input: ChatgptPlanSession): Bound {
        const live = deps.auth.getStatus();
        const bearer = deps.auth.getToken();
        if (disposed || !live.signedIn || !bearer || live.runtimeSlot !== input.runtimeSlot || live.authGeneration !== input.authGeneration)
            throw new Error('connection changed');
        return {
            ...input, ownerId: live.userId, computerId: live.handle, origin: deps.auth.getGatewayOrigin(), bearer
        };
    }
    function current(value: Bound) {
        try {
            const live = bound(value);
            return live.ownerId === value.ownerId && live.computerId === value.computerId && live.origin === value.origin && live.bearer === value.bearer;
        }
        catch (error: unknown) {
            if (!(error instanceof Error))
                console.warn('[chatgpt-plan] invalid identity state');
            return false;
        }
    }
    function currentPeer(value: PlanPeerBinding) {
        const live = deps.auth.getStatus();
        return !disposed && live.signedIn && live.userId === value.ownerId && live.handle === value.computerId && deps.auth.getGatewayOrigin() === value.origin && deps.auth.getToken() === value.bearer && live.runtimeSlot === value.runtimeSlot && live.authGeneration === value.authGeneration;
    }
    function active(): PlanAccount | undefined { return record?.accounts.find(account => account.id === record?.activeAccountId); }
    function grant(computerId: string) {
        return record?.grants.find(value => value.computerId === computerId) ?? {
            computerId, revision: 0, enabled: false, background: false
        };
    }
    function snapshot(value: Bound): ChatgptPlanStatus {
        if (!current(value) || loadedOwner !== value.ownerId)
            throw new Error('connection changed');
        const account = active();
        const permission = grant(value.computerId);
        return {
            state, scope: 'this_device', ...(account ? { account: {
                    id: account.id, label: account.label
                } } : {}), models: account?.tokens && !disconnecting ? models : [], grant: {
                revision: permission.revision, enabled: !!account?.tokens && !disconnecting && permission.enabled, background: !!account?.tokens && !disconnecting && permission.enabled && permission.background
            }, bridgeConnected, revocation
        };
    }
    async function ensure(value: Bound): Promise<void> {
        if (loadedScope && current(loadedScope) && record && loadedOwner === value.ownerId)
            return;
        if (loadTask) {
            await loadTask.task;
            if (!current(value))
                throw new Error('connection changed');
            return ensure(value);
        }
        const task = (async () => {
            cancelAll();
            await peer.stop();
            record = null;
            models = [];
            catalogAt = 0;
            loadedOwner = null;
            loadedScope = null;
            revocation = 'none';
            const loaded = await deps.vault.load(value.ownerId);
            if (!current(value))
                throw new Error('connection changed');
            record = loaded;
            loadedOwner = value.ownerId;
            loadedScope = value;
            state = active()?.tokens ? 'connected' : 'disconnected';
        })();
        const entry = {
            value, task
        };
        loadTask = entry;
        try {
            await task;
        }
        finally {
            if (loadTask === entry)
                loadTask = null;
        }
    }
    function mutate<T>(operation: () => Promise<T>): Promise<T> {
        const task = mutationTail.then(operation, operation);
        mutationTail = task.then(() => undefined, () => undefined);
        return task;
    }
    async function save(value: Bound, next: PlanVaultRecord) {
        if (!current(value))
            throw new Error('connection changed');
        await deps.vault.save(value.ownerId, next);
        if (!current(value))
            throw new Error('connection changed');
        record = next;
    }
    async function freshTokens(value: Bound, signal: AbortSignal) {
        const account = active();
        if (!account?.tokens)
            throw new Error('not connected');
        if (account.tokens.expiresAt > Date.now() + 60000)
            return account.tokens;
        if (!refreshTask) {
            const epoch = generation;
            refreshTask = (async () => {
                const tokens = account.tokens!;
                const raw = await planJson(fetchFn, 'token', {
                    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
                        grant_type: 'refresh_token', client_id: tokens.clientId, refresh_token: tokens.refreshToken, resource: PLAN_RESOURCE
                    }), signal
                });
                const replacement = await validatePlanTokens(raw, {
                    jwks: await planJwks(fetchFn, signal), clientId: account.clientId, subject: account.subject, retainedIdToken: tokens.idToken
                });
                signal.throwIfAborted();
                if (epoch !== generation || !current(value))
                    throw new Error('credential changed');
                await mutate(async () => {
                    if (epoch !== generation || active()?.tokens !== tokens || !record || !current(value))
                        throw new Error('credential changed');
                    await save(value, {
                        ...record, accounts: record.accounts.map(item => item.id === account.id ? {
                            ...item, tokens: {
                                ...replacement, email: replacement.email ?? tokens.email
                            }
                        } : item)
                    });
                });
            })().finally(() => { refreshTask = null; });
        }
        await refreshTask;
        signal.throwIfAborted();
        if (!current(value))
            throw new Error('connection changed');
        const tokens = active()?.tokens;
        if (!tokens)
            throw new Error('not connected');
        return tokens;
    }
    async function readCatalog(value: Bound, signal: AbortSignal) {
        const epoch = generation;
        const accountId = active()?.id;
        await refreshCatalog({
            current: () => epoch === generation && active()?.id === accountId && current(value),
            read: async () => {
                const tokens = await freshTokens(value, signal);
                return planCatalog(await planJson(fetchFn, 'models', {
                    headers: { authorization: `Bearer ${tokens.accessToken}` }, signal
                }));
            },
            mutate,
            apply: next => { signal.throwIfAborted(); models = next; catalogAt = Date.now(); state = pending ? 'connecting' : 'connected'; },
            invalidate: () => {
                models = [];
                catalogAt = 0;
                state = pending ? 'connecting' : 'error';
                for (const controller of requests) controller.abort();
                return peer.stop();
            },
        });
        if (epoch !== generation || active()?.id !== accountId || !current(value))
            throw new Error('connection changed');
    }
    async function restartPeer(value: Bound): Promise<void> {
        if (peerSyncTask) {
            try {
                await peerSyncTask;
            }
            catch (error: unknown) {
                if (!current(value))
                    throw error;
                console.warn('[chatgpt-plan] previous peer sync failed', error instanceof Error ? error.name : 'UnknownError');
            }
            if (!current(value))
                throw new Error('connection changed');
            return restartPeer(value);
        }
        const task = (async () => {
            if (!record || !current(value))
                return;
            const account = active();
            const permission = grant(value.computerId);
            const epoch = generation;
            if (!account?.tokens || !models.length) {
                await peer.stop();
                return;
            }
            const next = {
                deviceId: record.deviceId, accountId: account.id, grantRevision: permission.revision, enabled: permission.enabled, background: false, models
            };
            const qualified = () => current(value) && epoch === generation && active()?.id === account.id
                && models === next.models && catalogAt > 0 && grant(value.computerId).revision === permission.revision;
            const signature = JSON.stringify(next);
            if (bridgeConnected && peerSignature === signature)
                return;
            const keys = {
                privateKey: record.devicePrivateKey, publicKey: record.devicePublicKey
            };
            await peer.stop();
            if (!qualified())
                throw new Error('source changed');
            await peer.start({
                ...value, ...keys
            }, next, qualified);
            if (!qualified()) {
                await peer.stop();
                throw new Error('source changed');
            }
            peerSignature = signature;
        })();
        peerSyncTask = task;
        try {
            await task;
        }
        finally {
            if (peerSyncTask === task)
                peerSyncTask = null;
        }
    }
    async function infer(request: Extract<ChatGptPlanPeerRequest, {
        action: 'infer';
    }>, signal: AbortSignal) {
        const live = deps.auth.getStatus();
        const value = bound(live);
        const permission = grant(value.computerId);
        const account = active();
        const epoch = generation;
        const validate = () => {
            signal.throwIfAborted();
            if (!current(value) || epoch !== generation || !account?.tokens || active()?.id !== request.accountId || request.computerId !== value.computerId || permission.revision !== request.grantRevision || !permission.enabled || !models.some(model => model.id === request.model) || Date.now() - catalogAt > 5 * 60000)
                throw new Error('source changed');
            if (request.requestClass === 'background' && !permission.background)
                throw new Error('background not permitted');
        };
        validate();
        if (requests.size >= 4)
            throw new Error('request capacity');
        const controller = new AbortController();
        requests.add(controller);
        const operationSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120000)]);
        try {
            return await requestPlanResponse({
                fetchFn, body: request.body, model: request.model, signal: operationSignal, validate,
                accessToken: async () => (await freshTokens(value, operationSignal)).accessToken,
            });
        }
        finally {
            requests.delete(controller);
        }
    }
    const peer = createPlanNativePeer({
        fetchFn, current: currentPeer, infer, connected: value => {
            bridgeConnected = value;
            if (!value)
                peerSignature = null;
        }
    });
    function cancelAll() {
        generation += 1;
        pending?.controller.abort();
        pending = null;
        for (const controller of requests)
            controller.abort();
        requests.clear();
        if (state === 'connecting')
            state = active()?.tokens ? models.length ? 'connected' : 'error' : 'disconnected';
        void peer.stop().catch((error: unknown) => logPlanFailure('peer_disconnect', error));
    }
    async function status(input: ChatgptPlanSession) {
        const value = bound(input);
        await ensure(value);
        const epoch = generation;
        if (active()?.tokens && (!catalogAt || Date.now() - catalogAt > 5 * 60000)) {
            try {
                await readCatalog(value, AbortSignal.timeout(15000));
                await restartPeer(value);
            }
            catch (error: unknown) {
                if (!current(value) || epoch !== generation)
                    throw error;
                logPlanFailure('catalog', error);
                // readCatalog owns the fenced invalidation shared by every refresh entry point.
            }
        }
        return snapshot(value);
    }
    async function connect(input: z.infer<typeof CHATGPT_PLAN_INVOKE['chatgpt-plan:connect']['request']>) {
        const parsed = CHATGPT_PLAN_INVOKE['chatgpt-plan:connect'].request.parse(input);
        const value = bound(parsed);
        await ensure(value);
        if (disconnecting)
            throw new Error('disconnect in progress');
        if (pending)
            return snapshot(value);
        const selected = active();
        // Explicit reconnect recovers the same local account without another OAuth
        // prompt. Read-only status/catalog checks never change Bot authorization.
        if (selected?.tokens) {
            const expected = { accountId: selected.id, generation };
            let retryQualified = false;
            try { await readCatalog(value, AbortSignal.timeout(15000)); retryQualified = true; }
            catch (error: unknown) {
                if (!current(value) || expected.generation !== generation || active()?.id !== expected.accountId)
                    throw new Error('source changed');
                if (pending) return snapshot(value);
                if (!rejectedPlanCredential(error) || models.length) throw error;
                // R8 has withdrawn inference authority. Only this explicit Connect
                // may replace rejected credentials through the existing PKCE flow.
            }
            if (retryQualified) {
                if (!grant(value.computerId).enabled)
                    return setGrant({ runtimeSlot: value.runtimeSlot, authGeneration: value.authGeneration, enabled: true, background: false }, expected);
                await restartPeer(value);
                return snapshot(value);
            }
        }
        const operation = {
            controller: new AbortController(), bound: value, close: undefined as (() => Promise<void>) | undefined
        };
        pending = operation;
        state = 'connecting';
        revocation = 'none';
        const fail = () => {
            if (pending === operation) {
                pending = null;
                state = selected?.tokens && models.length ? 'connected' : 'error';
            }
        };
        try {
            await mutate(async () => {
                if (!record || pending !== operation || !current(value))
                    throw new Error('vault unavailable');
                await save(value, record);
            });
            if (!record || !current(value) || pending !== operation)
                throw new Error('connection changed');
            const listener = await startPlanLoopback({
                hostId: record.hostId, clientId: selected?.clientId, idToken: selected?.tokens?.idToken, signal: operation.controller.signal, openBrowser: deps.openBrowser, failed: fail, complete: async (callback) => {
                    const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(30000)]);
                    const raw = await planJson(fetchFn, 'token', {
                        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
                            grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: callback.verifier, redirect_uri: callback.redirectUri, resource: PLAN_RESOURCE
                        }), signal
                    });
                    const tokens = await validatePlanTokens(raw, {
                        jwks: await planJwks(fetchFn, signal), clientId: callback.clientId, nonce: callback.nonce, subject: selected?.subject
                    });
                    if (pending !== operation || !current(value) || signal.aborted || !record)
                        throw new Error('stale authorization');
                    generation += 1;
                    const completionEpoch = generation;
                    await peer.stop();
                    await mutate(async () => {
                        if (completionEpoch !== generation || pending !== operation || !current(value) || signal.aborted || !record)
                            throw new Error('stale authorization');
                        const accountId = selected?.id ?? randomUUID();
                        if (!selected && record.accounts.length >= 8)
                            throw new Error('account capacity');
                        const account: PlanAccount = {
                            id: accountId, clientId: tokens.clientId, subject: tokens.subject, label: tokens.email ?? `ChatGPT account ${record.accounts.length + 1}`, tokens
                        };
                        models = [];
                        catalogAt = 0;
                        const oldGrant = grant(value.computerId);
                        const nextGrant = {
                            ...oldGrant, revision: oldGrant.revision + 1, enabled: true, background: false
                        };
                        await save(value, {
                            ...record, activeAccountId: accountId, accounts: selected ? record.accounts.map(item => item.id === selected.id ? account : item) : [...record.accounts, account], grants: [...record.grants.filter(item => item.computerId !== value.computerId), nextGrant].slice(-16)
                        });
                        pending = null;
                        state = 'connected';
                    });
                    await readCatalog(value, signal);
                    await restartPeer(value);
                }
            });
            operation.close = async () => { await listener.close(); await listener.drain(); };
        }
        catch (error: unknown) {
            fail();
            throw error;
        }
        return snapshot(value);
    }
    async function cancel(input: ChatgptPlanSession) { const value = bound(input); await ensure(value); const previous = pending; cancelAll(); await previous?.close?.(); return snapshot(value); }
    async function setGrant(input: z.infer<typeof CHATGPT_PLAN_INVOKE['chatgpt-plan:set-grant']['request']>, expected?: { accountId: string; generation: number }) {
        const parsed = CHATGPT_PLAN_INVOKE['chatgpt-plan:set-grant'].request.parse(input);
        const value = bound(parsed);
        await ensure(value);
        if (disconnecting)
            throw new Error('disconnect in progress');
        if (parsed.background)
            throw new Error('background not permitted');
        if (parsed.enabled && (!active()?.tokens || !models.length))
            throw new Error('not connected');
        if (expected && (expected.generation !== generation || active()?.id !== expected.accountId || !current(value)))
            throw new Error('source changed');
        generation += 1;
        const epoch = generation;
        for (const controller of requests)
            controller.abort();
        await peer.stop();
        await mutate(async () => {
            if (!record || pending || !current(value) || expected && (epoch !== generation || active()?.id !== expected.accountId))
                throw new Error('connection changed');
            const existing = grant(value.computerId);
            const next = {
                computerId: value.computerId, revision: existing.revision + 1, enabled: parsed.enabled, background: parsed.background
            };
            await save(value, {
                ...record, grants: [...record.grants.filter(item => item.computerId !== value.computerId), next].slice(-16)
            });
        });
        await restartPeer(value);
        return snapshot(value);
    }
    async function refreshModels(input: ChatgptPlanSession) { const value = bound(input); await ensure(value); await readCatalog(value, AbortSignal.timeout(15000)); await restartPeer(value); return snapshot(value); }
    async function disconnect(input: ChatgptPlanSession) {
        const value = bound(input);
        await ensure(value);
        if (disconnecting)
            throw new Error('disconnect in progress');
        disconnecting = true;
        const selected = active();
        const captured = record;
        cancelAll();
        await peer.stop();
        state = 'disconnected';
        models = [];
        catalogAt = 0;
        try {
            if (!captured)
                throw new Error('vault unavailable');
            const cleared = {
                ...captured, accounts: captured.accounts.map(item => item.id === selected?.id ? {
                    ...item, tokens: null
                } : item),
                grants: captured.grants.map(item => ({
                    ...item, revision: item.revision + 1, enabled: false, background: false
                }))
            };
            // Local sign-out is irrevocable for the captured owner even if Matrix switches
            // owners during remote revocation. Never restore the cleared refresh token.
            if (loadedOwner === value.ownerId)
                record = cleared;
            await mutate(async () => { await deps.vault.save(value.ownerId, cleared); });
            const resultRevocation = await revokePlanAccount(fetchFn, selected);
            if (!current(value))
                throw new Error('connection changed');
            revocation = resultRevocation;
            return snapshot(value);
        }
        finally {
            disconnecting = false;
        }
    }
    const timer = setInterval(() => {
        void deps.vault.cleanup().catch((error: unknown) => console.warn('[chatgpt-plan] temporary credential cleanup failed', error instanceof Error ? error.name : 'UnknownError'));
        const live = deps.auth.getStatus();
        if (disposed || disconnecting || pending || lifecycleTask || !live.signedIn || !record)
            return;
        let value: Bound;
        try {
            value = bound(live);
        }
        catch (error: unknown) {
            console.warn('[chatgpt-plan] no active device session', error instanceof Error ? error.name : 'UnknownError');
            return;
        }
        if (loadedOwner !== value.ownerId) {
            cancelAll();
            return;
        }
        if (!active()?.tokens)
            return;
        lifecycleTask = (async () => {
            if (Date.now() - catalogAt > 4 * 60000)
                await readCatalog(value, AbortSignal.timeout(15000));
            await restartPeer(value);
        })().catch((error: unknown) => { logPlanFailure('source_refresh', error); }).finally(() => { lifecycleTask = null; });
    }, 10000);
    timer.unref();
    function resume() {
        const live = deps.auth.getStatus();
        if (!live.signedIn || disposed)
            return;
        void status(live).catch((error: unknown) => logPlanFailure('source_restore', error));
    }
    return {
        status, connect, cancel, disconnect, setGrant, refreshModels, cancelAll, resume, async dispose() {
            const attempt = pending;
            disposed = true;
            clearInterval(timer);
            cancelAll();
            await attempt?.close?.();
            await peer.stop();
            await Promise.allSettled([
                mutationTail, refreshTask, lifecycleTask, loadTask?.task, peerSyncTask
            ].filter((task): task is Promise<unknown> => !!task));
        }
    };
}
