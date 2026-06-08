export const MATRIX_OS_HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

export interface ClerkEmailAddress {
  id?: string;
  email_address?: string;
}

export interface ClerkUserProfile {
  id: string;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
}

export function normalizeMatrixOsHandleCandidate(value: string | undefined | null): string | null {
  if (!value) return null;
  const candidate = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31)
    .replace(/-+$/g, '');
  return MATRIX_OS_HANDLE_PATTERN.test(candidate) ? candidate : null;
}

export function getPrimaryClerkEmail(user: Pick<ClerkUserProfile, 'primary_email_address_id' | 'email_addresses'>): string | undefined {
  return user.email_addresses?.find(
    (email) => email.id && email.id === user.primary_email_address_id,
  )?.email_address ?? user.email_addresses?.find((email) => email.email_address)?.email_address;
}

export function getClerkDisplayName(user: Pick<ClerkUserProfile, 'first_name' | 'last_name' | 'username'>, fallback: string): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') ||
    user.username ||
    fallback;
}

export function getProvisionHandleCandidates(user: ClerkUserProfile, handlePrefix = ''): string[] {
  const withPrefix = (value: string | undefined | null) =>
    value ? normalizeMatrixOsHandleCandidate(`${handlePrefix}${value}`) : null;
  const candidates = [
    withPrefix(user.username),
    withPrefix(getPrimaryClerkEmail(user)?.split('@')[0]),
    withPrefix(`u-${user.id}`),
    normalizeMatrixOsHandleCandidate(`u-${user.id}`),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return Array.from(new Set(candidates));
}

export function getProvisionHandle(user: ClerkUserProfile, handlePrefix = ''): string {
  const handle = getProvisionHandleCandidates(user, handlePrefix)[0];
  if (!handle) {
    throw new Error('Unable to derive a valid Matrix OS handle');
  }
  return handle;
}
