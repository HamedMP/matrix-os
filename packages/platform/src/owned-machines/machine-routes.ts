import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  OWNED_MACHINE_ENROLLMENT_POLL_SECONDS,
  OWNED_MACHINE_ENROLLMENT_TTL_SECONDS,
  OWNED_MACHINE_HEARTBEAT_INTERVAL_MS,
  OwnedEnrollPollRequestSchema,
  OwnedEnrollStartRequestSchema,
  OwnedMachineEnvSchema,
  OwnedMachineHeartbeatRequestSchema,
  type OwnedEnrollPollResponse,
  type OwnedMachineHeartbeatResponse,
} from '@matrix-os/contracts';
import type { PlatformDB, UserMachineRecord } from '../db.js';
import { USER_CODE_ALPHABET, formatUserCode } from '../device-flow.js';
import {
  buildOwnedMachineVerificationToken,
  buildPlatformRuntimeVerificationToken,
  buildPlatformSpeechRuntimeVerificationToken,
  buildPlatformSyncVerificationToken,
  timingSafeTokenEquals,
} from '../platform-token.js';
import { createBoundedRateLimiter, runtimeSelectionSourceKey } from '../request-admission.js';
import type { OwnedCloudflareClient } from './cloudflare.js';
import type { OwnedMachinesConfig } from './config.js';
import {
  createOwnedEnrollment,
  getOwnedMachineLink,
  markOwnedEnrollmentDelivered,
  pollOwnedEnrollment,
  recordOwnedHeartbeat,
  requestOwnedTunnelReissue,
  revokeOwnedMachine,
  type OwnedMachineLink,
  type OwnedRevocationHook,
} from './repository.js';

const MACHINE_BODY_LIMIT = 8 * 1024;
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface OwnedMachineRoutesDeps {
  db: PlatformDB;
  config: OwnedMachinesConfig | null;
  cloudflare: OwnedCloudflareClient | null;
  edgeSecret?: string;
  revocationHooks?: readonly OwnedRevocationHook[];
  now?: () => Date;
  log: (route: string, err: unknown) => void;
}

function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

export function hashOwnedDeviceCode(deviceCode: string): string {
  return createHash('sha256').update(`owned-machine:${deviceCode}`).digest('hex');
}

function identityOf(machine: UserMachineRecord) {
  return { handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot };
}

/** Everything a machine needs to run as this runtime. Tokens are derived, never stored. */
export function buildOwnedMachineEnv(config: OwnedMachinesConfig, machine: UserMachineRecord) {
  const identity = identityOf(machine);
  const epoch = machine.runtimeTokenEpoch;
  const ownedToken = buildOwnedMachineVerificationToken(identity, config.platformSecret, epoch);
  return OwnedMachineEnvSchema.parse({
    MATRIX_MACHINE_ID: machine.machineId,
    MATRIX_CLERK_USER_ID: machine.clerkUserId,
    MATRIX_HANDLE: machine.handle,
    MATRIX_RUNTIME_SLOT: machine.runtimeSlot,
    MATRIX_RUNTIME_TOKEN_EPOCH: String(epoch),
    MATRIX_SUBSTRATE: 'owned',
    MATRIX_UPDATE_CHANNEL: config.updateChannel,
    PLATFORM_INTERNAL_URL: config.platformInternalUrl,
    UPGRADE_TOKEN: ownedToken,
    MATRIX_AUTH_TOKEN: ownedToken,
    MATRIX_CODE_PROXY_TOKEN: ownedToken,
    MATRIX_SYNC_RUNTIME_TOKEN: buildPlatformSyncVerificationToken(identity, config.platformSecret, epoch),
    MATRIX_FUNDED_AI_RUNTIME_TOKEN: buildPlatformRuntimeVerificationToken(identity, config.platformSecret, epoch),
    MATRIX_FUNDED_AI_ENABLED: String(config.fundedAiEnabled),
    MATRIX_FUNDED_AI_RELAY_URL: config.fundedAiRelayUrl,
    MATRIX_PLATFORM_SPEECH_ENABLED: String(config.platformSpeechEnabled),
    MATRIX_PLATFORM_SPEECH_ORIGIN: config.platformInternalUrl,
    MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: buildPlatformSpeechRuntimeVerificationToken(identity, config.platformSecret, epoch),
  });
}

/**
 * Authenticates a machine request: the machine id names the row, the bearer
 * must be that row's current-epoch owned token. Revoked or deleted rows fail.
 */
