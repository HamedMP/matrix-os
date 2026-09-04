import { z } from 'zod/v4';
import { ClientPolicySchema, ClientTargetSchema } from '@matrix-os/contracts';

export const BackendVersionSchema = z.string().max(128).regex(/^(?:v[0-9]|main-[A-Za-z0-9])[A-Za-z0-9._-]*$/);
export const BackendConfigSchema = z.object({
  enabled: z.boolean().default(false),
  canaryMachineIds: z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).max(10).default([]),
  batchSize: z.number().int().min(1).max(10).default(5),
  soakSeconds: z.number().int().min(60).max(3600).default(300),
  // Optional reviewed bridge target. Clear after bootstrap to follow stable.
  bootstrapVersion: BackendVersionSchema.nullable().default(null),
  clients: z.partialRecord(ClientTargetSchema, ClientPolicySchema).default({}),
}).strict();
export type BackendConfig = z.infer<typeof BackendConfigSchema>;
export const MachineOverrideSchema = z.object({
  until: z.iso.datetime(),
  reason: z.string().trim().min(1).max(240),
  allowVersionSelection: z.boolean(),
}).strict();
export type MachineOverride = z.infer<typeof MachineOverrideSchema>;
export type DeploymentStatus = 'pending' | 'offline' | 'updating' | 'soaking' | 'current' | 'blocked';

export interface BackendPolicyTable {
  id: number;
  revision: number;
  config: string;
  active_version: string | null;
  lease_token: string | null;
  lease_until: string | null;
}
export interface BackendMachineTable {
  machine_id: string;
  desired_version: string;
  observed_version: string | null;
  status: DeploymentStatus;
  attempts: number;
  next_check_at: string;
  started_at: string | null;
  healthy_since: string | null;
  last_seen_at: string | null;
  error_code: string | null;
  override_until: string | null;
  override_reason: string | null;
  allow_version_selection: boolean;
}
export interface BackendAuditTable { id: string; action: string; machine_id: string | null; detail: string; created_at: string; }
