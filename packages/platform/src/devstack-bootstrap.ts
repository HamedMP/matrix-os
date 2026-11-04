import { sql } from 'kysely';
import {
  ensurePlatformUser, getContainer, getContainerByClerkId, getPlatformHandleConflict,
  getPlatformUserByClerkId, lockUserMachineProvisioning, type ContainerRecord, type PlatformDB,
} from './db.js';
import { z } from 'zod/v4';
import { HANDLE_PATTERN } from './platform-route-utils.js';

export interface DevstackBootstrapInput {
  instance: string;
  clerkUserId: string;
  handle: string;
  email: string;
  displayName?: string;
  containerId: string;
  gatewayPort: number;
  shellPort: number;
}

export class DevstackBootstrapError extends Error {
  constructor(message: string) { super(message); this.name = 'DevstackBootstrapError'; }
}

const InstanceSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
const InputSchema = z.strictObject({
  instance: InstanceSchema,
  clerkUserId: z.string().regex(/^user_[A-Za-z0-9_]{1,128}$/),
  handle: z.string().regex(HANDLE_PATTERN),
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(128).optional(),
  containerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  gatewayPort: z.number().int().min(1).max(65535),
  shellPort: z.number().int().min(1).max(65535),
});

export function parseDevstackBootstrapInput(input: unknown): DevstackBootstrapInput {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) throw new DevstackBootstrapError('Invalid DevStack identity registration; check the required CLI fields and ports.');
  return parsed.data;
}

/** Validate before constructing any pool: createPlatformDb starts migrations. */
export function assertLocalDevstackDatabase(databaseUrl: string, instance: string, mode: string | undefined): string {
  if (mode !== 'local' || !InstanceSchema.safeParse(instance).success) {
    throw new DevstackBootstrapError('DevStack bootstrap requires local mode and a valid instance slug.');
  }
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new DevstackBootstrapError('DevStack bootstrap requires a valid local Postgres URL.');
  }
  if (databaseUrl.length > 4096 || databaseUrl !== databaseUrl.trim()
    || !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== `/matrixos_devstack_${instance.replaceAll('-', '_')}`
    || url.search || url.hash) {
    throw new DevstackBootstrapError('DevStack bootstrap requires its instance-specific literal-loopback Postgres database without URL options.');
  }
  return databaseUrl;
}

function assertOwnedRoute(route: ContainerRecord, input: DevstackBootstrapInput): void {
  if (route.handle !== input.handle || route.clerkUserId !== input.clerkUserId
    || route.containerId !== input.containerId || route.port !== input.gatewayPort
    || route.shellPort !== input.shellPort || route.status !== 'running') {
    throw new DevstackBootstrapError('Existing DevStack registration is not owned by this exact local runtime; refusing to repoint it.');
  }
}

/** Call only after the CLI has admitted an isolated local database. */
export async function bootstrapDevstackIdentity(db: PlatformDB, rawInput: DevstackBootstrapInput) {
  const input = parseDevstackBootstrapInput(rawInput);
  const ownerMarker = `devstack:${input.instance}:${input.clerkUserId}`;
  return db.transaction(async (transaction) => {
    await lockUserMachineProvisioning(transaction, input.clerkUserId);
    // This offline local initializer must not adopt a concurrently projected
    // foreign row. Hold both tiny registries through validation and the reused
    // domain upsert, including writers that do not take the provisioning lock.
    await sql`LOCK TABLE users, containers IN SHARE ROW EXCLUSIVE MODE`.execute(transaction.executor);
    const existing = await getPlatformUserByClerkId(transaction, input.clerkUserId);
    if (existing && (existing.containerId !== ownerMarker || existing.handle !== input.handle
      || existing.email !== input.email || existing.plan !== 'free' || existing.status !== 'active')) {
      throw new DevstackBootstrapError('Existing user ownership does not match this local DevStack instance.');
    }
    if (await getPlatformHandleConflict(transaction, input.handle, input.clerkUserId)) {
      throw new DevstackBootstrapError('Requested local handle is already owned by another identity.');
    }
    const previousRoute = await getContainerByClerkId(transaction, input.clerkUserId);
    if (previousRoute) assertOwnedRoute(previousRoute, input);

    const now = new Date().toISOString();
    await transaction.executor.insertInto('containers').values({
      handle: input.handle, clerk_user_id: input.clerkUserId, container_id: input.containerId,
      port: input.gatewayPort, shell_port: input.shellPort, status: 'running',
      created_at: now, last_active: now,
    }).onConflict((conflict) => conflict.doNothing()).execute();
    const route = await getContainer(transaction, input.handle);
    if (!route) throw new DevstackBootstrapError('Local DevStack registration was not retained.');
    assertOwnedRoute(route, input);

    const account = await ensurePlatformUser(transaction, {
      clerkId: input.clerkUserId, handle: input.handle, email: input.email,
      displayName: input.displayName ?? input.handle, containerId: ownerMarker,
      plan: 'free', status: 'active',
    });
    // The real integration connect route assigns/persists external ID before
    // issuing a provider session. Preserve that mapping on every later rerun.
    return { instance: input.instance, userId: account.id, handle: account.handle,
      pipedreamExternalId: account.pipedreamExternalId,
      runtime: { containerId: route.containerId, gatewayPort: route.port, shellPort: route.shellPort } };
  });
}
