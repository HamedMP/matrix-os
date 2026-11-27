import { createAccountDeletionMutationGuard } from './account-deletion/integration-admission.js';
import { GMAIL_HOSTED_REVOCATION_PROOF_HEADER, gmailConsentRevocationAccount, type GmailHostedRevocationReceipt } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { verifyGmailOwnerApprovalProof } from './custom-mcp-approval-proof.js';
import { verifyGmailHostedRevocationProof } from './gmail-hosted-revocation-proof.js';
import type { ClerkAuth } from './clerk-auth.js';
import { APP_SESSION_COOKIE, readCookie } from './session-cookies.js';
import { isUserSessionProvenance, verifySyncJwt } from './sync-jwt.js';
import { canClerkUserAccessMachine, getPersonalAccountRestrictedMachineByHandle } from './customer-vps-preview.js';
import { getContainer, getRunningUserMachineByHandle, type PlatformDB } from './db.js';
import { createInternalIntegrationGuard } from './internal-integration-guard.js';
import { createIntegrationChatApprovalRoutes } from './integration-chat-approval.js';
import type { PrivatePreviewEligibility } from './private-preview-eligibility.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';
import { z } from 'zod/v4';
import { buildPlatformUserProof } from './session-routing-websocket.js';
import { createUnavailableInternalIntegrationRoutes } from './integration-route-fallback.js';

/**
 * Machine-bearer routes a VPS gateway uses to reach its owner's platform-owned
 * Integrations. Moved verbatim from main.ts; the guard resolves which personal
 * account a request may act for.
 */
const HandleSchema = z.string().regex(HANDLE_PATTERN);

type GmailOwnerSession = { handle: string; ownerId: string; authorization?: string; cookie?: string };

export function createGmailOwnerSessionVerifier(clerkAuth: ClerkAuth | undefined, jwtSecret: string | undefined) {
  return async ({ handle, ownerId, authorization, cookie }: GmailOwnerSession): Promise<boolean> => {
    const clerkToken = clerkAuth?.extractToken(authorization, cookie);
    if (clerkToken && (await clerkAuth!.verifyAndMatchOwner(clerkToken, ownerId)).authenticated) return true;
    const syncToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : readCookie(cookie, APP_SESSION_COOKIE);
    if (!jwtSecret || !syncToken) return false;
    try {
      const claims = await verifySyncJwt(syncToken, { secret: jwtSecret, expectedHandle: handle, clockTolerance: 0 });
      return claims.sub === ownerId && isUserSessionProvenance(claims.session_provenance);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      return false;
    }
  };
}

export function registerInternalIntegrationRoutes(app: Hono<any>, options: {
  db: PlatformDB;
  platformSecret: string;
  internalIntegrationRoutes?: Hono<any>;
  verifyGmailOwnerSession?(input: GmailOwnerSession): Promise<boolean>;
  /** Spec 537 P5; without it every Private Preview stays denied. */
  privatePreviewEligibility?: PrivatePreviewEligibility;
}): void {
  const { db, platformSecret } = options;
  const internalIntegrationApp = new Hono<{
    Variables: {
      internalContainerHandle: string;
      internalContainerClerkUserId: string;
      internalSignedOwnerDelegation: boolean;
      internalContainerMachineId: string;
      internalContainerPersonalOwner: string;
      gmailHostedRevocationReceipt?: GmailHostedRevocationReceipt;
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
        c.res = c.json({ error: 'Forbidden', code: 'preview_integrations_unavailable' }, 403);
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
      c.set('internalContainerMachineId',machine?.machineId ?? `legacy:${handle}`);
      c.set('internalContainerPersonalOwner',record.clerkUserId);
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
  internalIntegrationApp.use('*', createAccountDeletionMutationGuard({ db,
    resolveOwner: (c) => c.get('internalContainerClerkUserId') as string | undefined,
    isCleanup: c => c.get('internalSignedOwnerDelegation') === true && c.req.method === 'POST'
      && /^\/internal\/containers\/[^/]+\/integrations\/gmail\/processing\/(?:purge-commands|purge-ack)$/.test(c.req.path),
  }));
  const consentLimit = bodyLimit({ maxSize: 4096 });
  internalIntegrationApp.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    let path: string;
    try { path = decodeURIComponent(c.req.path); }
    catch (error: unknown) {
      if (!(error instanceof URIError)) throw error;
      return c.json({ error: 'Invalid request' }, 400);
    }
    if (!/\/gmail\/+processing-consents(?:[/?#]|$)/i.test(path)) return next();
    const handle = c.get('internalContainerHandle');
    const ownerId = c.get('internalContainerClerkUserId');
    if (!handle || !ownerId || c.get('internalContainerPersonalOwner') !== ownerId)
      return c.json({ error: 'Forbidden' }, 403);
    return consentLimit(c, async () => {
      c.header('Cache-Control', 'no-store');
      const proof = c.req.header(GMAIL_HOSTED_REVOCATION_PROOF_HEADER);
      if (proof) {
        const accountId = gmailConsentRevocationAccount(c.req.method, c.req.path, `/internal/containers/${handle}/integrations`);
        const receipt = accountId && !new URL(c.req.url).search && c.get('internalSignedOwnerDelegation') === true
          ? verifyGmailHostedRevocationProof(proof, { handle, ownerId, accountId }, platformSecret) : null;
        if (!receipt) {
          c.res = c.json({ error: 'Forbidden' }, 403);
          return;
        }
        c.set('gmailHostedRevocationReceipt', receipt);
        await next();
        return;
      }
      const session = await options.verifyGmailOwnerSession?.({ handle, ownerId,
        authorization: c.req.header('x-matrix-google-owner-authorization'), cookie: c.req.header('cookie') });
      if (session || (c.req.method === 'POST' && verifyGmailOwnerApprovalProof(
        c.req.header('x-matrix-custom-mcp-approval-proof'),
        { handle, actorId: ownerId, consentBody: await c.req.text(), secret: platformSecret },
      ))) await next();
      else c.res = c.json({ error: 'Forbidden' }, 403);
    });
  });
  internalIntegrationApp.route('/', createIntegrationChatApprovalRoutes(platformSecret));
  internalIntegrationApp.route('/', options.internalIntegrationRoutes ?? createUnavailableInternalIntegrationRoutes());
  app.route('/internal/containers/:handle/integrations', internalIntegrationApp);
}
