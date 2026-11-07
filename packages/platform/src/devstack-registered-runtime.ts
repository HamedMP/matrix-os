import type { PlatformDB } from './db.js';
import {
  DevstackClerkUserIdSchema, DevstackContainerIdSchema, DevstackPortSchema, devstackOwnerMarker,
} from './devstack-identity.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';
import type { AppDomainIdentity } from './session-routing-identity.js';

export interface RegisteredRuntimeEndpoint {
  source: 'record';
  handle: string;
  clerkUserId: string;
  containerId: string;
  host: string;
  port: number;
  shellPort: number;
  status: 'running';
}

/** Resolve the same owner-bound, primary-only registration for HTTP and WS. */
export async function resolveRegisteredRuntimeEndpoint(
  db: PlatformDB,
  instance: string,
  identity: AppDomainIdentity,
  requestedHandle: string | null | undefined,
  requestedSlot: string,
): Promise<RegisteredRuntimeEndpoint | null> {
  if (identity.source !== 'auth' || !DevstackClerkUserIdSchema.safeParse(identity.userId).success
    || requestedSlot !== 'primary' || (identity.runtimeSlot && identity.runtimeSlot !== 'primary')
    || (requestedHandle && identity.handle && requestedHandle !== identity.handle)) {
    return null;
  }
  const handle = requestedHandle || identity.handle;
  if (!HANDLE_PATTERN.test(handle) || handle.includes('\n')) return null;

  await db.ready;
  const record = await db.executor.selectFrom('containers')
    .innerJoin('users', join => join
      .onRef('users.clerk_id', '=', 'containers.clerk_user_id')
      .onRef('users.handle', '=', 'containers.handle'))
    .select(['containers.container_id', 'containers.port', 'containers.shell_port'])
    .where('containers.handle', '=', handle)
    .where('containers.clerk_user_id', '=', identity.userId)
    .where('containers.status', '=', 'running')
    .where('users.status', '=', 'active')
    .where('users.container_id', '=', devstackOwnerMarker(instance, identity.userId))
    .executeTakeFirst();
  if (!record || !record.container_id || !DevstackContainerIdSchema.safeParse(record.container_id).success
    || !DevstackPortSchema.safeParse(record.port).success || !DevstackPortSchema.safeParse(record.shell_port).success) {
    return null;
  }
  return {
    source: 'record',
    handle,
    clerkUserId: identity.userId,
    containerId: record.container_id,
    host: `matrixos-${handle}`,
    port: record.port,
    shellPort: record.shell_port,
    status: 'running',
  };
}
