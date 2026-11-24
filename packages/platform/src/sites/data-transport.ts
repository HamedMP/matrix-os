import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import type { Agent } from 'undici';
import { z } from 'zod/v4';
import { SITE_PUBLIC_DATA_RESPONSE_MAX_BYTES, type SitePublicDataRequest, type SiteRecord } from '@matrix-os/contracts';
import { getUserMachine, type PlatformDB } from '../db.js';
import { buildPlatformSyncVerificationToken } from '../platform-token.js';
import { buildCustomerVpsProxyUrl } from '../profile-routing.js';
import { SiteError } from './types.js';

export type SiteDataOutcome = { ok: true; result: unknown } | { ok: false; status: 400 | 429 | 503 };
export interface SiteDataTransport {
    /** Per-site keyed hash: raw visitor IPs never leave the platform and cannot be joined across sites. */
    visitorHash(siteId: string, source: string): string;
    forward(site: SiteRecord, visitor: string, request: SitePublicDataRequest, trx?: PlatformDB): Promise<SiteDataOutcome>;
    /**
     * Writes hold a share lock on the publication row through forwarding, so unpublish or a switch
     * to private link (which take FOR UPDATE) either precede the write or wait for it (551 R7).
     * Visitor writes for one owner run concurrently; they never take the owner publish admission.
     */
    forwardWrite(site: SiteRecord, visitor: string, request: SitePublicDataRequest): Promise<SiteDataOutcome>;
}
const GatewayResultSchema = z.object({ result: z.unknown() }).strict();

async function boundedText(response: Response): Promise<string | null> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > SITE_PUBLIC_DATA_RESPONSE_MAX_BYTES + 1024) { await reader.cancel(); return null; }
            parts.push(chunk.value);
        }
    } finally { reader.releaseLock(); }
    return Buffer.concat(parts, size).toString('utf8');
}

/** Platform-signed, app-scoped forwarding to the owner gateway (2694). */
export function createSiteDataTransport(options: { db: PlatformDB; platformSecret: string; dispatcher?: Agent }): SiteDataTransport {
    const visitorKey = createHmac('sha256', options.platformSecret).update('matrix-site-visitor-v1').digest();
    const forward: SiteDataTransport['forward'] = async (site, visitor, request, trx = options.db) => {
        if (!site.activeVersion) throw new SiteError('not_found');
        const record = await trx.executor.selectFrom('public_sites').select('machine_id').where('id', '=', site.id).executeTakeFirstOrThrow();
        const machine = await getUserMachine(trx, record.machine_id);
        if (!machine || machine.status !== 'running' || machine.deletedAt || machine.provisioningClass !== 'customer')
            throw new SiteError('unavailable');
        const url = buildCustomerVpsProxyUrl(machine, `/api/internal/sites/${site.id}/data`);
        if (!url) throw new SiteError('unavailable');
        const timestamp = String(Date.now());
        // The visitor never names the app: the published site's app slug is signed here.
        const body = JSON.stringify({ siteId: site.id, appSlug: site.appSlug, versionId: site.activeVersion, visitor, request });
        const token = buildPlatformSyncVerificationToken({ handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, options.platformSecret, machine.runtimeTokenEpoch);
        const signature = createHmac('sha256', token).update(`${timestamp}.${body}`).digest('hex');
        const response = await fetch(url, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-matrix-site-timestamp': timestamp, 'x-matrix-site-signature': signature },
            body, redirect: 'error', signal: AbortSignal.timeout(10000), ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
        } as RequestInit);
        if (response.status === 400 || response.status === 429) {
            await response.body?.cancel();
            return { ok: false, status: response.status };
        }
        if (!response.ok) {
            await response.body?.cancel();
            return { ok: false, status: 503 };
        }
        const text = await boundedText(response);
        if (text === null) return { ok: false, status: 503 };
        let parsed: ReturnType<typeof GatewayResultSchema.safeParse>;
        try { parsed = GatewayResultSchema.safeParse(JSON.parse(text)); }
        catch (error: unknown) {
            if (error instanceof SyntaxError) return { ok: false, status: 503 };
            throw error;
        }
        return parsed.success ? { ok: true, result: parsed.data.result ?? null } : { ok: false, status: 503 };
    };
    return {
        visitorHash(siteId, source) {
            return createHmac('sha256', visitorKey).update(siteId).update('\0').update(source).digest('hex');
        },
        async forwardWrite(site, visitor, request) {
            return options.db.transaction(async (trx) => {
                await sql`SET LOCAL lock_timeout = '2s'`.execute(trx.executor);
                await sql`SET LOCAL statement_timeout = '5s'`.execute(trx.executor);
                const row = await trx.executor.selectFrom('public_sites').select(['status', 'access_mode', 'active_version', 'public_data_enabled_at'])
                    .where('id', '=', site.id).forShare().executeTakeFirst();
                if (!row || row.status !== 'published' || row.access_mode !== 'public' || row.active_version !== site.activeVersion
                    || row.public_data_enabled_at == null)
                    throw new SiteError('not_found');
                return forward(site, visitor, request, trx);
            });
        },
        forward,
    };
}
