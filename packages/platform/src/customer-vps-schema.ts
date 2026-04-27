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

export const ProvisionRequestSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  handle: SafeHandleSchema,
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
  allowEmpty: z.boolean().optional().default(false),
});

export const MachineIdParamSchema = z.object({
  machineId: z.uuid(),
});

export type ProvisionRequest = z.infer<typeof ProvisionRequestSchema>;
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RecoverRequest = z.infer<typeof RecoverRequestSchema>;
