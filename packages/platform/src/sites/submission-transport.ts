import { createHmac } from 'node:crypto';
import type { Agent } from 'undici';
import type { SiteRecord } from '@matrix-os/contracts';
import { getUserMachine, type PlatformDB } from '../db.js';
import { buildPlatformSyncVerificationToken } from '../platform-token.js';
import type { SubstrateRegistry } from '../substrates/registry.js';
import { resolveSiteMachineUpstream } from './machine-upstream.js';
import { SiteError } from './types.js';
export function createSiteSubmissionTransport(options: {
    platformSecret: string;
    dispatcher?: Agent;
    substrates?: SubstrateRegistry;
}) {
    return async (site: SiteRecord, trx: PlatformDB, formId: string, input: {
        fields: Record<string, string | number | boolean>;
        idempotencyKey: string;
    }): Promise<{
        accepted: true;
    }> => {
        const record = await trx.executor.selectFrom('public_sites').select('machine_id').where('id', '=', site.id).executeTakeFirstOrThrow();
        const machine = await getUserMachine(trx, record.machine_id);
        // Spec 2707: an offline owned machine fails the submission; pages keep serving from storage.
        const upstream = machine ? resolveSiteMachineUpstream(machine, `/api/internal/sites/${site.id}/submit`, options) : null;
        if (!machine || !upstream)
            throw new SiteError('unavailable');
        const timestamp = String(Date.now());
        const body = JSON.stringify({ siteId: site.id, appSlug: site.appSlug, versionId: site.activeVersion, config: site.config, formId, ...input });
        const signature = createHmac('sha256', buildPlatformSyncVerificationToken({handle:machine.handle,machineId:machine.machineId,runtimeSlot:machine.runtimeSlot}, options.platformSecret,machine.runtimeTokenEpoch)).update(`${timestamp}.${body}`).digest('hex');
        const headers = upstream.headers;
        headers.set('content-type', 'application/json');
        headers.set('x-matrix-site-timestamp', timestamp);
        headers.set('x-matrix-site-signature', signature);
        const response = await fetch(upstream.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000), ...(upstream.dispatcher ? { dispatcher: upstream.dispatcher } : {}) } as RequestInit);
        await response.body?.cancel();
        if (!response.ok)
            throw new SiteError('unavailable');
        return { accepted: true };
    };
}
