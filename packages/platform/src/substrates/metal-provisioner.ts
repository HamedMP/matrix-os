import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { AccountDeletionAdmissionError, withAccountDeletionAdmission } from '../account-deletion/admission.js';
import { createRegistrationToken, type RegistrationToken } from '../customer-vps-auth.js';
import { renderCloudInitTemplate } from '../customer-vps-cloud-init.js';
import type { CustomerVpsConfig } from '../customer-vps-config.js';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from '../customer-vps-host-config.js';
import { hostBundleUrlForImageVersion } from '../customer-vps-host-bundle.js';
import { ClerkUserIdSchema, CustomerHandleSchema, RuntimeSlotSchema } from '../customer-vps-schema.js';
import { toUserMachineRow } from '../database/user-machine-records.js';
import { DEFAULT_DEVELOPER_TOOLS, DeveloperToolsSchema, type DeveloperToolId } from '../developer-tools.js';
import {
  getActiveUserMachineByClerkId,
  getHostBundleRelease,
  getUserMachine,
  lockUserMachineProvisioning,
  retireUserMachine,
  runInPlatformTransaction,
  type PlatformDB,
} from '../db.js';
import { HOSTD_CREATE_TIMEOUT_MS, HostdError, type HostdClient } from './hostd-client.js';
import type { MetalHost, MetalHostsRepository } from './metal-hosts-repository.js';
import { enqueueMetalVmDeletion } from './metal-vm-deletions.js';
import { isMetalRegistrationExpired, neverRegistered } from './metal-registration-window.js';

/**
 * Provisions owner runtimes as VMs on Matrix-operated metal hosts (spec 2691,
 * ENG-520). The `user_machines` row is written before hostd is asked to create
 * the VM, so no VM exists without a platform record; a failed create marks the
 * row failed and queues a durable teardown in the same transaction. The guest
 * registers through `/vps/register` with `provider: metal` and its machine id
 * as `serverRef`, using the same one-time registration token as Hetzner.
 *
 * Owner policy (plan, invites, capacity limits, billing) belongs to the
 * caller; this module only places, records, and creates.
 */

export const METAL_POOL_FREE_MIN_BYTES = 200 * 1024 ** 3;
export const METAL_CAPACITY_TIMEOUT_MS = 5_000;
export const METAL_USER_DATA_LIMIT_BYTES = 64 * 1024;
const CAPACITY_CONCURRENCY = 4;
/** Attempts to record a created VM's id and address before giving up and tearing it down. */
export const METAL_VM_RECORD_ATTEMPTS = 3;
const VM_RECORD_BACKOFF_MS = 200;
/**
 * Create errors after which hostd may still be cloning or booting the VM. Its
 * teardown waits out the create window so the drainer does not list too early.
 */
const AMBIGUOUS_CREATE_ERRORS = new Set(['timeout', 'unreachable', 'invalid_response']);
const STALE_BATCH_SIZE = 50;
/** Bound on the inline teardown of a stuck VM during a provision request. */
export const METAL_INLINE_DESTROY_TIMEOUT_MS = 15_000;
/** One rebuild (after a failure) per owner in this window, whichever route asked (journey, provision API). */
export const METAL_PROVISION_MIN_INTERVAL_MS = 30_000;
const PROVISION_THROTTLE_MAX_ENTRIES = 10_000;
/** Background teardowns in flight; one per failed-row transition, capped for shutdown drains. */
const BACKGROUND_DESTROY_MAX = 256;

export type MetalTier = 'free' | 'paid';

/**
 * Free VM limits from the metal design. Paid sizing on metal is not decided;
 * an upgraded owner keeps their VM and changes policy through hostd instead of
 * being provisioned again, so paid uses the same create shape for now.
 */
export const METAL_VM_SHAPES = {
  // 40 GiB thin disk: the golden (~17 GB) plus Browser (~1 GB, needs 2 GiB free)
  // and owner data. Must not exceed hostd's FREE_DISK_GIB
  // (packages/hostd/src/vm-lifecycle.ts), which refuses larger free creates.
  free: { bootMiB: 2048, maxMiB: 8192, diskGiB: 40 },
  paid: { bootMiB: 2048, maxMiB: 8192, diskGiB: 20 },
} as const;

