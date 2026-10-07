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
  if (!config) return { client: options.legacy, oauth: undefined };
  if (!options.db.nativeGmailStore) throw new Error('Gmail OAuth storage unavailable');
  const oauth = new NativeGmailOAuthManager({ ...config, store: options.db.nativeGmailStore, admit: options.admit });
  return { oauth, launchRoutes: options.resolveUserId ? createNativeGmailLaunchRoutes({ oauth, resolveUserId: options.resolveUserId }) : undefined, client: createNativeGmailClient({ legacy: options.legacy, oauth }) };
}
