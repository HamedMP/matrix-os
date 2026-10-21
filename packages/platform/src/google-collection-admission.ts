import type { Context } from 'hono';
import { buildPlatformVerificationToken } from './platform-token.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';

/** Structural dynamic-runtime contract; no gateway source import in the platform build. */
export interface InternalGoogleCollectionAdmission {
  admit(c: Context, connection: { id: string; user_id: string; service: string; status: string }, path: '/call' | '/read-call'):
    Promise<{ beforeSend(signal: AbortSignal): Promise<void>; release(): Promise<void> }>;
}
export function createPlatformGoogleCollectionAdmission<DB>(options: {
  integrationDb: DB; platformSecret: string;
  createAdmission(input: { db: DB; machineTokenForHandle(handle: string): string }): InternalGoogleCollectionAdmission;
}): InternalGoogleCollectionAdmission {
  if (!options.platformSecret || typeof options.createAdmission !== 'function') throw new Error('Internal Gmail admission unavailable');
  return options.createAdmission({ db: options.integrationDb, machineTokenForHandle: handle => {
    if (!HANDLE_PATTERN.test(handle)) throw new Error('Internal Gmail admission unavailable');
    return buildPlatformVerificationToken(handle, options.platformSecret);
  } });
}
