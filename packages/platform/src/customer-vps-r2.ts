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
