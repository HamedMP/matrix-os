import type { PlatformDB } from '../db.js';
import { getRunningUserMachineByClerkId } from '../db.js';
import type { ClerkAuth } from '../clerk-auth.js';
import { issueSyncJwt } from '../sync-jwt.js';
import { getRuntimeEntitlementDecisionForUser } from '../runtime-entitlement.js';
import { readWhatsAppConfig } from './config.js';
import { createWhatsAppRepository } from './repository.js';
import { createWhatsAppAgentClient } from './agent-client.js';
import { createWhatsAppService } from './service.js';
import { createWhatsAppRoutes } from './routes.js';

/** Compose once at process startup. Request replicas enqueue; the designated
 * platform background worker drains the shared durable queue. */
export function createConfiguredWhatsAppRuntime(deps: {
  db: PlatformDB; env: NodeJS.ProcessEnv; clerkAuth?: ClerkAuth;
}) {
  const config = readWhatsAppConfig(deps.env);
  if (!config) return undefined;
  const secret = deps.env.PLATFORM_JWT_SECRET ?? '';
  const publishableKey = deps.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? deps.env.CLERK_PUBLISHABLE_KEY ?? '';
  if (!deps.clerkAuth || secret.length < 32 || !publishableKey) throw new Error('WhatsApp authentication is unavailable');
  const clerkAuth = deps.clerkAuth;
  const repository = createWhatsAppRepository(deps.db, config.encryptionKey);
  const agent = createWhatsAppAgentClient(async (owner) => {
    const machine = await getRunningUserMachineByClerkId(deps.db, owner, 'primary');
    if (!machine || machine.clerkUserId !== owner || machine.provisioningClass !== 'customer') return null;
    const entitlement = await getRuntimeEntitlementDecisionForUser(deps.db, owner, deps.env, machine.runtimeSlot, machine.provisioningClass);
    if (!entitlement.runtimeProxyAllowed) return null;
    // The public platform proxy resolves the fresh owner+primary-slot JWT using
    // authoritative machine data. Avoid user-controlled URLs and private-IP TLS bypass.
    const jwt = await issueSyncJwt({ secret, clerkUserId: owner, handle: machine.handle,
      gatewayUrl: config.publicUrl, runtimeSlot: 'primary', expiresInSec: 60 });
    return { machineId: machine.machineId, gatewayUrl: config.publicUrl, token: jwt.token };
  });
  const service = createWhatsAppService({ config, repository, agent });
  const routes = createWhatsAppRoutes({ config, repository, service, publishableKey,
    authenticate: async (bearer) => {
      const verified = await clerkAuth.verify(bearer);
      return verified.authenticated && verified.userId ? verified.userId : null;
    },
  });
  return { routes, start: service.start, shutdown: service.shutdown };
}
