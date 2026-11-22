import { X509Certificate } from 'node:crypto';
import { z } from 'zod/v4';

/**
 * Platform config for the metal substrate (spec 2691, ENG-520). Metal is
 * registered only when it is enabled and every required value is valid;
 * anything less fails closed, so metal runtimes resolve as unavailable.
 * Token values are never logged.
 */

export type MetalSubstrateConfig =
  | { enabled: false; reason: 'disabled' | 'incomplete' }
  | {
    enabled: true; apiToken: string; ingressToken: string; goldenVersion: string; caPem?: string;
    /** Thin-pool usage above which placement skips a host (defaults in the provisioner: 85 / 80). */
    poolMaxDataPercent?: number; poolMaxMetadataPercent?: number;
  };

const MAX_PEM_BYTES = 64 * 1024;
const TokenSchema = z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/);
/** The golden disk version hostd clones new VMs from; matches hostd's create contract. */
const GoldenVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

function isCertificatePem(pem: string): boolean {
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) return false;
  try {
    new X509Certificate(pem);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) return false;
    throw error;
  }
}

const CaPemSchema = z.string().max(MAX_PEM_BYTES)
  .transform((value) => value.replace(/\\n/g, '\n'))
  .refine(isCertificatePem, 'invalid certificate');

const PercentEnvSchema = z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100));

const MetalEnvSchema = z.object({
  METAL_HOSTD_API_TOKEN: TokenSchema,
  METAL_HOSTD_INGRESS_TOKEN: TokenSchema,
  METAL_HOSTD_CA_PEM: CaPemSchema.optional(),
  METAL_GOLDEN_VERSION: GoldenVersionSchema,
  METAL_POOL_MAX_DATA_PERCENT: PercentEnvSchema.optional(),
  METAL_POOL_MAX_METADATA_PERCENT: PercentEnvSchema.optional(),
});

export function loadMetalSubstrateConfig(env: NodeJS.ProcessEnv): MetalSubstrateConfig {
  const flag = env.METAL_HOSTS_ENABLED?.trim().toLowerCase();
  if (flag !== '1' && flag !== 'true') return { enabled: false, reason: 'disabled' };

  const caPem = env.METAL_HOSTD_CA_PEM?.trim();
  const parsed = MetalEnvSchema.safeParse({
    METAL_HOSTD_API_TOKEN: env.METAL_HOSTD_API_TOKEN,
    METAL_HOSTD_INGRESS_TOKEN: env.METAL_HOSTD_INGRESS_TOKEN,
    METAL_HOSTD_CA_PEM: caPem ? caPem : undefined,
    METAL_GOLDEN_VERSION: env.METAL_GOLDEN_VERSION?.trim(),
    METAL_POOL_MAX_DATA_PERCENT: env.METAL_POOL_MAX_DATA_PERCENT?.trim() || undefined,
    METAL_POOL_MAX_METADATA_PERCENT: env.METAL_POOL_MAX_METADATA_PERCENT?.trim() || undefined,
  });
  if (!parsed.success) {
    // Names only: issue messages could echo values.
    const invalid = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    console.error('[metal-substrate] metal hosts enabled but config is invalid; metal stays unavailable:', invalid.join(','));
    return { enabled: false, reason: 'incomplete' };
  }
  const {
    METAL_HOSTD_API_TOKEN: apiToken,
    METAL_HOSTD_INGRESS_TOKEN: ingressToken,
    METAL_HOSTD_CA_PEM: pem,
    METAL_GOLDEN_VERSION: goldenVersion,
    METAL_POOL_MAX_DATA_PERCENT: poolMaxDataPercent,
    METAL_POOL_MAX_METADATA_PERCENT: poolMaxMetadataPercent,
  } = parsed.data;
  return {
    enabled: true, apiToken, ingressToken, goldenVersion,
    ...(pem ? { caPem: pem } : {}),
    ...(poolMaxDataPercent !== undefined ? { poolMaxDataPercent } : {}),
    ...(poolMaxMetadataPercent !== undefined ? { poolMaxMetadataPercent } : {}),
  };
}
