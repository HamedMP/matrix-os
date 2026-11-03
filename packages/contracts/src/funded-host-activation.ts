import { z } from 'zod/v4';
export const FundedHostActivationIdentitySchema = z.object({
  handle: z.string().min(2).max(63).regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  machineId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  runtimeSlot: z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  runtimeTokenEpoch: z.number().int().min(1).max(2147483647),
}).strict();
const fields = {
  contractVersion: z.literal(1),
  identity: FundedHostActivationIdentitySchema,
  configuration: z.object({
    enabled: z.literal(true),
    platformOrigin: z.literal('https://app.matrix-os.com'),
    relayOrigin: z.string().max(256).regex(/^https:\/\/matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app$/),
    runtimeToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
};
export const FundedHostActivationRequestSchema = z.object(fields).strict();
export const FundedHostActivationResponseSchema = z.object({
  ...fields, issuedAt: z.iso.datetime({ precision: 3 }), expiresAt: z.iso.datetime({ precision: 3 }),
}).strict().refine(value => {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  return duration > 0 && duration <= 30000;
});
export type FundedHostActivationRequest = z.infer<typeof FundedHostActivationRequestSchema>;
export type FundedHostActivationResponse = z.infer<typeof FundedHostActivationResponseSchema>;
export function fundedHostActivationRevisionInput(request: FundedHostActivationRequest): string {
  const { identity, configuration } = request;
  return [identity.machineId, identity.runtimeSlot, String(identity.runtimeTokenEpoch), configuration.platformOrigin,
    configuration.relayOrigin, configuration.runtimeToken].join('\0');
}
