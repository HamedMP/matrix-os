import {
  buildPlatformContainerRuntimeToken,
  buildPlatformSyncVerificationToken,
  buildPlatformVerificationToken,
} from '../platform-token.js';
import type { ContainerBootContext } from './container-lifecycle-service.js';

/** Lambda MicroVMs caps `runHookPayload` at 16 KB. */
export const CONTAINER_BOOT_PAYLOAD_MAX_BYTES = 16 * 1024;

export interface ContainerBootPayload {
  version: 2;
  machineId: string;
  clerkUserId: string;
  handle: string;
  runtimeSlot: string;
  generation: number;
  runtimeTokenEpoch: number;
  platform: { url: string; runtimeToken: string };
  gateway: { authToken: string };
  sync: { runtimeToken: string };
  database: { host: string; port: number; name: string; user: string; password: string };
  recovery?: { lastFlushDigest: string | null; lastFlushedAt: string | null };
}

export interface ContainerBootPayloadInput {
  context: ContainerBootContext;
  platform: { url: string; secret: string };
  database: ContainerBootPayload['database'];
}

/**
 * Everything the runtime needs to authenticate: lifecycle and sync tokens are
 * bound to the token epoch, and the gateway token is the handle token the
 * platform proxy signs owner proofs with.
 */
export function buildContainerBootPayload(input: ContainerBootPayloadInput): string {
  const { context, platform, database } = input;
  const identity = { handle: context.handle, machineId: context.machineId, runtimeSlot: context.runtimeSlot };
  const payload: ContainerBootPayload = {
    version: 2,
    machineId: context.machineId,
    clerkUserId: context.clerkUserId,
    handle: context.handle,
    runtimeSlot: context.runtimeSlot,
    generation: context.generation,
    runtimeTokenEpoch: context.runtimeTokenEpoch,
    platform: {
      url: platform.url,
      runtimeToken: buildPlatformContainerRuntimeToken(identity, platform.secret, context.runtimeTokenEpoch),
    },
    gateway: { authToken: buildPlatformVerificationToken(context.handle, platform.secret) },
    sync: { runtimeToken: buildPlatformSyncVerificationToken(identity, platform.secret, context.runtimeTokenEpoch) },
    database: {
      host: database.host, port: database.port, name: database.name, user: database.user, password: database.password,
    },
    ...(context.recovery ? {
      recovery: { lastFlushDigest: context.recovery.lastFlushDigest, lastFlushedAt: context.recovery.lastFlushedAt },
    } : {}),
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > CONTAINER_BOOT_PAYLOAD_MAX_BYTES) {
    throw new Error('Container boot payload too large');
  }
  return serialized;
}
