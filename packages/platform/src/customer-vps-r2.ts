import { z } from 'zod/v4';
import type { UserMachineRecord } from './db.js';
import { ClerkUserIdSchema } from './customer-vps-schema.js';

export const VpsMetaSchema = z.object({
  version: z.literal(1),
  userId: ClerkUserIdSchema,
  machineId: z.uuid(),
  hetznerServerId: z.number().int().positive(),
  imageVersion: z.string().min(1).max(128),
  status: z.literal('running'),
  provisionedAt: z.string().datetime(),
  lastSyncAt: z.string().datetime(),
  publicIPv4: z.ipv4(),
  publicIPv6: z.ipv6().optional(),
});

export type VpsMeta = z.infer<typeof VpsMetaSchema>;

export interface CustomerVpsSystemStore {
  writeVpsMeta(meta: VpsMeta): Promise<void>;
  hasDbLatest(clerkUserId: string): Promise<boolean>;
}

export interface CustomerVpsObjectStore {
  putObject(key: string, body: string | Uint8Array | ReadableStream<Uint8Array>): Promise<{ etag?: string }>;
  getObject(key: string): Promise<{ body: ReadableStream | null; etag?: string; contentLength?: number }>;
}

export function buildVpsMeta(machine: UserMachineRecord, nowIso: string): VpsMeta {
  const meta = {
    version: 1,
    userId: machine.clerkUserId,
    machineId: machine.machineId,
    hetznerServerId: machine.hetznerServerId,
    imageVersion: machine.imageVersion,
    status: 'running',
    provisionedAt: machine.provisionedAt,
    lastSyncAt: nowIso,
    publicIPv4: machine.publicIPv4,
    publicIPv6: machine.publicIPv6 ?? undefined,
  };
  return VpsMetaSchema.parse(meta);
}

export function validateDbLatestPointer(value: string): boolean {
  return /^system\/db\/snapshots\/\d{4}-\d{2}-\d{2}T\d{4}Z\.sql\.gz$/.test(value) &&
    !value.includes('..') &&
    !value.includes(':') &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function isSafeRelativeSystemKey(value: string): boolean {
  return value.startsWith('system/') &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('://') &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404;
}

export function buildCustomerVpsR2Key(
  r2PrefixRoot: string,
  clerkUserId: string,
  relativeKey: string,
): string {
  const userId = ClerkUserIdSchema.parse(clerkUserId);
  if (!isSafeRelativeSystemKey(relativeKey)) {
    throw new Error('Invalid customer VPS system key');
  }
  const root = r2PrefixRoot.replace(/^\/+|\/+$/g, '');
  if (!root || root.includes('..') || root.includes('://') || /[\x00-\x1f\x7f]/.test(root)) {
    throw new Error('Invalid customer VPS R2 prefix');
  }
  return `${root}/${userId}/${relativeKey}`;
}

export function createCustomerVpsSystemStore(options: {
  r2: CustomerVpsObjectStore;
  r2PrefixRoot: string;
}): CustomerVpsSystemStore {
  return {
    async writeVpsMeta(meta) {
      const parsed = VpsMetaSchema.parse(meta);
      await options.r2.putObject(
        buildCustomerVpsR2Key(options.r2PrefixRoot, parsed.userId, 'system/vps-meta.json'),
        `${JSON.stringify(parsed, null, 2)}\n`,
      );
    },

    async hasDbLatest(clerkUserId) {
      try {
        await options.r2.getObject(buildCustomerVpsR2Key(options.r2PrefixRoot, clerkUserId, 'system/db/latest'));
        return true;
      } catch (err: unknown) {
        if (isNotFoundError(err)) return false;
        throw err;
      }
    },
  };
}

export function createNoopCustomerVpsSystemStore(): CustomerVpsSystemStore {
  return {
    async writeVpsMeta() {
      return;
    },
    async hasDbLatest() {
      return false;
    },
  };
}
