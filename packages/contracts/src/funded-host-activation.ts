import { z } from 'zod/v4';
export const FundedHostActivationIdentitySchema = z.object({
  handle: z.string().min(2).max(63).regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  machineId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  runtimeSlot: z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  runtimeTokenEpoch: z.number().int().min(1).max(2147483647),
}).strict();
/** The production platform origin funded AI is configured against. */
export const FUNDED_PRODUCTION_PLATFORM_ORIGIN = 'https://app.matrix-os.com';
/** Untagged production Cloud Run relay services only. */
const PRODUCTION_RELAY_PATTERN = /^https:\/\/matrix-ai-relay-production-[a-z0-9]+(?:-[a-z0-9]+)?\.a\.run\.app$/;
/**
 * Reviewed preview pair (spec 2691, ENG-520): exactly this preview relay, and
 * only together with one of these preview platform origins. Guest scripts
 * (matrix-configure-funded-ai.py, funded-host-config/*.py) carry the same list;
 * a test keeps them identical. Never widen to a pattern.
 */
export const FUNDED_PREVIEW_RELAY_ORIGIN = 'https://matrix-ai-relay-preview-jqxkjdhtkq-ey.a.run.app';
export const FUNDED_PREVIEW_PLATFORM_ORIGINS = [
  'https://preview.matrix-os.com',
  'https://metal-preview.matrix-os.com',
  'https://matrix-platform-preview-jqxkjdhtkq-ey.a.run.app',
] as const;

/** Which reviewed pair a platform and relay origin form, or null for any other (including mixed) pair. */
export function fundedOriginPairKind(platformOrigin: unknown, relayOrigin: unknown): 'production' | 'preview' | null {
  if (typeof platformOrigin !== 'string' || typeof relayOrigin !== 'string' || relayOrigin.length > 256) return null;
  if (platformOrigin === FUNDED_PRODUCTION_PLATFORM_ORIGIN && PRODUCTION_RELAY_PATTERN.test(relayOrigin)) return 'production';
  if ((FUNDED_PREVIEW_PLATFORM_ORIGINS as readonly string[]).includes(platformOrigin)
    && relayOrigin === FUNDED_PREVIEW_RELAY_ORIGIN) return 'preview';
  return null;
}

/**
 * Whether a configuration's platform origin is the guest's own platform. A
 * guest whose PLATFORM_INTERNAL_URL is a reviewed preview platform accepts only
 * that exact origin (the preview pair). Every other guest (production hosts on
 * app/api.matrix-os.com, and collaboration preview pairs on tagged preview API
 * revisions, which are production-funded) accepts only the production origin.
 * So a preview proof can never repoint a production guest, nor the reverse.
 */
export function fundedPlatformOriginMatchesGuest(platformOrigin: unknown, platformInternalUrl: unknown): boolean {
  if (typeof platformOrigin !== 'string' || typeof platformInternalUrl !== 'string') return false;
  let internal: string;
  try {
    internal = new URL(platformInternalUrl).origin;
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if ((FUNDED_PREVIEW_PLATFORM_ORIGINS as readonly string[]).includes(internal)) return platformOrigin === internal;
  return platformOrigin === FUNDED_PRODUCTION_PLATFORM_ORIGIN;
}

const fields = {
  contractVersion: z.literal(1),
  identity: FundedHostActivationIdentitySchema,
  configuration: z.object({
    enabled: z.literal(true),
    platformOrigin: z.string().max(256),
    relayOrigin: z.string().max(256),
    runtimeToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().refine(value => fundedOriginPairKind(value.platformOrigin, value.relayOrigin) !== null, {
    message: 'Unreviewed funded AI origin pair',
  }),
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
