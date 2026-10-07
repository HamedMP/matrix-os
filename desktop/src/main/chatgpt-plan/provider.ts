import { z } from 'zod/v4';
import type { JSONWebKeySet } from 'jose';
import { ChatgptPlanModelSchema } from '../../shared/chatgpt-plan-ipc';
import { PLAN_ISSUER, planJson } from './oauth';
import { logPlanFailure, PlanFailure } from './diagnostics';
import type { PlanAccount } from './vault';
const CatalogSchema = z.object({ models: z.array(z.object({
        slug: z.string().max(128), display_name: z.string().max(128), visibility: z.string().max(32)
    })).max(256) });
export function planCatalog(raw: unknown) {
    // Conservative app budgets, not claims of provider context/quota entitlement.
    const models = CatalogSchema.parse(raw).models.filter(item => item.visibility === 'list').slice(0, 64).map(item => ChatgptPlanModelSchema.parse({
        id: item.slug, displayName: item.display_name, input: ['text'], contextWindow: 32768, maxOutputTokens: 4096
    }));
    if (new Set(models.map(item => item.id)).size !== models.length)
        throw new PlanFailure('catalog', 'invalid_catalog');
    return models;
}
export async function planJwks(fetchFn: typeof fetch, signal: AbortSignal): Promise<JSONWebKeySet> {
    const raw = await planJson(fetchFn, 'jwks', { signal });
    return z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(32) }).parse(raw) as JSONWebKeySet;
}
export async function revokePlanAccount(fetchFn: typeof fetch, account?: PlanAccount): Promise<'none' | 'confirmed' | 'unconfirmed'> {
    if (!account?.tokens)
        return 'none';
    try {
        const discovery = z.object({ revocation_endpoint: z.literal(`${PLAN_ISSUER}/api/accounts/oauth/revoke`) }).parse(await planJson(fetchFn, 'discovery'));
        const response = await fetchFn(discovery.revocation_endpoint, {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                token: account.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId
            }),
            signal: AbortSignal.timeout(10000)
        });
        await response.body?.cancel();
        if (response.status === 200)
            return 'confirmed';
        logPlanFailure('oauth_revoke', new PlanFailure('oauth_revoke', 'http_error', response.status));
    }
    catch (error: unknown) {
        logPlanFailure('oauth_revoke', error);
    }
    return 'unconfirmed';
}
