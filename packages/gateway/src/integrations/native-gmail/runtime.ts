import type { Context } from 'hono';
import { createNativeGmailLaunchRoutes } from './routes.js';
import type { PlatformDb } from '../../platform-db.js';
import type { PipedreamConnectClient } from '../pipedream.js';
import { NativeGmailOAuthManager } from './oauth.js';
import { loadNativeGmailConfig } from './config.js';
import { createNativeGmailClient } from './client.js';

export function createNativeGmailRuntime(options: {
  env: NodeJS.ProcessEnv; db: PlatformDb; legacy: PipedreamConnectClient;
  resolveUserId?: (c: Context) => Promise<string | null>;
  admit?: (userId: string, persist: () => Promise<void>) => Promise<void>;
}) {
  const config = loadNativeGmailConfig(options.env);
  const enabled = options.env.GMAIL_OAUTH_ENABLED === 'true';
  const isEligible = async (userId: string): Promise<boolean> => enabled && Boolean(config?.pilotClerkIds.includes((await options.db.getUserById(userId))?.clerk_id ?? ''));
  if (!config) return { client: options.legacy, oauth: undefined, cleanup: undefined, isEligible };
  if (!options.db.nativeGmailStore) throw new Error('Gmail OAuth storage unavailable');
  const oauth = new NativeGmailOAuthManager({ ...config, store: options.db.nativeGmailStore, admit: options.admit, isEligible });
  const cleanup = { revoke: (input: { userId: string; connectionId: string }) => oauth.revoke(input) };
  // Rollback disables new consent and mailbox dispatch, while retained grants remain revocable.
  if (!enabled) return { client: options.legacy, oauth: undefined, cleanup, isEligible };
  return { oauth, cleanup, isEligible, launchRoutes: options.resolveUserId ? createNativeGmailLaunchRoutes({ oauth, resolveUserId: options.resolveUserId }) : undefined, client: createNativeGmailClient({ legacy: options.legacy, oauth }) };
}
