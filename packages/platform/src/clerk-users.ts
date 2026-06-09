import {
  getClerkDisplayName,
  getPrimaryClerkEmail,
  getProvisionHandleCandidates,
  normalizeMatrixOsHandleCandidate,
  type ClerkUserProfile,
} from '@matrix-os/clerk-sync';
import {
  ensurePlatformUser,
  isPlatformHandleAvailableForClerkUser,
  type NewPlatformUser,
  type PlatformDB,
} from './db.js';

const CLERK_USERS_PAGE_LIMIT = 100;
const CLERK_USERS_FETCH_TIMEOUT_MS = 10_000;

export type ClerkUserForSync = ClerkUserProfile;

export interface ClerkUsersBackfillOptions {
  clerkSecretKey: string;
  apply: boolean;
  fetchFn?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface ClerkUsersBackfillResult {
  scanned: number;
  synced: number;
  skipped: number;
}

export function fallbackPlatformHandleForClerkUser(userId: string): string {
  return normalizeMatrixOsHandleCandidate(`u-${userId}`) ?? `u${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase()}`;
}

export function buildPlatformUserFromClerkUser(
  user: ClerkUserForSync,
  handle: string,
): NewPlatformUser {
  const displayName = getClerkDisplayName(user, handle);
  const email = getPrimaryClerkEmail(user) ?? `${handle}@matrix-os.local`;
  return {
    clerkId: user.id,
    handle,
    displayName,
    email,
    containerId: `clerk:${user.id}`,
    plan: 'free',
    status: 'active',
  };
}

export function getClerkUserHandleCandidates(user: ClerkUserForSync): string[] {
  return getProvisionHandleCandidates(user);
}

function isHandleUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; constraint?: unknown; message?: unknown };
  return candidate.code === '23505' &&
    (
      candidate.constraint === 'users_handle_key' ||
      String(candidate.message ?? '').includes('users_handle_key')
    );
}

async function selectAvailableHandleForClerkUser(
  db: PlatformDB,
  user: ClerkUserForSync,
): Promise<string | null> {
  for (const handle of getClerkUserHandleCandidates(user)) {
    if (await isPlatformHandleAvailableForClerkUser(db, handle, user.id)) return handle;
  }
  return null;
}

async function fetchClerkUsersPage(
  secretKey: string,
  offset: number,
  fetchFn: typeof fetch,
): Promise<ClerkUserForSync[]> {
  const url = new URL('https://api.clerk.com/v1/users');
  url.searchParams.set('limit', String(CLERK_USERS_PAGE_LIMIT));
  url.searchParams.set('offset', String(offset));
  const response = await fetchFn(url, {
    headers: {
      authorization: `Bearer ${secretKey}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(CLERK_USERS_FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Clerk users list failed with status ${response.status}`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) {
    throw new Error('Clerk users list returned an unexpected payload');
  }
  return body as ClerkUserForSync[];
}

export async function backfillClerkUsersToPlatformDb(
  db: PlatformDB,
  options: ClerkUsersBackfillOptions,
): Promise<ClerkUsersBackfillResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const logger = options.logger ?? console;
  const result: ClerkUsersBackfillResult = { scanned: 0, synced: 0, skipped: 0 };

  for (let offset = 0; ; offset += CLERK_USERS_PAGE_LIMIT) {
    const users = await fetchClerkUsersPage(options.clerkSecretKey, offset, fetchFn);
    if (users.length === 0) break;

    for (const user of users) {
      result.scanned += 1;
      const handle = await selectAvailableHandleForClerkUser(db, user);
      if (!handle) {
        result.skipped += 1;
        logger.warn(`[clerk-users] skipped ${user.id}: no available handle`);
        continue;
      }
      const record = buildPlatformUserFromClerkUser(user, handle);
      if (options.apply) {
        try {
          await ensurePlatformUser(db, record);
        } catch (err: unknown) {
          if (isHandleUniqueViolation(err)) {
            const fallback = fallbackPlatformHandleForClerkUser(user.id);
            if (fallback !== handle) {
              try {
                await ensurePlatformUser(db, buildPlatformUserFromClerkUser(user, fallback));
              } catch (fallbackErr: unknown) {
                if (isHandleUniqueViolation(fallbackErr)) {
                  result.skipped += 1;
                  logger.warn(`[clerk-users] skipped ${user.id}: fallback handle ${fallback} also collided`);
                  continue;
                }
                throw fallbackErr;
              }
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
      result.synced += 1;
      logger.log(`${options.apply ? 'synced' : 'would sync'} ${user.id} as ${handle}`);
    }

    if (users.length < CLERK_USERS_PAGE_LIMIT) break;
  }

  return result;
}
