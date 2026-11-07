import { z } from 'zod/v4';

export class DevstackBootstrapError extends Error {
  constructor(message: string) { super(message); this.name = 'DevstackBootstrapError'; }
}

export const DevstackInstanceSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
export const DevstackClerkUserIdSchema = z.string().regex(/^user_[A-Za-z0-9_]{1,128}$/);
export const DevstackContainerIdSchema = z.string().length(64).regex(/^[0-9a-f]+$/);
export const DevstackPortSchema = z.number().int().min(1).max(65535);

export function devstackOwnerMarker(instance: string, clerkUserId: string): string {
  return `devstack:${instance}:${clerkUserId}`;
}

/** Validate before constructing a pool, since createPlatformDb starts migrations. */
export function assertLocalDevstackDatabase(
  databaseUrl: string,
  instance: string,
  mode: string | undefined,
  allowOwnedSocket = false,
): string {
  if (mode !== 'local' || !DevstackInstanceSchema.safeParse(instance).success || instance.includes('\n')) {
    throw new DevstackBootstrapError('DevStack bootstrap requires local mode and a valid instance slug.');
  }
  let url: URL;
  try {
    if (allowOwnedSocket) decodeURI(databaseUrl);
    url = new URL(databaseUrl);
  }
  catch (error: unknown) {
    if (!(error instanceof TypeError || error instanceof URIError)) throw error;
    throw new DevstackBootstrapError('DevStack bootstrap requires a valid local Postgres URL.');
  }

  const socketAllowed = allowOwnedSocket && url.searchParams.size === 1
    && url.searchParams.get('host') === `/run/matrix-devstack/${instance}/pg-proxy`;
  if (databaseUrl.length > 4096 || databaseUrl !== databaseUrl.trim()
    || (allowOwnedSocket && /\s/.test(databaseUrl))
    || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== `/matrixos_devstack_${instance.replaceAll('-', '_')}`
    || (url.search && !socketAllowed) || url.hash) {
    throw new DevstackBootstrapError(allowOwnedSocket
      ? 'DevStack routing requires its instance-specific literal-loopback Postgres database or owned Unix socket.'
      : 'DevStack bootstrap requires its instance-specific literal-loopback Postgres database without URL options.');
  }
  if (allowOwnedSocket && !socketAllowed && url.hostname === '[::1]') {
    // pg uses the query host as the dial address; Node TCP requires an unbracketed IPv6 literal.
    url.searchParams.set('host', '::1');
    return url.href;
  }
  return databaseUrl;
}
