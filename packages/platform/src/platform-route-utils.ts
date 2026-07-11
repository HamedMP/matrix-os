import {
  ensurePlatformUser,
  type PlatformDB,
} from './db.js';

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function logPlatformRouteError(route: string, err: unknown): void {
  console.error(
    `[platform] ${route} failed:`,
    err instanceof Error ? err.message : String(err),
  );
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

export function isPostgresUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: unknown }).code === '23505';
}

export function requireValidHandle(handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error('Invalid handle');
  }
  return handle;
}

export async function ensureProvisionedPlatformUser(
  db: PlatformDB,
  input: {
    clerkUserId: string;
    handle: string;
    displayName?: string;
    email?: string;
    runtimeId: string;
  },
): Promise<void> {
  await ensurePlatformUser(db, {
    clerkId: input.clerkUserId,
    handle: input.handle,
    displayName: input.displayName ?? input.handle,
    email: input.email ?? `${input.handle}@matrix-os.local`,
    containerId: input.runtimeId,
    plan: 'free',
    status: 'active',
  });
}
