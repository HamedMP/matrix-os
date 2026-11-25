import type { Context } from 'hono';
import type { BeforeGmailSend } from './gmail-send-admission.js';
import { connectedAccountMethod } from './connection-projection.js';

export interface GoogleCollectionLease { beforeSend: BeforeGmailSend; release(): Promise<void>; }

export interface GoogleCollectionAdmission {
  admit(c: Context, connection: { id: string; user_id: string; service: string; status: string }, path: '/call' | '/read-call'): Promise<GoogleCollectionLease>;
}
export class GoogleCollectionRefusedError extends Error {
  constructor() { super('Integration service unavailable'); this.name = 'GoogleCollectionRefusedError'; }
}
/** Optional trusted server dependency. Requests cannot supply admission or
 * replace the canonical account. A lease is settled once on every outcome.
 * Only native (direct OAuth) Gmail requires admission; an account whose stored
 * identity is a Pipedream account keeps its pre-admission behavior. Any other
 * or missing stored identity stays admission-gated. */
export async function admitGoogleCollection(hook: GoogleCollectionAdmission | undefined, c: Context, ownerId: string,
  connection: { id: string; user_id: string; service: string; status: string; pipedream_account_id?: string | null }, path: '/call' | '/read-call'): Promise<GoogleCollectionLease | undefined> {
  if (!hook || connection.service !== 'gmail') return undefined;
  if (connection.pipedream_account_id && connectedAccountMethod({ service: connection.service, pipedream_account_id: connection.pipedream_account_id }) === 'pipedream') return undefined;
  try {
    if (!connection.id || connection.user_id !== ownerId || connection.status !== 'active') throw new GoogleCollectionRefusedError();
    const lease = await hook.admit(c, { id: connection.id, user_id: connection.user_id, service: connection.service, status: connection.status }, path);
    if (!lease || typeof lease.release !== 'function' || typeof lease.beforeSend !== 'function') throw new GoogleCollectionRefusedError();
    let settled = false;
    return {
      beforeSend: async signal => {
        try {
          if (settled || signal.aborted || c.req.raw.signal.aborted) throw new GoogleCollectionRefusedError();
          await lease.beforeSend(signal);
          if (settled || signal.aborted || c.req.raw.signal.aborted) throw new GoogleCollectionRefusedError();
        } catch (error) { if (error instanceof GoogleCollectionRefusedError) throw error; throw new GoogleCollectionRefusedError(); }
      },
      release: async () => {
        if (settled) return;
        settled = true;
        try { await lease.release(); }
        catch (error) { if (error instanceof GoogleCollectionRefusedError) throw error; throw new GoogleCollectionRefusedError(); }
      },
    };
  } catch (error) { if (error instanceof GoogleCollectionRefusedError) throw error; throw new GoogleCollectionRefusedError(); }
}
