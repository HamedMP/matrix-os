import { z } from 'zod/v4';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import type { PlatformDB } from './db.js';

const callbackPath = '/api/integrations/outlook/oauth/callback';
const authorizePath = '/api/integrations/outlook/oauth/authorize';
const statePattern = /^[A-Za-z0-9_-]{43}$/;

export function isOutlookOAuthCallback(method: string, path: string): boolean {
  return method === 'POST' && path === callbackPath;
}

export function outlookOAuthSignInReturn(method: string, requestUrl: string): string | null {
  const url = new URL(requestUrl);
  if (method !== 'GET' || url.pathname !== authorizePath) return null;
  const state = url.searchParams.get('state');
  return state && statePattern.test(state) && url.searchParams.getAll('state').length === 1
    ? `${authorizePath}?state=${state}` : null;
}

const configuration = z.object({
  clientId: z.uuid(),
  clientSecret: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/),
  encryptionKey: z.string().min(43).max(64),
  redirectUri: z.url().refine(raw => {
    const uri = new URL(raw);
    return uri.protocol === 'https:' && uri.pathname === callbackPath
      && !uri.username && !uri.password && !uri.search && !uri.hash;
  }),
  legacyRetired: z.boolean(),
});

export function resolveOutlookIntegrationConfig(env: NodeJS.ProcessEnv) {
  if (env.MATRIX_OUTLOOK_ENABLED !== 'true') return undefined;
  const parsed = configuration.safeParse({
    clientId: env.MATRIX_OUTLOOK_CLIENT_ID,
    clientSecret: env.MATRIX_OUTLOOK_CLIENT_SECRET,
    encryptionKey: env.MATRIX_OUTLOOK_CREDENTIAL_KEY,
    redirectUri: env.MATRIX_OUTLOOK_REDIRECT_URI ?? `https://app.matrix-os.com${callbackPath}`,
    legacyRetired: env.MATRIX_OUTLOOK_LEGACY_RETIRED === 'true',
  });
  if (!parsed.success || [env.MCP_CREDENTIAL_ENCRYPTION_KEY, env.PLATFORM_SECRET, env.PLATFORM_JWT_SECRET,
    env.PIPEDREAM_CLIENT_SECRET, parsed.success ? parsed.data.clientSecret : undefined]
    .some(value => value && value === env.MATRIX_OUTLOOK_CREDENTIAL_KEY)) {
    throw new Error('Outlook integration configuration unavailable');
  }
  return parsed.data;
}

export type PlatformOutlookRuntime = {
  graph: unknown;
  legacyRetired: boolean;
  close(): Promise<void>;
};

type OutlookIntegrationConfig = NonNullable<ReturnType<typeof resolveOutlookIntegrationConfig>>;
export interface GatewayOutlookRuntimeModule {
  createOutlookRuntime(options: OutlookIntegrationConfig & {
    db: unknown;
    pipedream?: unknown;
    maintenance: boolean;
    admit: <T>(userId: string, work: () => Promise<T>) => Promise<T>;
  }): Promise<PlatformOutlookRuntime>;
}

export function outlookCallbackAdmission(options: {
  db: PlatformDB;
  users: { getUserById(id: string): Promise<{ clerk_id: string } | null> };
  env: NodeJS.ProcessEnv;
}) {
  return async <T>(userId: string, work: () => Promise<T>): Promise<T> => {
    const user = await options.users.getUserById(userId);
    if (!user) throw new Error('Integration owner unavailable');
    return withAccountDeletionOwnerLock(options.db, user.clerk_id, async (_trx, admission) => {
      if (!admission.newWorkAllowed) throw new Error('Integration owner unavailable');
      return work();
    }, options.env);
  };
}
