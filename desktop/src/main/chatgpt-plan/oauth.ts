import { createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { z } from 'zod/v4';
import { PlanFailure } from './diagnostics';
export const PLAN_ISSUER = 'https://auth.openai.com';
export const PLAN_RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TokenResponse = z.object({
    access_token: z.string().min(1).max(16384), refresh_token: z.string().min(1).max(16384), id_token: z.string().min(1).max(16384).optional(), token_type: z.literal('Bearer'), expires_in: z.number().int().positive().max(86400), scope: z.string().max(4096), earliest_refresh_at: z.number().nonnegative().optional()
});
export function planAuthorizationUrl(input: {
    hostId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    verifier: string;
    clientId?: string;
    idToken?: string;
}) {
    const url = new URL('/api/accounts/authorize', PLAN_ISSUER);
    const params = {
        client_id: input.clientId ?? 'dynamic_agent_client', ext_agent_host_id: input.hostId, response_type: 'code', redirect_uri: input.redirectUri, scope: PLAN_SCOPE, resource: PLAN_RESOURCE, state: input.state, nonce: input.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(input.verifier).digest('base64url')
    };
    for (const [key, value] of Object.entries(params))
        url.searchParams.set(key, value);
    if (!input.clientId)
        url.searchParams.set('agent_name_hint', 'Matrix OS');
    if (input.idToken && input.clientId)
        url.searchParams.set('id_token_hint', input.idToken);
    return url.toString();
}
export function parsePlanCallback(path: string, pending: {
    state: string;
    clientId?: string;
}) {
    if (path.length > 32768)
        throw new Error('invalid callback');
    const url = new URL(path, 'http://127.0.0.1');
    if (url.pathname != '/auth/callback')
        throw new Error('invalid callback');
    for (const key of url.searchParams.keys())
        if (url.searchParams.getAll(key).length !== 1)
            throw new Error('invalid callback');
    const state = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(pending.state);
    if (state.length !== expected.length || !timingSafeEqual(state, expected))
        throw new Error('invalid callback');
    if (url.searchParams.has('error'))
        throw new Error('authorization denied');
    const clientId = url.searchParams.get('client_id') ?? pending.clientId;
    if (!clientId || clientId === 'dynamic_agent_client' || clientId.length > 256 || !/^[A-Za-z0-9_-]+$/.test(clientId) || (pending.clientId && clientId !== pending.clientId))
        throw new Error('invalid registration');
    const code = url.searchParams.get('code');
    if (!code || code.length > 8192)
        throw new Error('invalid callback');
    return {
        code, clientId
    };
}
/** Signed identity AND plan resource permission. Token material stays trusted-side. */
export async function validatePlanTokens(raw: unknown, input: {
    jwks: JSONWebKeySet;
    clientId: string;
    nonce?: string;
    subject?: string;
    retainedIdToken?: string;
    now?: number;
}) {
    const parsed = TokenResponse.parse(raw);
    const scope = parsed.scope.split(/\s+/).filter(Boolean);
    for (const required of ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'])
        if (!scope.includes(required))
            throw new PlanFailure('oauth_identity', 'plan_scope_missing');
    const keys = createLocalJWKSet(input.jwks);
    const options = {
        issuer: PLAN_ISSUER, algorithms: ['RS256', 'ES256'], ...(input.now ? { currentDate: new Date(input.now) } : {})
    };
    const access = (await jwtVerify(parsed.access_token, keys, {
        ...options, audience: PLAN_RESOURCE
    })).payload;
    if (access.client_id !== input.clientId || typeof access.sub !== 'string' || typeof access.exp !== 'number' || typeof access.scope !== 'string')
        throw new Error('invalid plan credential');
    for (const required of ['resource.invoke', 'chatgpt.tokens.use.direct'])
        if (!access.scope.split(/\s+/).includes(required))
            throw new PlanFailure('oauth_identity', 'plan_scope_missing');
    let subject = input.subject;
    let email: string | undefined;
    const idToken = parsed.id_token ?? input.retainedIdToken;
    if (parsed.id_token) {
        const identity = (await jwtVerify(parsed.id_token, keys, {
            ...options, audience: input.clientId
        })).payload;
        if (typeof identity.sub !== 'string' || typeof identity.exp !== 'number' || (input.nonce && identity.nonce !== input.nonce) || (subject && identity.sub !== subject))
            throw new Error('invalid identity');
        subject = identity.sub;
        if (typeof identity.email === 'string' && identity.email.length <= 254)
            email = identity.email;
    }
    else if (input.nonce || !subject || !idToken)
        throw new Error('missing identity');
    if (!subject || access.sub !== subject)
        throw new Error('invalid identity');
    const now = input.now ?? Date.now();
    const expiresAt = Math.min(now + parsed.expires_in * 1000, access.exp * 1000);
    if (expiresAt <= now)
        throw new Error('expired credential');
    return {
        clientId: input.clientId, subject, email, accessToken: parsed.access_token, refreshToken: parsed.refresh_token, idToken: idToken!, scopes: scope, expiresAt, earliestRefreshAt: parsed.earliest_refresh_at
    };
}
export async function boundedText(response: Response, limit = 512 * 1024): Promise<string> {
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            bytes += chunk.value.byteLength;
            if (bytes > limit) {
                await reader.cancel();
                throw new Error('response too large');
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    }
    finally {
        reader.releaseLock();
    }
}
export async function planJson(fetchFn: typeof fetch, path: 'token' | 'jwks' | 'models' | 'discovery', init: RequestInit = {}): Promise<unknown> {
    const urls = {
        token: `${PLAN_ISSUER}/api/accounts/oauth/token`, jwks: `${PLAN_ISSUER}/.well-known/jwks.json`, models: `${PLAN_RESOURCE}/models`, discovery: `${PLAN_ISSUER}/.well-known/openid-configuration`
    };
    const stage = {
        token: 'oauth_token', jwks: 'oauth_jwks', models: 'catalog', discovery: 'oauth_discovery'
    }[path];
    let response: Response;
    try {
        response = await fetchFn(urls[path], {
            ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
        });
    }
    catch (error: unknown) {
        if (init.signal?.aborted)
            throw new PlanFailure(stage, 'cancelled');
        throw new PlanFailure(stage, error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network_error');
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new PlanFailure(stage, 'http_error', response.status);
    }
    const text = await boundedText(response);
    try {
        return JSON.parse(text) as unknown;
    }
    catch (error: unknown) {
        if (!(error instanceof SyntaxError))
            throw error;
        throw new PlanFailure(stage, 'invalid_json');
    }
}
