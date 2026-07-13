import { z } from 'zod/v4';
import { DeveloperToolsSchema } from './developer-tools.js';

export const CustomerVpsStatusSchema = z.enum([
  'provisioning',
  'running',
  'failed',
  'recovering',
  'resizing',
  'deleted',
]);

export type CustomerVpsStatus = z.infer<typeof CustomerVpsStatusSchema>;

export const SafeHandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const ClerkUserIdSchema = z.string().min(3).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const PublicIPv4Schema = z.ipv4().refine((ip) => {
  const parts = ip.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}, 'publicIPv4 must be a public IPv4 address');
export const RuntimeSlotSchema = z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const HetznerServerTypeSchema = z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);

export const ProvisionRequestSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  handle: SafeHandleSchema,
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  serverType: HetznerServerTypeSchema.optional(),
  developerTools: DeveloperToolsSchema.optional(),
});

export const PREVIEW_RUNTIME_SLOT_PATTERN = /^pr-[1-9][0-9]{0,9}$/;
export const PreviewRuntimeSlotSchema = z.string().regex(PREVIEW_RUNTIME_SLOT_PATTERN);

export const PreviewProvisionRequestSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  handle: PreviewRuntimeSlotSchema,
  runtimeSlot: PreviewRuntimeSlotSchema,
  developerTools: DeveloperToolsSchema.optional(),
}).strict().refine((request) => request.handle === request.runtimeSlot, {
  message: 'Preview handle and runtime slot must match',
});

export const RegisterRequestSchema = z.object({
  machineId: z.uuid(),
  hetznerServerId: z.number().int().positive(),
  publicIPv4: PublicIPv4Schema,
  publicIPv6: z.ipv6().optional(),
  imageVersion: z.string().min(1).max(128),
});

export const RecoverRequestSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  allowEmpty: z.boolean().optional().default(false),
});

export const ResizeMachineRequestSchema = z.object({
  serverType: HetznerServerTypeSchema,
});

export const MachineIdParamSchema = z.object({
  machineId: z.uuid(),
});

export const DeployRequestSchema = z.object({
  version: z.string().min(1).max(128).optional(),
  channel: z.enum(['stable', 'canary', 'beta', 'dev']).optional(),
  handle: SafeHandleSchema.optional(),
}).refine((value) => !(value.version && value.channel), {
  message: 'Specify either version or channel',
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;
export type PreviewProvisionRequest = z.infer<typeof PreviewProvisionRequestSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;
export type ResizeMachineRequest = z.infer<typeof ResizeMachineRequestSchema>;
export type DeployRequest = z.infer<typeof DeployRequestSchema>;
