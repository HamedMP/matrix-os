import type { Context, Hono } from 'hono';
import type { PlatformDB } from './db.js';
import type { AccountDeletionAdapterOptions } from './account-deletion/adapters.js';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
type LegacyClient = NonNullable<AccountDeletionAdapterOptions['pipedream']>;
/** The factory transfers ownership; injected transaction/store wrappers never call this helper. */
export async function initializeOwnedIntegrationDb<T extends { migrate(): Promise<void>; destroy(): Promise<void> }>(options: {
  create(): T; registerClose(close: () => Promise<void>): void;
}): Promise<T> {
  const db = options.create();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= db.destroy();
  options.registerClose(close);
  try { await db.migrate(); return db; }
  catch (error) {
    try { await close(); } catch (cleanupError) { console.error('[platform] Integration database cleanup failed:', cleanupError); }
    throw error;
  }
}
export interface PlatformGmailRuntime {
  client: LegacyClient;
  isEligible?: (userId: string) => Promise<boolean>;
  launchRoutes?: Hono;
  cleanup?: { revoke(input: { userId: string; connectionId: string }): Promise<boolean> };
  oauth?: { revoke(input: { userId: string; connectionId: string }): Promise<boolean> };
}
interface RuntimeModule {
  createNativeGmailRuntime(options: { env: NodeJS.ProcessEnv; db: unknown; legacy: LegacyClient;
    resolveUserId?: (c: Context) => Promise<string | null>;
    admit(userId: string, persist: () => Promise<void>): Promise<void> }): PlatformGmailRuntime;
}

/** Retained configuration keeps grant cleanup available during feature-off rollback. */
export function requiresPlatformGmailRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.GMAIL_OAUTH_ENABLED === 'true' || [env.GMAIL_OAUTH_CLIENT_ID, env.GMAIL_OAUTH_CLIENT_SECRET,
    env.GMAIL_OAUTH_CALLBACK_URL, env.GMAIL_CREDENTIAL_ENCRYPTION_KEY].some(value => Boolean(value?.trim()));
}

/** Keep gateway OAuth/transport composition out of the large platform entrypoint. */
export async function createConfiguredPlatformGmail(options: {
  db: PlatformDB;
  integrationDb: { getUserById(userId: string): Promise<{ clerk_id: string } | null> };
  legacy: LegacyClient; env: NodeJS.ProcessEnv;
  resolveUserId?: (c: Context) => Promise<string | null>;
  loadModule?: () => Promise<RuntimeModule>;
}): Promise<PlatformGmailRuntime> {
  if (!requiresPlatformGmailRuntime(options.env)) return { client: options.legacy, isEligible: async () => false };
  const module: RuntimeModule = await (options.loadModule ?? (() => import(new URL('../../gateway/dist/integrations/native-gmail/runtime.js', import.meta.url).href)))();
  return module.createNativeGmailRuntime({ db: options.integrationDb, legacy: options.legacy, env: options.env, resolveUserId: options.resolveUserId,
    admit: async (userId, persist) => {
      const user = await options.integrationDb.getUserById(userId);
      if (!user) throw new Error('Connection owner unavailable');
      await withAccountDeletionOwnerLock(options.db, user.clerk_id, async (_trx, admission) => {
        if (!admission.newWorkAllowed) throw new Error('Connection unavailable');
        await persist();
      }, options.env);
    } });
}
