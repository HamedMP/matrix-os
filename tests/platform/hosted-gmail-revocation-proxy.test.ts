import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { authMiddleware } from '../../packages/gateway/src/auth.js';
import { createGoogleDataAuthority } from '../../packages/gateway/src/google-data/authority.js';
import { createGoogleDataOwnerRoutes } from '../../packages/gateway/src/google-data/owner-routes.js';
import { createGoogleDataRepository } from '../../packages/gateway/src/google-data/repository.js';
import { proxyIntegrationRequest } from '../../packages/gateway/src/integrations/platform-proxy.js';
import { registerDeferredRuntimeRoutes } from '../../packages/gateway/src/server/deferred-runtime-routes.js';
import { projectComputer } from '../../packages/platform/src/computer-routes.js';
import { getActiveUserMachineByHandle, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { accountId, consentInput, now, profileInput } from '../gateway/google-data/fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { JWT_SECRET, stubOrchestrator } from './proxy-routing-test-utils.js';

const handle = 'gmail-owner-computer';
const ownerId = 'user_gmail_owner';
const platformSecret = 'synthetic-hosted-gmail-platform-secret';
const machineToken = buildPlatformVerificationToken(handle, platformSecret);
const internalBase = `https://platform.invalid/internal/containers/${handle}/integrations`;
const revokePath = `/gmail/processing-consents/${accountId}`;
const proofHeader = 'x-matrix-gmail-revocation-proof';

let db: PlatformDB | undefined;
let closeGateway: (() => Promise<void>) | undefined;
let homePath: string | undefined;
afterEach(async () => {
  await closeGateway?.();
  if (homePath) await rm(homePath, { recursive: true, force: true });
  await destroyTestPlatformDb(db);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(['primary', 'studio'])('records and revokes owner consent through the %s Computer route', async slot => {
  for (const [key, value] of Object.entries({
    MATRIX_CLERK_USER_ID: ownerId, MATRIX_USER_ID: ownerId, MATRIX_RUNTIME_SLOT: slot,
    MATRIX_HANDLE: handle, MATRIX_AUTH_TOKEN: machineToken, PLATFORM_JWT_SECRET: JWT_SECRET,
    NODE_ENV: 'production',
  })) vi.stubEnv(key, value);
  ({ db } = await createTestPlatformDb());
  await insertUserMachine(db, {
    machineId: 'gmail-revocation-machine', clerkUserId: ownerId, handle, runtimeSlot: 'primary',
    provisioningClass: 'customer', status: 'running', hetznerServerId: 4242,
    publicIPv4: '203.0.113.20', imageVersion: 'dev', provisionedAt: '2026-11-01T00:00:00.000Z',
  });
  await insertUserMachine(db, {
    machineId: 'gmail-revocation-studio', clerkUserId: ownerId, handle, runtimeSlot: 'studio',
    provisioningClass: 'customer', status: 'running', hetznerServerId: 4243,
    publicIPv4: '203.0.113.21', imageVersion: 'dev', provisionedAt: '2026-11-01T00:00:00.000Z',
  });
  const machine = await getActiveUserMachineByHandle(db, handle, slot);
  expect(machine).toBeDefined();
  const computer = projectComputer(machine!);
  expect(computer?.runtimeSlot).toBe(slot);
  const route = new URL(computer!.gatewayPath, 'https://app.matrix-os.com');
  const repository = createGoogleDataRepository(db.kysely, { now: () => now });
  await repository.migrate();
  const profile = await repository.reviewProfile({ ...profileInput(), ownerId }, 0);
  const consent = consentInput(profile.id, { ownerId });
  await repository.recordConsent(consent, 0);
  const currentConsent = async () => (await repository.snapshot({
    ownerId, googleAccountId: accountId, purposeId: consent.purposeId, profileId: profile.id,
  })).consent;
  const platform = createApp({
    db, platformSecret, orchestrator: stubOrchestrator(),
    internalIntegrationRoutes: createGoogleDataOwnerRoutes({ now: () => now, repository, authority: createGoogleDataAuthority(repository),
      resolveOwner: async c => c.get('internalContainerClerkUserId') ?? null,
      ownsGoogleAccount: async (actor, account) => actor === ownerId && account === accountId }),
  });
  const platformHop = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => platform.request(String(url), init));
  const gateway = new Hono();
  gateway.use('*', authMiddleware(machineToken));
  homePath = await mkdtemp(join(tmpdir(), 'gmail-proxy-regression-'));
  const runtime = await registerDeferredRuntimeRoutes({
    app: gateway, homePath, ownerDatabase: null, integrationRoutes: null,
    internalIntegrationBaseUrl: internalBase, internalPlatformToken: machineToken, internalHandle: handle,
    internalPlatformUrl: 'https://platform.invalid', devAppAuthBypass: false,
    proxyIntegrationRequest: (c, targetBase, token, routePrefix) =>
      proxyIntegrationRequest(c, { targetBase, machineToken: token, routePrefix, fetcher: platformHop }),
    posthogErrorTracker: { captureEvent: vi.fn() } as never, ownerTelemetryDistinctId: 'fixture-owner',
  });
  closeGateway = async () => {
    runtime.browserLab.close();
    runtime.customMcp.stop();
    await runtime.processManager.shutdownAll();
  };
  const gatewayHop = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const upstream = new URL(String(url));
    expect(upstream.hostname).toBe(slot === 'primary' ? '203.0.113.20' : '203.0.113.21');
    expect(upstream.searchParams.has('runtime')).toBe(false);
    return gateway.request(String(url), init);
  });
  const issueSession = async (sessionProvenance?: 'clerk-browser' | 'clerk-device') => (await issueSyncJwt({
    secret: JWT_SECRET, clerkUserId: ownerId, handle, runtimeSlot: 'primary', sessionProvenance,
    gatewayUrl: `https://app.matrix-os.com/vm/${handle}`,
  })).token;
  const revoke = (headers: Record<string, string>) => platform.request(`${route.pathname}/api/integrations${revokePath}${route.search}`, {
    method: 'DELETE', headers: { host: 'app.matrix-os.com', ...headers },
  });

  const browserSession = await issueSession('clerk-browser');
  const first = await revoke({ cookie: `matrix_app_session=${browserSession}`, [proofHeader]: 'caller-supplied',
    'x-matrix-google-owner-authorization': `Bearer ${browserSession}` });
  expect(first.status).toBe(200);
  expect(await currentConsent()).toMatchObject({ status: 'revoked', revision: 2 });
  expect(first.headers.get('cache-control')).toContain('no-store');
  const gatewayHeaders = new Headers(gatewayHop.mock.calls[0]?.[1]?.headers);
  expect(gatewayHeaders.get('authorization')).toBe(`Bearer ${machineToken}`);
  expect(gatewayHeaders.get('cookie')).toBeNull();
  expect(gatewayHeaders.get('x-matrix-google-owner-authorization')).toBeNull();
  const forwardedHeaders = new Headers(platformHop.mock.calls[0]?.[1]?.headers);
  expect(forwardedHeaders.get(proofHeader)).toBeTruthy();
  expect(forwardedHeaders.get(proofHeader)).not.toBe('caller-supplied');
  expect(forwardedHeaders.get('x-matrix-google-owner-authorization')).toBeNull();

  await repository.recordConsent(consent, 2);
  const wrongAccount = await platform.request(`${internalBase}/gmail/processing-consents/123e4567-e89b-42d3-a456-426614174001`, {
    method: 'DELETE', headers: forwardedHeaders,
  });
  expect(wrongAccount.status).toBe(403);
  const replay = await platform.request(`${internalBase}${revokePath}`, { method: 'DELETE', headers: forwardedHeaders });
  expect(replay.status).toBe(409);
  const routingOnly = await revoke({ authorization: `Bearer ${await issueSession()}`, [proofHeader]: 'caller-supplied' });
  expect(routingOnly.status).toBe(403);
  expect(await currentConsent()).toMatchObject({ status: 'active', revision: 3 });

  const second = await revoke({ authorization: `Bearer ${await issueSession('clerk-device')}` });
  expect(second.status).toBe(200);
  expect(await currentConsent()).toMatchObject({ status: 'revoked', revision: 4 });

  const { ownerId: _owner, googleAccountId: connectionId, ...input } = consent;
  const body = JSON.stringify({ ...input, connectionId, accepted: true, expectedConsentRevision: 4 });
  const grantPath = `${route.pathname}/api/integrations/gmail/processing-consents`;
  const auth = { authorization: `Bearer ${await issueSession('clerk-device')}`, 'content-type': 'application/json' };
  const grant = await platform.request(`${grantPath}${route.search}`, {
    method: 'POST', headers: { host: 'app.matrix-os.com', ...auth }, body,
  });
  expect(grant.status).toBe(200);
  expect(await currentConsent()).toMatchObject({ status: 'active', revision: 5 });
  const grantHeaders = new Headers(platformHop.mock.calls.at(-1)?.[1]?.headers);
  expect(grantHeaders.get('x-matrix-google-owner-authorization')).toBeNull();
  const repeatGrant = (payload: string) => platform.request(`${internalBase}/gmail/processing-consents`, {
    method: 'POST', headers: grantHeaders, body: payload,
  });
  expect((await repeatGrant(JSON.stringify({ ...input, connectionId, accepted: true, expectedConsentRevision: 5 }))).status).toBe(403);
  expect((await repeatGrant(body)).status).toBe(409);
  const nextGrant = JSON.stringify({ ...input, connectionId, accepted: true, expectedConsentRevision: 5 });
  const routingGrant = await platform.request(`${grantPath}${route.search}`, {
    method: 'POST', headers: { host: 'app.matrix-os.com', ...auth, authorization: `Bearer ${await issueSession()}` },
    body: nextGrant,
  });
  expect(routingGrant.status).toBe(403);
  const extraQuery = new URL(`${grantPath}${route.search}`, route);
  extraQuery.searchParams.set('unrecognized', 'fixture');
  const queryGrant = await platform.request(extraQuery.toString(), {
    method: 'POST', headers: { host: 'app.matrix-os.com', ...auth }, body: nextGrant,
  });
  expect(queryGrant.status).toBe(403);
  expect(await currentConsent()).toMatchObject({ status: 'active', revision: 5 });
}, 45_000);
