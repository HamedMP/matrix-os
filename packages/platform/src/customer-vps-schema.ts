import { z } from 'zod/v4';

export const CustomerVpsStatusSchema = z.enum([
  'provisioning',
  'running',
  'failed',
  'recovering',
  'deleted',
]);

export type CustomerVpsStatus = z.infer<typeof CustomerVpsStatusSchema>;

export const SafeHandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const ClerkUserIdSchema = z.string().min(3).max(256).regex(/^[A-Za-z0-9_-]+$/);

export const ProvisionRequestSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  handle: SafeHandleSchema,
});

export const RegisterRequestSchema = z.object({
  machineId: z.uuid(),
  hetznerServerId: z.number().int().positive(),
  publicIPv4: z.ipv4(),
  publicIPv6: z.ipv6().optional(),
  imageVersion: z.string().min(1).max(128),
});

export const RecoverRequestSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  allowEmpty: z.boolean().optional().default(false),
});

export const MachineIdParamSchema = z.object({
  machineId: z.uuid(),
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;
