const HANDLE_PATTERN = /^[a-z][a-z0-9-]{2,30}$/;

export interface ClerkProvisionUser {
  id: string;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id?: string; email_address?: string }>;
}

export function normalizeHandleCandidate(value: string | undefined | null): string | null {
  if (!value) return null;
  const candidate = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
    .replace(/-+$/g, "");
  return HANDLE_PATTERN.test(candidate) ? candidate : null;
}

export function getPrimaryEmail(user: ClerkProvisionUser): string | undefined {
  return user.email_addresses?.find(
    (email) => email.id && email.id === user.primary_email_address_id,
  )?.email_address ?? user.email_addresses?.find((email) => email.email_address)?.email_address;
}

export function getProvisionHandle(user: ClerkProvisionUser, handlePrefix = ""): string {
  const withPrefix = (value: string | undefined | null) =>
    value ? normalizeHandleCandidate(`${handlePrefix}${value}`) : null;
  const handle = withPrefix(user.username) ??
    withPrefix(getPrimaryEmail(user)?.split("@")[0]) ??
    withPrefix(`u-${user.id}`) ??
    normalizeHandleCandidate(`u-${user.id}`);
  if (!handle) {
    throw new Error("Unable to derive a valid Matrix OS handle");
  }
  return handle;
}
