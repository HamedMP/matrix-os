import { Hono } from 'hono';
import { canClerkUserAccessMachine, getPersonalAccountRestrictedMachineByHandle } from './customer-vps-preview.js';
import { getContainer, getRunningUserMachineByHandle, type PlatformDB } from './db.js';
import { createInternalIntegrationGuard } from './internal-integration-guard.js';
import type { PrivatePreviewEligibility } from './private-preview-eligibility.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';
import { z } from 'zod/v4';
import { buildPlatformUserProof } from './session-routing-websocket.js';

/**
 * Machine-bearer routes a VPS gateway uses to reach its owner's platform-owned
 * Integrations. Moved verbatim from main.ts; the guard resolves which personal
 * account a request may act for.
 */
const HandleSchema = z.string().regex(HANDLE_PATTERN);

export function registerInternalIntegrationRoutes(app: Hono<any>, options: {
  db: PlatformDB;
  platformSecret: string;
  internalIntegrationRoutes?: Hono<any>;
  /** Spec 537 P5; without it every Private Preview stays denied. */
  privatePreviewEligibility?: PrivatePreviewEligibility;
}): void {
  if (!options.internalIntegrationRoutes) return;
  const { db, platformSecret } = options;
  const internalIntegrationApp = new Hono<{
    Variables: {
      internalContainerHandle: string;
      internalContainerClerkUserId: string;
      internalSignedOwnerDelegation: boolean;
    };
  }>();
  const integrationGuard = createInternalIntegrationGuard();
  internalIntegrationApp.use('*', async (c, next) => {
    const parsedHandle = HandleSchema.safeParse(c.req.param('handle'));
    if (!parsedHandle.success) {
      return c.json({ error: 'Invalid handle' }, 400);
    }
    const handle = parsedHandle.data;
    if (!platformSecret) {
      return c.json({ error: 'Internal integrations not configured' }, 503);
    }
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const expected = buildPlatformVerificationToken(handle, platformSecret);
    if (!timingSafeTokenEquals(token, expected)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('internalContainerHandle', handle);
    return integrationGuard.middleware(c, async () => {
      // Preview and customer slots can share a handle, while their machine
      // bearer is derived from that handle alone. Check restricted machines
      // before an unqualified lookup can select a customer primary row.
      // A Private Preview may pass only while spec 537 P5 holds for it.
      const restricted = await getPersonalAccountRestrictedMachineByHandle(db, handle);
      if (restricted && !(await options.privatePreviewEligibility?.(restricted))) {
        c.res = c.json({ error: 'Forbidden' }, 403);
        return;
      }
      // Customer VPSes are persisted in user_machines. Keep the legacy
      // containers lookup for older runtimes that have not migrated yet.
      const machine = await getRunningUserMachineByHandle(db, handle);
      const record = machine ?? (await getContainer(db, handle));
      if (!record?.clerkUserId) {
        c.res = c.json({ error: 'Unknown handle' }, 404);
        return;
      }
      let actorId = record.clerkUserId;
      const delegatedId = c.req.header('x-platform-user-id');
      const delegatedProof = c.req.header('x-platform-verified');
      // Older single-user customer gateways forward the owner's unsigned
      // header. The machine bearer already authenticates that gateway, so
      // retain the owner scope only when the machine has no collaborators.
      // Shared and Preview machines must use signed delegation.
      const legacyOwnerHeader = delegatedId === record.clerkUserId
        && delegatedProof === undefined
        && machine?.provisioningClass === 'customer'
        && machine.accessClerkUserIds.length === 0;
      if ((delegatedId || delegatedProof) && !legacyOwnerHeader) {
        if (!delegatedId || !delegatedProof || !/^[A-Za-z0-9_-]{1,256}$/.test(delegatedId)
          || !timingSafeTokenEquals(delegatedProof, buildPlatformUserProof(handle, delegatedId, platformSecret))) {
          c.res = c.json({ error: 'Unauthorized' }, 401);
          return;
        }
        if (machine ? !canClerkUserAccessMachine(machine, delegatedId) : delegatedId !== record.clerkUserId) {
          c.res = c.json({ error: 'Forbidden' }, 403);
          return;
        }
        actorId = delegatedId;
        c.set('internalSignedOwnerDelegation', true);
      }

      c.set('internalContainerHandle', handle);
      c.set('internalContainerClerkUserId', actorId);
      await next();
    });
  });
  internalIntegrationApp.route('/', options.internalIntegrationRoutes);
  app.route('/internal/containers/:handle/integrations', internalIntegrationApp);
}
