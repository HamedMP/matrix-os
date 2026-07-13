import { createHmac } from 'node:crypto';
import {
  getClerkDisplayName,
  getPrimaryClerkEmail,
  normalizeMatrixOsHandleCandidate,
} from '@matrix-os/clerk-sync';
import { z } from 'zod/v4';

import {
  getPlatformUserByClerkId,
  isPlatformHandleAvailableForClerkUser,
  type PlatformDB,
} from './db.js';
import type { DeviceProfile } from './device-flow.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import { logPlatformRouteError } from './platform-route-utils.js';

const CLERK_USER_LOOKUP_TIMEOUT_MS = 10_000;

const ClerkImageUrlSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    new URL(value);
    return value;
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    return null;
  }
}, z.string().url().nullable().optional());

const ClerkUserProfileSchema = z.object({
  username: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  image_url: ClerkImageUrlSchema,
  primary_email_address_id: z.string().nullable().optional(),
  email_addresses: z.array(z.object({
    id: z.string().optional(),
    email_address: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

type ClerkProvisionProfile = z.infer<typeof ClerkUserProfileSchema>;

export interface ProvisionIdentity {
  handle: string;
  displayName: string;
  email?: string;
}

function fallbackProvisionHandleForClerkUser(userId: string, secretKey: string): string {
  const suffix = createHmac('sha256', secretKey)
    .update(userId)
    .digest('hex')
    .slice(0, 12);
  return `u${suffix}`;
}

async function fetchClerkProvisionProfile(
  userId: string,
  env: NodeJS.ProcessEnv,
): Promise<{ secretKey: string; profile: ClerkProvisionProfile }> {
  const secretKey = env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
  }

  let response: Response;
  try {
    response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        authorization: `Bearer ${secretKey}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(CLERK_USER_LOOKUP_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err: unknown) {
    logPlatformRouteError('/api/auth/provision-runtime clerk lookup', err);
    throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
  }
  if (!response.ok) {
    logPlatformRouteError(
      '/api/auth/provision-runtime clerk lookup',
      new Error(`Clerk user lookup failed with status ${response.status}`),
    );
    throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
  }

  const profile = ClerkUserProfileSchema.safeParse(await response.json());
  if (!profile.success) {
    throw new CustomerVpsError(503, 'provider_unavailable', 'Provisioning unavailable');
  }
  return { secretKey, profile: profile.data };
}

// Best-effort, non-secret display profile (name/avatar/email) for the device
// flow's signing-in client. Returns null on any failure or when Clerk is not
// configured -- the caller MUST treat the avatar as optional and never block
// token issuance on it.
export async function fetchDeviceDisplayProfile(
  clerkUserId: string,
  env: NodeJS.ProcessEnv,
): Promise<DeviceProfile | null> {
  const secretKey = env.CLERK_SECRET_KEY;
  if (!secretKey) return null;

  let response: Response;
  try {
    response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkUserId)}`, {
      headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(CLERK_USER_LOOKUP_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err: unknown) {
    logPlatformRouteError('device display profile clerk lookup', err);
    return null;
  }
  if (!response.ok) {
    logPlatformRouteError(
      'device display profile clerk lookup',
      new Error(`Clerk user lookup failed with status ${response.status}`),
    );
    return null;
  }

  const parsed = ClerkUserProfileSchema.safeParse(await response.json());
  if (!parsed.success) return null;
  const profile = parsed.data;

  const displayName =
    [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
    profile.username ||
    undefined;
  const imageUrl = typeof profile.image_url === 'string' ? profile.image_url : undefined;
  const email = getPrimaryClerkEmail(profile);
  if (!displayName && !imageUrl && !email) return null;
  return {
    ...(displayName ? { displayName } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(email ? { email } : {}),
  };
}

function resolveProvisionHandleCandidatesFromClerkProfile(
  userId: string,
  profile: ClerkProvisionProfile,
  secretKey: string,
): string[] {
  const candidates: string[] = [];
  const addCandidate = (candidate: string | null) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  const usernameHandle = normalizeMatrixOsHandleCandidate(profile.username);
  addCandidate(usernameHandle);

  const primaryEmail = getPrimaryClerkEmail(profile);
  const primaryEmailHandle = normalizeMatrixOsHandleCandidate(primaryEmail?.split('@')[0]);
  addCandidate(primaryEmailHandle);

  const firstEmailHandle = normalizeMatrixOsHandleCandidate(
    profile.email_addresses?.[0]?.email_address?.split('@')[0],
  );
  addCandidate(firstEmailHandle);
  addCandidate(fallbackProvisionHandleForClerkUser(userId, secretKey));
  return candidates;
}

export async function selectProvisionIdentityForClerkUser(
  db: PlatformDB,
  userId: string,
  env: NodeJS.ProcessEnv,
): Promise<ProvisionIdentity | null> {
  const existing = await getPlatformUserByClerkId(db, userId);
  if (existing && await isPlatformHandleAvailableForClerkUser(db, existing.handle, userId)) {
    return {
      handle: existing.handle,
      displayName: existing.displayName,
      email: existing.email,
    };
  }
  const { secretKey, profile } = await fetchClerkProvisionProfile(userId, env);
  const candidates = existing
    ? [existing.handle, ...resolveProvisionHandleCandidatesFromClerkProfile(userId, profile, secretKey)]
    : resolveProvisionHandleCandidatesFromClerkProfile(userId, profile, secretKey);
  for (const handle of candidates) {
    if (await isPlatformHandleAvailableForClerkUser(db, handle, userId)) {
      return {
        handle,
        displayName: getClerkDisplayName(profile, handle),
        email: getPrimaryClerkEmail(profile),
      };
    }
  }
  return null;
}
