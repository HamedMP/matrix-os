import type { Agent, Dispatcher } from 'undici';
import type { UserMachineRecord } from '../db.js';
import { buildRuntimeAuthToken } from '../platform-token.js';
import { buildCustomerVpsProxyUrl } from '../profile-routing.js';
import type { SubstrateRegistry } from '../substrates/registry.js';
import { applyUpstreamCredentials, needsVerifiedTransport, verifiedDispatcher } from '../substrates/upstream-transport.js';

export interface SiteMachineUpstream {
    url: string;
    /** Owned machines: the owned bearer, Access credentials, and upstream host; empty for hosted runtimes. */
    headers: Headers;
    dispatcher?: Dispatcher;
}

/**
 * Where a site request for this machine goes. Hosted runtimes use the customer
 * VPS pool; owned machines (spec 2707) go through their tunnel with the same
 * credentials and verified TLS as session routing, and resolve to null while
 * offline. Machines that cannot host sites also resolve to null.
 */
export function resolveSiteMachineUpstream(
    machine: UserMachineRecord,
    path: string,
    options: { platformSecret: string; dispatcher?: Agent; substrates?: SubstrateRegistry },
): SiteMachineUpstream | null {
    if (machine.status !== 'running' || machine.deletedAt) return null;
    if (machine.provisioningClass === 'owned') {
        const resolution = options.substrates?.resolveUpstream(machine, { path });
        if (resolution?.kind !== 'upstream') return null;
        const headers = new Headers();
        applyUpstreamCredentials(headers, resolution.upstream);
        headers.set('authorization', `Bearer ${buildRuntimeAuthToken(machine, options.platformSecret)}`);
        const dispatcher = needsVerifiedTransport(resolution.upstream) ? verifiedDispatcher(resolution.upstream) : options.dispatcher;
        return { url: resolution.upstream.url, headers, ...(dispatcher ? { dispatcher } : {}) };
    }
    if (machine.provisioningClass !== 'customer') return null;
    const url = buildCustomerVpsProxyUrl(machine, path);
    return url ? { url, headers: new Headers(), ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}) } : null;
}