export async function authenticateOwnedMachine(
  db: PlatformDB, platformSecret: string, c: Context,
): Promise<OwnedMachineLink | null> {
  const machineId = c.req.header('x-matrix-machine-id') ?? '';
  const auth = c.req.header('authorization') ?? '';
  if (!MACHINE_ID.test(machineId) || !auth.startsWith('Bearer ')) return null;
  const link = await getOwnedMachineLink(db, machineId);
  if (!link || link.revokedAt || link.machine.deletedAt || link.machine.substrate !== 'owned') return null;
  const expected = buildOwnedMachineVerificationToken(identityOf(link.machine), platformSecret, link.machine.runtimeTokenEpoch);
  return timingSafeTokenEquals(auth.slice(7), expected) ? link : null;
}

export async function readOwnedJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

export function createOwnedMachineRoutes(deps: OwnedMachineRoutesDeps): Hono {
  const routes = new Hono();
  const now = () => deps.now?.() ?? new Date();
  const startLimiter = createBoundedRateLimiter(20);
  const pollLimiter = createBoundedRateLimiter(30);
  const machineLimiter = createBoundedRateLimiter(12);
  const limit = bodyLimit({ maxSize: MACHINE_BODY_LIMIT, onError: (c) => c.json({ error: 'Request too large' }, 413) });

  routes.use('/api/machines/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.config || !deps.cloudflare) return c.json({ error: 'Owned computers unavailable' }, 503);
    await next();
  });

  routes.post('/api/machines/enroll/start', limit, async (c) => {
    const config = deps.config!;
    const source = runtimeSelectionSourceKey(c, deps.edgeSecret);
    if (!startLimiter.check(source)) return c.json({ error: 'Too many requests' }, 429);
    const parsed = OwnedEnrollStartRequestSchema.safeParse(await readOwnedJson(c));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    try {
      const issuedAt = now();
      const sourceKey = createHash('sha256').update(source).digest('hex');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const deviceCode = randomBytes(32).toString('base64url');
        const userCode = generateUserCode();
        const result = await createOwnedEnrollment(deps.db, {
          enrollmentId: randomUUID(),
          deviceCodeHash: hashOwnedDeviceCode(deviceCode),
          userCode,
          report: parsed.data,
          sourceKey,
          now: issuedAt,
          expiresAt: new Date(issuedAt.getTime() + OWNED_MACHINE_ENROLLMENT_TTL_SECONDS * 1000),
        });
        if (result === 'rate_limited') return c.json({ error: 'Too many requests' }, 429);
        if (result === 'capacity') return c.json({ error: 'Owned computers temporarily unavailable' }, 503);
        if (result === 'code_conflict') continue;
        const formatted = formatUserCode(userCode);
        const verification = new URL('/connect', config.publicUrl);
        const complete = new URL(verification);
        complete.searchParams.set('code', formatted);
        return c.json({
          deviceCode,
          userCode: formatted,
          verificationUri: verification.toString(),
          verificationUriComplete: complete.toString(),
          expiresIn: OWNED_MACHINE_ENROLLMENT_TTL_SECONDS,
          interval: OWNED_MACHINE_ENROLLMENT_POLL_SECONDS,
        });
      }
      return c.json({ error: 'Owned computers temporarily unavailable' }, 503);
    } catch (err: unknown) {
      deps.log('/api/machines/enroll/start', err);
      return c.json({ error: 'Owned computers temporarily unavailable' }, 503);
    }
  });

  routes.post('/api/machines/enroll/poll', limit, async (c) => {
    const config = deps.config!;
    const parsed = OwnedEnrollPollRequestSchema.safeParse(await readOwnedJson(c));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    const deviceCodeHash = hashOwnedDeviceCode(parsed.data.deviceCode);
    if (!pollLimiter.check(deviceCodeHash)) return c.json({ status: 'slow_down' } satisfies OwnedEnrollPollResponse);
    try {
      const at = now();
      const result = await pollOwnedEnrollment(deps.db, deviceCodeHash, at, (OWNED_MACHINE_ENROLLMENT_POLL_SECONDS - 1) * 1000);
      if (result.status !== 'approved') return c.json({ status: result.status } satisfies OwnedEnrollPollResponse);
      if (result.tunnelState === 'failed') {
        await requestOwnedTunnelReissue(deps.db, result.machineId, at);
        return c.json({ status: 'pending' } satisfies OwnedEnrollPollResponse);
      }
      if (result.tunnelState !== 'ready') return c.json({ status: 'pending' } satisfies OwnedEnrollPollResponse);
      const link = await getOwnedMachineLink(deps.db, result.machineId);
      if (!link?.tunnelId || link.revokedAt) return c.json({ status: 'denied' } satisfies OwnedEnrollPollResponse);
      // Fetch the provider token before the single-delivery CAS, so a provider
      // failure leaves the enrollment deliverable on the next poll.
      const tunnelToken = await deps.cloudflare!.getTunnelToken(link.tunnelId);
      const env = buildOwnedMachineEnv(config, link.machine);
      if (!(await markOwnedEnrollmentDelivered(deps.db, result.enrollmentId, at))) {
        return c.json({ status: 'expired' } satisfies OwnedEnrollPollResponse);
      }
      return c.json({ status: 'ready', machineId: link.machine.machineId, tunnelToken, env } satisfies OwnedEnrollPollResponse);
    } catch (err: unknown) {
      deps.log('/api/machines/enroll/poll', err);
      return c.json({ status: 'pending' } satisfies OwnedEnrollPollResponse);
    }
  });

  routes.post('/api/machines/heartbeat', limit, async (c) => {
    const config = deps.config!;
    try {
      const link = await authenticateOwnedMachine(deps.db, config.platformSecret, c);
      if (!link) return c.json({ error: 'Unauthorized' }, 401);
      if (!machineLimiter.check(`hb:${link.machine.machineId}`)) return c.json({ error: 'Too many requests' }, 429);
      const parsed = OwnedMachineHeartbeatRequestSchema.safeParse(await readOwnedJson(c));
      if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
      const at = now();
      // A machine whose gateway is down is reachable but not usable: answer the
      // heartbeat without refreshing liveness, so it turns offline, not online.
      if (!parsed.data.gatewayHealthy) {
        return c.json({
          status: 'ok',
          tunnel: link.tunnelState === 'ready' ? 'ok' : 'reissue',
          autoSecurityUpdates: link.autoSecurityUpdates,
          backupsEnabled: link.backupsEnabled,
        } satisfies OwnedMachineHeartbeatResponse);
      }
      const updated = await recordOwnedHeartbeat(deps.db, {
        machineId: link.machine.machineId,
        epoch: link.machine.runtimeTokenEpoch,
        agentVersion: parsed.data.agentVersion,
        now: at,
        debounceMs: OWNED_MACHINE_HEARTBEAT_INTERVAL_MS - 5_000,
      });
      if (!updated) return c.json({ error: 'Unauthorized' }, 401);
      if (updated.tunnelState === 'reclaimed' || updated.tunnelState === 'failed') {
        await requestOwnedTunnelReissue(deps.db, updated.machine.machineId, at);
      }
      const reissue = updated.tunnelState === 'reclaimed' || updated.tunnelState === 'failed'
        || updated.tunnelState === 'pending';
      return c.json({
        status: 'ok',
        tunnel: reissue ? 'reissue' : 'ok',
        autoSecurityUpdates: updated.autoSecurityUpdates,
        backupsEnabled: updated.backupsEnabled,
      } satisfies OwnedMachineHeartbeatResponse);
    } catch (err: unknown) {
      deps.log('/api/machines/heartbeat', err);
      return c.json({ error: 'Owned computers temporarily unavailable' }, 503);
    }
  });

  routes.post('/api/machines/tunnel', limit, async (c) => {
    const config = deps.config!;
    try {
      const link = await authenticateOwnedMachine(deps.db, config.platformSecret, c);
      if (!link) return c.json({ error: 'Unauthorized' }, 401);
      if (!machineLimiter.check(`tunnel:${link.machine.machineId}`)) return c.json({ error: 'Too many requests' }, 429);
      if (link.tunnelState === 'reclaimed' || link.tunnelState === 'failed') {
        await requestOwnedTunnelReissue(deps.db, link.machine.machineId, now());
      }
      if (link.tunnelState !== 'ready' || !link.tunnelId) return c.json({ status: 'pending' }, 202);
      return c.json({ tunnelToken: await deps.cloudflare!.getTunnelToken(link.tunnelId) });
    } catch (err: unknown) {
      deps.log('/api/machines/tunnel', err);
      return c.json({ error: 'Owned computers temporarily unavailable' }, 503);
    }
  });

  routes.delete('/api/machines/self', limit, async (c) => {
    const config = deps.config!;
    try {
      const link = await authenticateOwnedMachine(deps.db, config.platformSecret, c);
      if (!link) return c.json({ error: 'Unauthorized' }, 401);
      await revokeOwnedMachine(deps.db, { machineId: link.machine.machineId, now: now(), hooks: deps.revocationHooks });
      return c.body(null, 204);
    } catch (err: unknown) {
      deps.log('/api/machines/self', err);
      return c.json({ error: 'Owned computers temporarily unavailable' }, 503);
    }
  });

  return routes;
}
