import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { AccountDeletionAdmissionError, withAccountDeletionAdmission } from '../account-deletion/admission.js';
import { createRegistrationToken, type RegistrationToken } from '../customer-vps-auth.js';
import { renderCloudInitTemplate } from '../customer-vps-cloud-init.js';
import type { CustomerVpsConfig } from '../customer-vps-config.js';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from '../customer-vps-host-config.js';
import { resolveHostBundleRef } from '../customer-vps-host-bundle.js';
import { ClerkUserIdSchema, CustomerHandleSchema, RuntimeSlotSchema } from '../customer-vps-schema.js';
import { toUserMachineRow } from '../database/user-machine-records.js';
import {
  getActiveUserMachineByClerkId,
  getUserMachine,
  lockUserMachineProvisioning,
  retireUserMachine,
  runInPlatformTransaction,
  type PlatformDB,
} from '../db.js';
import { HOSTD_CREATE_TIMEOUT_MS, HostdError, type HostdClient } from './hostd-client.js';
import type { MetalHost, MetalHostsRepository } from './metal-hosts-repository.js';
import { enqueueMetalVmDeletion } from './metal-vm-deletions.js';

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

/**
 * Free VM limits from the metal design. Paid sizing on metal is not decided;
 * an upgraded owner keeps their VM and changes policy through hostd instead of
 * being provisioned again, so paid uses the same create shape for now.
 */
export const METAL_VM_SHAPES = {
  free: { bootMiB: 2048, maxMiB: 8192, diskGiB: 20 },
  paid: { bootMiB: 2048, maxMiB: 8192, diskGiB: 20 },
} as const;

export type MetalTier = keyof typeof METAL_VM_SHAPES;
export type MetalProvisionResult = { machineId: string } | { error: 'busy' | 'unavailable' };

const ProvisionInputSchema = z.object({
  clerkUserId: ClerkUserIdSchema,
  handle: CustomerHandleSchema,
  tier: z.enum(['free', 'paid']),
  runtimeSlot: RuntimeSlotSchema.optional().default('primary'),
});

type Log = (event: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (event, fields) => console.error(`[metal-provisioner] ${event}`, JSON.stringify(fields));

export interface MetalProvisionerDeps {
  db: PlatformDB;
  hosts: Pick<MetalHostsRepository, 'listActive'>;
  clientFor: (host: MetalHost) => HostdClient;
  /** Validated METAL_GOLDEN_VERSION from the metal substrate config. */
  goldenVersion: string;
  config: CustomerVpsConfig;
  cloudInitTemplate?: string;
  now?: () => Date;
  machineIdFactory?: () => string;
  tokenFactory?: (now: Date, ttlMs: number) => RegistrationToken;
  postgresPasswordFactory?: () => string;
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
  }): Promise<{ userData: string; imageVersion: string; bundleSha256: string } | null> {
    try {
      const bundleRef = await resolveHostBundleRef(db, config);
      // Registration verifies the guest against this pin; a metal runtime never boots unpinned.
      const bundleSha256 = bundleRef.sha256;
      if (!bundleSha256 || !/^[a-f0-9]{64}$/.test(bundleSha256) || bundleSha256 === '0'.repeat(64)) {
        log('bundle_unpinned', { machineId: input.machineId });
        return null;
      }
      const hostConfig = buildHostConfig(
        config,
        { clerkUserId: input.clerkUserId, handle: input.handle, runtimeSlot: input.runtimeSlot, provisioningClass: 'customer' },
        input.machineId,
        input.registration.token,
        input.registration.expiresAt,
        postgresPasswordFactory(),
        bundleRef,
      );
      const userData = withMetalServerEnv(
        renderCloudInitTemplate(deps.cloudInitTemplate ?? DEFAULT_CLOUD_INIT_TEMPLATE, {
          ...hostConfig,
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

  type Claim = { created: true } | { existing: string } | { error: 'unavailable' };

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
    at: Date;
  }): Promise<Claim> {
    try {
      return await withAccountDeletionAdmission(db, row.clerkUserId, async (trx): Promise<Claim> => {
        await lockUserMachineProvisioning(trx, row.clerkUserId);
        const current = await getActiveUserMachineByClerkId(trx, row.clerkUserId, row.runtimeSlot);
        if (current) {
          if (current.substrate !== 'metal') return { error: 'unavailable' };
          if (current.status !== 'failed') return { existing: current.machineId };
          await retireUserMachine(trx, current.machineId, row.at.toISOString());
          if (current.metalHostId) {
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
          .where('metal_vm_id', 'is', null)
          .where('status', 'in', ['provisioning', 'running'])
          .where('deleted_at', 'is', null)
          .returning('machine_id')
          .executeTakeFirst();
        if (recorded) return { machineId };
        // The row left provisioning while hostd was creating (deleted or failed): tear the VM down.
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

  return {
    async provision(input: { clerkUserId: string; handle: string; tier: MetalTier; runtimeSlot?: string }): Promise<MetalProvisionResult> {
      const parsed = ProvisionInputSchema.safeParse(input);
      if (!parsed.success) return { error: 'unavailable' };
      const { clerkUserId, handle, tier, runtimeSlot } = parsed.data;

      // Cheap idempotency check before probing hosts; the claim re-checks under the lock.
      const existing = await getActiveUserMachineByClerkId(db, clerkUserId, runtimeSlot);
      if (existing && (existing.substrate !== 'metal' || existing.status !== 'failed')) {
        return existing.substrate === 'metal' ? { machineId: existing.machineId } : { error: 'unavailable' };
      }

      const shape = METAL_VM_SHAPES[tier];
      const placement = await place(shape.bootMiB);
      if ('error' in placement) return placement;
      const { host } = placement;

      const at = now();
      const machineId = machineIdFactory();
      const registration = tokenFactory(at, config.registrationTokenTtlMs);
      const rendered = await renderUserData({ machineId, clerkUserId, handle, runtimeSlot, registration });
      if (!rendered) return { error: 'unavailable' };

      const claim = await claimSlot({
        machineId, clerkUserId, handle, runtimeSlot, host, imageVersion: rendered.imageVersion, bundleSha256: rendered.bundleSha256, registration, at,
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
        if (!row.metal_host_id) continue;
        const metalHostId = row.metal_host_id;
        const changed = await runInPlatformTransaction(db, async (trx) => {
          const updated = await trx.executor.updateTable('user_machines')
            .set({ status: 'failed', failure_code: 'registration_timeout', failure_at: at.toISOString() })
            .where('machine_id', '=', row.machine_id)
            .where('status', '=', 'provisioning')
            .where('deleted_at', 'is', null)
            .returning('machine_id')
            .executeTakeFirst();
          if (!updated) return false;
          await enqueueMetalVmDeletion(trx, {
            metalHostId,
            machineId: row.machine_id,
            generation: row.generation,
            metalVmId: row.metal_vm_id,
            reason: 'registration_timeout',
            now: at,
          });
          return true;
        });
        if (changed) failed += 1;
      }
      return { failed };
    },
  };
}

export type MetalProvisioner = ReturnType<typeof createMetalProvisioner>;
