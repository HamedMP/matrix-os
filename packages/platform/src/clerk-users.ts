import {
  ensurePlatformUser,
  getPlatformUserByHandle,
  type NewPlatformUser,
  type PlatformDB,
} from './db.js';

export const PLATFORM_HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;
const CLERK_USERS_PAGE_LIMIT = 100;
const CLERK_USERS_FETCH_TIMEOUT_MS = 10_000;

export interface ClerkEmailAddress {
  id?: string;
  email_address?: string;
}

export interface ClerkUserForSync {
  id: string;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
}

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

export function normalizePlatformHandleCandidate(value: string | undefined | null): string | null {
  if (!value) return null;
  const candidate = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31)
    .replace(/-+$/g, '');
  return PLATFORM_HANDLE_PATTERN.test(candidate) ? candidate : null;
}

export function fallbackPlatformHandleForClerkUser(userId: string): string {
  return normalizePlatformHandleCandidate(`u-${userId}`) ?? `u${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase()}`;
}

export function getPrimaryClerkEmail(user: ClerkUserForSync): string | null {
  const primary = user.email_addresses?.find(
    (email) => email.id && email.id === user.primary_email_address_id,
  )?.email_address;
  return primary ?? user.email_addresses?.find((email) => email.email_address)?.email_address ?? null;
}

export function buildPlatformUserFromClerkUser(
  user: ClerkUserForSync,
  handle: string,
): NewPlatformUser {
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    user.username ||
    handle;
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
  const candidates = [
    normalizePlatformHandleCandidate(user.username),
    normalizePlatformHandleCandidate(getPrimaryClerkEmail(user)?.split('@')[0]),
    normalizePlatformHandleCandidate(user.email_addresses?.[0]?.email_address?.split('@')[0]),
    fallbackPlatformHandleForClerkUser(user.id),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return Array.from(new Set(candidates));
}

async function selectAvailableHandleForClerkUser(
  db: PlatformDB,
  user: ClerkUserForSync,
): Promise<string | null> {
  for (const handle of getClerkUserHandleCandidates(user)) {
    const existing = await getPlatformUserByHandle(db, handle);
    if (!existing || existing.clerkId === user.id) return handle;
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
        await ensurePlatformUser(db, record);
      }
      result.synced += 1;
      logger.log(`${options.apply ? 'synced' : 'would sync'} ${user.id} as ${handle}`);
    }

    if (users.length < CLERK_USERS_PAGE_LIMIT) break;
  }

  return result;
}