/**
 * Developer tools preinstalled per tier when the caller names none. Free
 * runtimes always preinstall only Claude Code and Codex (the free plan selects
 * no tools); OpenCode and Pi stay installable from the Terminal + menu. Paid
 * uses the owner's plan-step choice, else the default set.
 */
export const METAL_DEVELOPER_TOOLS: Record<MetalTier, readonly DeveloperToolId[]> = {
  free: ['codex', 'claude-code'],
  paid: DEFAULT_DEVELOPER_TOOLS,
};

export type MetalProvisionResult = { machineId: string }
  | { error: 'busy' | 'unavailable' | 'throttled' | 'retry_exhausted' | 'support_required' };

const ProvisionInputSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  handle: CustomerHandleSchema,
  tier: z.enum(['free', 'paid']),
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
  /** A paid owner's plan-step choice (canonicalized like the Hetzner path). Ignored for free. */
  developerTools: DeveloperToolsSchema.optional(),
});

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-provisioner] ${event}`, JSON.stringify(fields));

export interface MetalProvisionerDeps {
  db: PlatformDB;
  hosts: Pick<MetalHostsRepository, 'listActive'>;
  clientFor: (host: MetalHost) => HostdClient;
  /**
   * Validated METAL_GOLDEN_VERSION from the metal substrate config: the host
   * bundle version the golden disk was built from (build-golden-disk.sh names
   * the LV golden-<bundle-version>), so it is also the bundle every VM runs.
   */
  goldenVersion: string;
  config: CustomerVpsConfig;
  cloudInitTemplate?: string;
  now?: () => Date;
  machineIdFactory?: () => string;
  tokenFactory?: (now: Date, ttlMs: number) => RegistrationToken;
  postgresPasswordFactory?: () => string;
  /**
   * Destroys a machine's queued VM teardowns now (the deletion drainer's
   * drainMachine). Used after a late retry fails a stuck row, so its VM does
   * not keep holding host memory where no maintenance worker drains the queue.
   */
  drainMachineDeletions?: (machineId: string, signal: AbortSignal) => Promise<unknown>;
  log?: Log;
  sleep?: (ms: number) => Promise<void>;
}

function errorCode(error: unknown): string {
  if (error instanceof HostdError) return error.code;
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Adds `MATRIX_SERVER_PROVIDER=metal` and `MATRIX_SERVER_REF=<machineId>` to
 * host.env, right after its `MATRIX_MACHINE_ID` line and at the same indent.
 * hostd assigns the VM id on create, after this renders, so the guest names
 * its platform machine instead. The lines are added here rather than through
 * template placeholders so Hetzner user data, which runs within bytes of its
 * 32 KiB limit, stays byte-identical. Returns null unless the template has
 * exactly one such line.
 */
export function withMetalServerEnv(userData: string, machineId: string): string | null {
  const escaped = machineId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^([ \\t]*)MATRIX_MACHINE_ID=${escaped}$`, 'gm');
  const matches = [...userData.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const [line, indent] = matches[0]!;
  const at = matches[0]!.index + line.length;
  const added = `\n${indent}MATRIX_SERVER_PROVIDER=metal\n${indent}MATRIX_SERVER_REF=${machineId}`;
  return userData.slice(0, at) + added + userData.slice(at);
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createMetalProvisioner(deps: MetalProvisionerDeps) {
  const { db, config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  const machineIdFactory = deps.machineIdFactory ?? randomUUID;
  const tokenFactory = deps.tokenFactory ?? createRegistrationToken;
  const postgresPasswordFactory = deps.postgresPasswordFactory ?? (() => randomBytes(24).toString('base64url'));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const maxAttempts = config.maxProvisionAttempts;
  // Per-instance; the DB attempt ceiling is the bound across instances.
  const lastBuildStart = new Map<string, number>();
  const backgroundDestroys = new Set<Promise<void>>();

  /** Admits one build start per owner per window. */
  function admitBuildStart(clerkUserId: string): boolean {
    const at = now().getTime();
    const previous = lastBuildStart.get(clerkUserId);
    if (previous !== undefined && at >= previous && at - previous < METAL_PROVISION_MIN_INTERVAL_MS) return false;
    lastBuildStart.delete(clerkUserId);
    if (lastBuildStart.size >= PROVISION_THROTTLE_MAX_ENTRIES) {
      for (const [owner, startedAt] of lastBuildStart) {
        if (at - startedAt >= METAL_PROVISION_MIN_INTERVAL_MS) lastBuildStart.delete(owner);
      }
      if (lastBuildStart.size >= PROVISION_THROTTLE_MAX_ENTRIES) {
        const oldest = lastBuildStart.keys().next().value;
        if (oldest !== undefined) lastBuildStart.delete(oldest);
      }
    }
    lastBuildStart.set(clerkUserId, at);
    return true;
  }

  /**
   * Whether a failed row may be replaced by a fresh build: only a first build
   * that never registered (a computer that ran needs support, not a rebuild),
   * and only below the attempt ceiling.
   */
  function rebuildRefusal(failed: { attempt: number; lastSeenAt: string | null; recoveryOldServerId: number | null }):
    'support_required' | 'retry_exhausted' | null {
    if (!neverRegistered(failed)) return 'support_required';
    return failed.attempt >= maxAttempts ? 'retry_exhausted' : null;
  }

  type Placement = { host: MetalHost } | { error: 'busy' | 'unavailable' };

  /**
   * The active host with the most memory headroom under its admission ceiling
   * that can still boot this VM and has more than 200 GiB of pool free. Ties go
   * to the host running fewer VMs. Unreachable hosts are skipped.
   */
  async function place(bootMiB: number): Promise<Placement> {
    let hosts: MetalHost[];
    try {
      hosts = await deps.hosts.listActive();
    } catch (error: unknown) {
      log('placement_registry_unavailable', { code: errorCode(error) });
      return { error: 'unavailable' };
    }
    const probes = await mapBounded(hosts, CAPACITY_CONCURRENCY, async (host) => {
      try {
        const capacity = await deps.clientFor(host).capacity(AbortSignal.timeout(METAL_CAPACITY_TIMEOUT_MS));
        return { host, capacity };
      } catch (error: unknown) {
        log('placement_host_unreachable', { hostId: host.id, code: errorCode(error) });
        return null;
      }
    });
    const reachable = probes.filter((probe) => probe !== null);
    if (reachable.length === 0) return { error: 'unavailable' };
    const candidates = reachable
      .map(({ host, capacity }) => ({
        host,
        runningVms: capacity.runningVms,
        poolFreeBytes: capacity.poolFreeBytes,
        // Memory the host may still commit before it reaches its admission ceiling.
        headroomMiB: capacity.memoryAvailableMiB - (host.memoryCapacityMib - host.admissionCeilingMib),
      }))
      .filter((c) => c.headroomMiB >= bootMiB && c.poolFreeBytes > METAL_POOL_FREE_MIN_BYTES)
      .sort((a, b) => b.headroomMiB - a.headroomMiB || a.runningVms - b.runningVms || a.host.name.localeCompare(b.host.name));
    return candidates[0] ? { host: candidates[0].host } : { error: 'busy' };
  }

  async function renderUserData(input: {
    machineId: string;
    clerkUserId: string;
    handle: string;
    runtimeSlot: string;
    registration: RegistrationToken;
    developerTools: readonly DeveloperToolId[];
  }): Promise<{ userData: string; imageVersion: string; bundleSha256: string } | null> {
    try {
      // A VM is a clone of the golden disk, so it runs the golden's bundle: pin
      // that registered release instead of the update channel, which may point
      // elsewhere or nowhere (a preview's empty dev channel).
      const release = await getHostBundleRelease(db, deps.goldenVersion);
      // Registration verifies the guest against this pin; a metal runtime never boots unpinned.
      const bundleSha256 = release?.sha256;
      if (!release || !bundleSha256 || !/^[a-f0-9]{64}$/.test(bundleSha256) || bundleSha256 === '0'.repeat(64)) {
        log('golden_bundle_unpinned', { machineId: input.machineId, goldenVersion: deps.goldenVersion });
        return null;
      }
      const bundleRef = {
        imageVersion: release.version,
        hostBundleUrl: hostBundleUrlForImageVersion(config, release.version),
        sha256: bundleSha256,
      };
      const hostConfig = buildHostConfig(
        config,
        { clerkUserId: input.clerkUserId, handle: input.handle, runtimeSlot: input.runtimeSlot, provisioningClass: 'customer',
          developerTools: [...input.developerTools] },
        input.machineId,
        input.registration.token,
        input.registration.expiresAt,
        postgresPasswordFactory(),
        bundleRef,
      );
      const userData = withMetalServerEnv(
        renderCloudInitTemplate(deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE, {
          ...hostConfig,
          // The clone already holds this exact bundle and its host
          // prerequisites; naming it as the snapshot source lets cloud-init's
          // matrix-golden-snapshot-fast-path skip the clean-image install.
          imageSource: 'snapshot',
          snapshotSourceVersion: release.version,
          targetBundleSha256: bundleSha256,
        }),
        input.machineId,
      );
      if (userData === null) {
        log('user_data_unrenderable', { machineId: input.machineId });
        return null;
      }
      if (new TextEncoder().encode(userData).byteLength > METAL_USER_DATA_LIMIT_BYTES) {
        log('user_data_too_large', { machineId: input.machineId });
        return null;
      }
      return { userData, imageVersion: bundleRef.imageVersion, bundleSha256 };
    } catch (error: unknown) {
      log('user_data_unavailable', { machineId: input.machineId, code: errorCode(error) });
      return null;
    }
  }

  type Claim = { created: true } | { existing: string } | { error: 'unavailable' | 'support_required' | 'retry_exhausted' };

  /** Inserts the provisioning row under the owner's provisioning lock, or reports the runtime already in the slot. */
  async function claimSlot(row: {
    machineId: string;
    clerkUserId: string;
    handle: string;
    runtimeSlot: string;
    host: MetalHost;
    imageVersion: string;
    bundleSha256: string;
    registration: RegistrationToken;
    developerTools: readonly DeveloperToolId[];
    at: Date;
  }): Promise<Claim> {
    try {
      return await withAccountDeletionAdmission(db, row.clerkUserId, async (trx): Promise<Claim> => {
        await lockUserMachineProvisioning(trx, row.clerkUserId);
        const current = await getActiveUserMachineByClerkId(trx, row.clerkUserId, row.runtimeSlot);
        // A rebuild after a failure counts toward the owner's attempt ceiling.
        let attempt = 1;
        if (current) {
          if (current.substrate !== 'metal') return { error: 'unavailable' };
          if (current.status !== 'failed') return { existing: current.machineId };
          const refusal = rebuildRefusal(current);
          if (refusal) return { error: refusal };
          attempt = current.attempt + 1;
          await retireUserMachine(trx, current.machineId, row.at.toISOString());
          // A stale row failed by this request already had its teardown queued
          // (and maybe completed inline); never queue the same generation twice.
          const queued = await trx.executor.selectFrom('metal_vm_deletions').select('id')
            .where('machine_id', '=', current.machineId)
            .where('generation', '=', current.generation)
            .executeTakeFirst();
          if (current.metalHostId && !queued) {
            await enqueueMetalVmDeletion(trx, {
              metalHostId: current.metalHostId,
              machineId: current.machineId,
              generation: current.generation,
              metalVmId: current.metalVmId,
              reason: 'failed_retry_retire',
              now: row.at,
            });
          }
        }
        // DO NOTHING on any active unique scope, then select the winner: a
        // concurrent provision for this owner and slot returns its runtime, and
        // a handle held by another owner is unavailable.
        const inserted = await trx.executor.insertInto('user_machines')
          .values(toUserMachineRow({
            machineId: row.machineId,
            clerkUserId: row.clerkUserId,
            handle: row.handle,
            runtimeSlot: row.runtimeSlot,
            substrate: 'metal',
            generation: 1,
            metalHostId: row.host.id,
            provisioningClass: 'customer',
            status: 'provisioning',
            attempt,
            developerTools: [...row.developerTools],
            imageVersion: row.imageVersion,
            targetBundleVersion: row.imageVersion,
            targetBundleSha256: row.bundleSha256,
            registrationTokenHash: row.registration.hash,
            registrationTokenExpiresAt: row.registration.expiresAt,
            provisionedAt: row.at.toISOString(),
            activationState: 'authorized',
          }))
          .onConflict((oc) => oc.doNothing())
          .returning('machine_id')
          .executeTakeFirst();
        if (inserted) return { created: true };
        const winner = await getActiveUserMachineByClerkId(trx, row.clerkUserId, row.runtimeSlot);
        return winner?.substrate === 'metal' && winner.status !== 'failed'
          ? { existing: winner.machineId }
          : { error: 'unavailable' };
      });
    } catch (error: unknown) {
      if (!(error instanceof AccountDeletionAdmissionError)) {
        log('provision_claim_failed', { machineId: row.machineId, code: errorCode(error) });
      }
      return { error: 'unavailable' };
    }
  }

  /**
   * Marks a row whose create failed as failed and queues its teardown in one
   * transaction. A row the guest already registered is left running.
   */
  async function failCreate(machineId: string, host: MetalHost, createError: unknown): Promise<MetalProvisionResult> {
    const code = errorCode(createError);
    log('hostd_create_failed', { machineId, hostId: host.id, code });
    const at = now();
    try {
      const failed = await runInPlatformTransaction(db, async (trx) => {
        const row = await trx.executor.updateTable('user_machines')
          .set({ status: 'failed', failure_code: 'provider_unavailable', failure_at: at.toISOString() })
          .where('machine_id', '=', machineId)
          .where('status', '=', 'provisioning')
          .where('deleted_at', 'is', null)
          .returning(['generation', 'metal_vm_id'])
          .executeTakeFirst();
        if (!row) return false;
        await enqueueMetalVmDeletion(trx, {
          metalHostId: host.id,
          machineId,
          generation: row.generation,
          metalVmId: row.metal_vm_id,
          reason: 'create_failed',
          now: at,
          ...(AMBIGUOUS_CREATE_ERRORS.has(code)
            ? { notBefore: new Date(at.getTime() + 2 * HOSTD_CREATE_TIMEOUT_MS) }
            : {}),
        });
        return true;
      });
      if (!failed && (await getUserMachine(db, machineId))?.status === 'running') return { machineId };
    } catch (error: unknown) {
      // The row stays provisioning; reconcileStale fails it and queues teardown after the registration window.
      log('create_failure_record_failed', { machineId, code: errorCode(error) });
    }
    const capacityFull = createError instanceof HostdError
      && (createError.code === 'busy' || createError.code === 'pool_full');
    return { error: capacityFull ? 'busy' : 'unavailable' };
  }

  /**
   * Stores the created VM's id and address with a targeted update, retried a
   * few times. If it still fails, the row is failed and the VM queued for
   * teardown in one transaction, so no VM runs unrecorded; registration also
   * refuses a metal row without a VM id.
   */
  async function recordCreated(machineId: string, host: MetalHost, vm: { id: string; privateIPv4: string }): Promise<MetalProvisionResult> {
    for (let attempt = 1; attempt <= METAL_VM_RECORD_ATTEMPTS; attempt += 1) {
      try {
        const recorded = await db.executor.updateTable('user_machines')
          .set({ metal_vm_id: vm.id, private_address: vm.privateIPv4 })
          .where('machine_id', '=', machineId)
          .where('metal_host_id', '=', host.id)
          // Idempotent on this VM: a retry after an attempt that committed but
          // reported an error matches its own write instead of looking superseded.
          .where((eb) => eb.or([eb('metal_vm_id', 'is', null), eb('metal_vm_id', '=', vm.id)]))
          .where('status', 'in', ['provisioning', 'running'])
          .where('deleted_at', 'is', null)
          .returning('machine_id')
          .executeTakeFirst();
        if (recorded) return { machineId };
        // The row left provisioning while hostd was creating (deleted, failed, or
        // holding a different VM): tear this VM down.
        log('provision_superseded', { machineId, hostId: host.id });
        await enqueueMetalVmDeletion(db, {
          metalHostId: host.id, machineId, generation: 1, metalVmId: vm.id, reason: 'provision_superseded', now: now(),
        });
        return { error: 'unavailable' };
      } catch (error: unknown) {
        log('create_record_failed', { machineId, attempt, code: errorCode(error) });
        if (attempt < METAL_VM_RECORD_ATTEMPTS) await sleep(VM_RECORD_BACKOFF_MS * attempt);
      }
    }
    const at = now();
    try {
      await runInPlatformTransaction(db, async (trx) => {
        await trx.executor.updateTable('user_machines')
          .set({ status: 'failed', failure_code: 'provider_unavailable', failure_at: at.toISOString() })
          .where('machine_id', '=', machineId)
          .where('status', '=', 'provisioning')
          .where('deleted_at', 'is', null)
          .execute();
        await enqueueMetalVmDeletion(trx, {
          metalHostId: host.id, machineId, generation: 1, metalVmId: vm.id, reason: 'create_unrecorded', now: at,
        });
      });
    } catch (error: unknown) {
      // The row stays provisioning without a VM id: registration refuses it, and
      // reconcileStale fails it and queues teardown (found by listing) after the window.
      log('create_unrecorded_teardown_failed', { machineId, code: errorCode(error) });
    }
    return { error: 'unavailable' };
  }

  /**
   * Fails a metal row still provisioning after its registration window closed
   * and queues its teardown, in one transaction. A row the guest registered
   * meanwhile is left alone.
   */
  async function failStale(
    row: { machineId: string; metalHostId: string | null; generation: number; metalVmId: string | null },
    at: Date,
  ): Promise<boolean> {
    if (!row.metalHostId) return false;
    const metalHostId = row.metalHostId;
    return runInPlatformTransaction(db, async (trx) => {
      const updated = await trx.executor.updateTable('user_machines')
        .set({ status: 'failed', failure_code: 'registration_timeout', failure_at: at.toISOString() })
        .where('machine_id', '=', row.machineId)
        .where('generation', '=', row.generation)
        .where('status', '=', 'provisioning')
        .where('registration_token_expires_at', '<', at.toISOString())
        .where('deleted_at', 'is', null)
        .returning('machine_id')
        .executeTakeFirst();
      if (!updated) return false;
      await enqueueMetalVmDeletion(trx, {
        metalHostId,
        machineId: row.machineId,
        generation: row.generation,
        metalVmId: row.metalVmId,
        reason: 'registration_timeout',
        now: at,
      });
      return true;
    });
  }

  /**
   * Fails an expired metal provisioning row (failStale's SQL guards keep a late
   * /vps/register safe) and, after the commit, destroys its VM inline as a best
   * effort; the queued teardown stays the durable fallback.
   */
  async function failExpired(
    row: { machineId: string; metalHostId: string | null; generation: number; metalVmId: string | null },
    teardown: 'await' | 'background' = 'await',
  ): Promise<'failed' | 'unchanged' | 'error'> {
    const at = now();
    let failed: boolean;
    try {
      failed = await failStale(row, at);
    } catch (error: unknown) {
      log('stale_fail_failed', { machineId: row.machineId, code: errorCode(error) });
      return 'error';
    }
    if (failed && deps.drainMachineDeletions) {
      const drain = deps.drainMachineDeletions;
      const destroy = (async () => {
        try {
          await drain(row.machineId, AbortSignal.timeout(METAL_INLINE_DESTROY_TIMEOUT_MS));
        } catch (error: unknown) {
          log('stale_inline_destroy_failed', { machineId: row.machineId, code: errorCode(error) });
        }
      })();
      // Read paths answer first; the bounded destroy logs its own failure and
      // the queued deletion stays the durable fallback. Tracked for drain().
      if (teardown === 'await') {
        await destroy;
      } else if (backgroundDestroys.size < BACKGROUND_DESTROY_MAX) {
        backgroundDestroys.add(destroy);
        void destroy.finally(() => { backgroundDestroys.delete(destroy); });
      }
    }
    return failed ? 'failed' : 'unchanged';
  }

  return {
    async provision(input: {
      clerkUserId: string; handle: string; tier: MetalTier; runtimeSlot?: string; developerTools?: readonly DeveloperToolId[];
    }): Promise<MetalProvisionResult> {
      const parsed = ProvisionInputSchema.safeParse(input);
      if (!parsed.success) return { error: 'unavailable' };
      const { clerkUserId, handle, tier, runtimeSlot } = parsed.data;
      const developerTools = tier === 'free'
        ? METAL_DEVELOPER_TOOLS.free
        : parsed.data.developerTools ?? METAL_DEVELOPER_TOOLS.paid;

      // Cheap idempotency check before probing hosts; the claim re-checks under the lock.
      let existing = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
      // A guest that never registered (its first boot failed) would otherwise be
      // returned forever wherever no maintenance worker runs reconcileStale.
      if (existing && isMetalRegistrationExpired(existing, now())) {
        if (await failExpired(existing) === 'error') return { error: 'unavailable' };
        existing = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
      }
      if (existing && (existing.substrate !== 'metal' || existing.status !== 'failed')) {
        return existing.substrate === 'metal' ? { machineId: existing.machineId } : { error: 'unavailable' };
      }
      // Checked here for every route (claimSlot re-checks under the lock).
      const refusal = existing ? rebuildRefusal(existing) : null;
      if (refusal) return { error: refusal };
      // Throttle rebuilds only: a first build is idempotent (later calls return
      // its row), so only a failing build can drive a create loop.
      if (existing && !admitBuildStart(clerkUserId)) return { error: 'throttled' };

      const shape = METAL_VM_SHAPES[tier];
      const placement = await place(shape.bootMiB);
      if ('error' in placement) return placement;
      const { host } = placement;

      const at = now();
      const machineId = machineIdFactory();
      const registration = tokenFactory(at, config.registrationTokenTtlMs);
      const rendered = await renderUserData({ machineId, clerkUserId, handle, runtimeSlot, registration, developerTools });
      if (!rendered) return { error: 'unavailable' };

      const claim = await claimSlot({
        machineId, clerkUserId, handle, runtimeSlot, host, imageVersion: rendered.imageVersion, bundleSha256: rendered.bundleSha256, registration, developerTools, at,
      });
      if ('error' in claim) return claim;
      if ('existing' in claim) return { machineId: claim.existing };

      let vm: { id: string; privateIPv4: string };
      try {
        vm = await deps.clientFor(host).createVm({
          machineId,
          generation: 1,
          handle,
          tier,
          bootMiB: shape.bootMiB,
          maxMiB: shape.maxMiB,
          diskGiB: shape.diskGiB,
          userData: rendered.userData,
          goldenVersion: deps.goldenVersion,
        });
      } catch (error: unknown) {
        return failCreate(machineId, host, error);
      }
      return recordCreated(machineId, host, vm);
    },

    /**
     * Read-path reconciliation for one owner slot: fails the active metal row
     * if its registration window closed with the guest never registered, so
     * the journey shows provisioning_failed and its retry instead of waiting
     * forever where no maintenance worker runs.
     */
    /** Resolves once every background teardown started by a read path has settled (shutdown). */
    async drain(): Promise<void> {
      await Promise.allSettled([...backgroundDestroys]);
    },

    async failExpiredProvisioning(clerkUserId: string, runtimeSlot: string): Promise<'failed' | 'unchanged' | 'error'> {
      const row = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
      if (!row || !isMetalRegistrationExpired(row, now())) return 'unchanged';
      // A read path must stay under the shell's journey timeout: destroy after answering.
      return failExpired(row, 'background');
    },

    /**
     * Fails metal rows whose registration window closed while still
     * provisioning and queues their teardown. The Hetzner reconciler skips
     * metal rows, so this is their only stale-provisioning path.
     */
    async reconcileStale(): Promise<{ failed: number }> {
      const at = now();
      await db.ready;
      const stale = await db.executor.selectFrom('user_machines')
        .select(['machine_id', 'metal_host_id', 'generation', 'metal_vm_id'])
        .where('substrate', '=', 'metal')
        .where('status', '=', 'provisioning')
        .where('deleted_at', 'is', null)
        .where('registration_token_expires_at', '<', at.toISOString())
        .orderBy('provisioned_at')
        .limit(STALE_BATCH_SIZE)
        .execute();
      let failed = 0;
      for (const row of stale) {
        if (await failStale({
          machineId: row.machine_id, metalHostId: row.metal_host_id, generation: row.generation, metalVmId: row.metal_vm_id,
        }, at)) failed += 1;
      }
      return { failed };
    },
  };
}

export type MetalProvisioner = ReturnType<typeof createMetalProvisioner>;
