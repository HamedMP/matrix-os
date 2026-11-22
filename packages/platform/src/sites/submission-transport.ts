import { createHmac } from 'node:crypto';
import type { Agent } from 'undici';
import type { SiteRecord } from '@matrix-os/contracts';
import { getUserMachine, type PlatformDB } from '../db.js';
import { buildPlatformSyncVerificationToken, buildRuntimeAuthToken } from '../platform-token.js';
import type { SubstrateRegistry } from '../substrates/registry.js';
import { buildCustomerVpsProxyUrl } from '../profile-routing.js';
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
        const owned = machine?.provisioningClass === 'owned';
        if (!machine || machine.status !== 'running' || machine.deletedAt || (machine.provisioningClass !== 'customer' && !owned))
            throw new SiteError('unavailable');
        const submitPath = `/api/internal/sites/${site.id}/submit`;
        // Spec 2707: an offline owned machine fails the submission; pages keep serving from storage.
        const resolution = owned ? options.substrates?.resolveUpstream(machine, { path: submitPath }) : undefined;
        const ownedUpstream = resolution?.kind === 'upstream' ? resolution.upstream : undefined;
        const url = owned ? ownedUpstream?.url : buildCustomerVpsProxyUrl(machine, submitPath);
        if (!url)
            throw new SiteError('unavailable');
        const timestamp = String(Date.now());
        const body = JSON.stringify({ siteId: site.id, appSlug: site.appSlug, versionId: site.activeVersion, config: site.config, formId, ...input });
        const signature = createHmac('sha256', buildPlatformSyncVerificationToken({handle:machine.handle,machineId:machine.machineId,runtimeSlot:machine.runtimeSlot}, options.platformSecret,machine.runtimeTokenEpoch)).update(`${timestamp}.${body}`).digest('hex');
        const response = await fetch(url, { method: 'POST', headers: { ...(ownedUpstream ? { ...ownedUpstream.headers, authorization: `Bearer ${buildRuntimeAuthToken(machine, options.platformSecret)}` } : {}), 'content-type': 'application/json', 'x-matrix-site-timestamp': timestamp, 'x-matrix-site-signature': signature }, body, redirect: 'error', signal: AbortSignal.timeout(10000), ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}) } as RequestInit);
        await response.body?.cancel();
        if (!response.ok)
            throw new SiteError('unavailable');
        return { accepted: true };
    };
}
