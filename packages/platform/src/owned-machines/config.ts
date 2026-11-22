import { z } from 'zod/v4';

const HOST_SUFFIX = /^(?=.{4,200}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CF_ID = /^[0-9a-f]{32}$/;

export interface OwnedMachinesConfig {
  cloudflare: {
    apiBase: string;
    accountId: string;
    zoneId: string;
    apiToken: string;
  };
  hostSuffix: string;
  ingressService: string;
  access: { clientId: string; clientSecret: string };
  publicUrl: string;
  platformInternalUrl: string;
  platformSecret: string;
  updateChannel: string;
  fundedAiEnabled: boolean;
  fundedAiRelayUrl: string;
  platformSpeechEnabled: boolean;
}

const EnvSchema = z.object({
  MATRIX_OWNED_MACHINES_ENABLED: z.literal('true'),
  MATRIX_OWNED_CF_ACCOUNT_ID: z.string().regex(CF_ID),
  MATRIX_OWNED_CF_ZONE_ID: z.string().regex(CF_ID),
  MATRIX_OWNED_CF_API_TOKEN: z.string().min(20).max(256).regex(/^[A-Za-z0-9_-]+$/),
  MATRIX_OWNED_CF_API_BASE: z.url().optional(),
  MATRIX_OWNED_HOST_SUFFIX: z.string().toLowerCase().regex(HOST_SUFFIX),
  MATRIX_OWNED_INGRESS_SERVICE: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/).optional(),
  MATRIX_OWNED_ACCESS_CLIENT_ID: z.string().min(8).max(256).regex(/^[A-Za-z0-9._-]+$/),
  MATRIX_OWNED_ACCESS_CLIENT_SECRET: z.string().min(16).max(256).regex(/^[A-Za-z0-9._-]+$/),
  MATRIX_OWNED_UPDATE_CHANNEL: z.enum(['dev', 'canary', 'beta', 'stable']).optional(),
});

export type OwnedMachinesConfigResult =
  | { status: 'disabled' }
  | { status: 'misconfigured'; missing: string[] }
  | { status: 'ready'; config: OwnedMachinesConfig };

/** Read once at startup. A partial configuration is a 503-class state, never "no machine". */
export function loadOwnedMachinesConfig(env: NodeJS.ProcessEnv, base: {
  publicUrl: string;
  platformInternalUrl: string;
  platformSecret: string;
  fundedAiEnabled: boolean;
  fundedAiRelayUrl: string;
  platformSpeechEnabled: boolean;
}): OwnedMachinesConfigResult {
  if (env.MATRIX_OWNED_MACHINES_ENABLED !== 'true') return { status: 'disabled' };
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success || !base.platformSecret) {
    const missing = parsed.success ? ['PLATFORM_SECRET'] : [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    return { status: 'misconfigured', missing };
  }
  const e = parsed.data;
  return {
    status: 'ready',
    config: {
      cloudflare: {
        apiBase: (e.MATRIX_OWNED_CF_API_BASE ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, ''),
        accountId: e.MATRIX_OWNED_CF_ACCOUNT_ID,
        zoneId: e.MATRIX_OWNED_CF_ZONE_ID,
        apiToken: e.MATRIX_OWNED_CF_API_TOKEN,
      },
      hostSuffix: e.MATRIX_OWNED_HOST_SUFFIX,
      ingressService: e.MATRIX_OWNED_INGRESS_SERVICE ?? 'http://127.0.0.1:8790',
      access: { clientId: e.MATRIX_OWNED_ACCESS_CLIENT_ID, clientSecret: e.MATRIX_OWNED_ACCESS_CLIENT_SECRET },
      publicUrl: base.publicUrl.replace(/\/$/, ''),
      platformInternalUrl: base.platformInternalUrl.replace(/\/$/, ''),
      platformSecret: base.platformSecret,
      updateChannel: e.MATRIX_OWNED_UPDATE_CHANNEL ?? 'stable',
      fundedAiEnabled: base.fundedAiEnabled,
      fundedAiRelayUrl: base.fundedAiRelayUrl,
      platformSpeechEnabled: base.platformSpeechEnabled,
    },
  };
}
