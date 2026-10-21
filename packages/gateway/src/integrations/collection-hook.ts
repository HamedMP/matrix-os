import type { Context } from 'hono';

export interface GoogleCollectionAdmission {
  admit(c: Context, connection: { id: string; user_id: string; service: string; status: string }, path: '/call' | '/read-call'): Promise<{ release(): Promise<void> }>;
}
export class GoogleCollectionRefusedError extends Error {
  constructor() { super('Integration service unavailable'); this.name = 'GoogleCollectionRefusedError'; }
}
/** Optional trusted server dependency. Requests cannot supply admission or
 * replace the canonical account. A lease is settled once on every outcome. */
export async function admitGoogleCollection(hook: GoogleCollectionAdmission | undefined, c: Context, ownerId: string,
  connection: { id: string; user_id: string; service: string; status: string }, path: '/call' | '/read-call'): Promise<(() => Promise<void>) | undefined> {
  if (!hook || connection.service !== 'gmail') return undefined;
  try {
    if (!connection.id || connection.user_id !== ownerId || connection.status !== 'active') throw new GoogleCollectionRefusedError();
    const lease = await hook.admit(c, { id: connection.id, user_id: connection.user_id, service: connection.service, status: connection.status }, path);
    if (!lease || typeof lease.release !== 'function') throw new GoogleCollectionRefusedError();
    let settled = false;
    return async () => {
      if (settled) return;
      settled = true;
      try { await lease.release(); }
      catch (error) { if (error instanceof GoogleCollectionRefusedError) throw error; throw new GoogleCollectionRefusedError(); }
    };
  } catch (error) { if (error instanceof GoogleCollectionRefusedError) throw error; throw new GoogleCollectionRefusedError(); }
}
