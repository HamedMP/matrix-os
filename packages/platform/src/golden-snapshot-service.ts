import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import type { HetznerClient, HetznerServer } from './customer-vps-hetzner.js';
import {
  CustomerVpsError,
  DefinitiveProviderRejectionError,
} from './customer-vps-errors.js';
import {
  appendGoldenSnapshotAuditEvent,
  getGoldenSnapshot,
  getGoldenSnapshotBuild,
  recordGoldenSnapshotProviderImage,
  reserveGoldenSnapshotValidationCreate,
} from './golden-snapshot-repository.js';
import {
  GoldenSnapshotRuntimeConfigSchema,
  GoldenSnapshotBundleVersionSchema,
  GoldenSnapshotValidationSummarySchema,
  type GoldenSnapshotRuntimeConfig,
} from './golden-snapshot-schema.js';
import { createGoldenSnapshotBuildOperations } from './golden-snapshot-build-operations.js';
import { createGoldenSnapshotCallbackHandler, GoldenSnapshotCallbackError } from './golden-snapshot-callback.js';
import {
  addMilliseconds,
  callbackPayloadDigest,
  callbackReplayStatus,
  exactLabels,
  hashToken,
  UuidSchema,
  isExactBuildServer,
  providerFailure,
  recordCallbackReceipt,
  replaceTemplate,
  tokenMatches,
  validationEvidenceFailureCode,
} from './golden-snapshot-service-helpers.js';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CleanupProviderResourceIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SystemdStateSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:@-]+$/);
export const GoldenSnapshotServiceDiagnosticsSchema = z.object({
  unit: z.enum([
    'matrix-terminal-runtime.service',
    'matrix-gateway.service',
    'matrix-shell.service',
    'matrix-sync-agent.service',
  ]),
  loadState: SystemdStateSchema,
  activeState: SystemdStateSchema,
  subState: SystemdStateSchema,
  result: SystemdStateSchema,
  conditionResult: z.boolean().nullable(),
  execMainCode: SystemdStateSchema,
  execMainStatus: z.number().int().nonnegative().max(2 ** 31 - 1),
  nRestarts: z.number().int().nonnegative().max(10_000),
  journalTail: z.array(z.string().max(512)).max(40),
}).strict();
const GoldenSnapshotCallbackOutcomeSchema = z.object({
  accepted: z.literal(true),
  serviceDiagnostics: GoldenSnapshotServiceDiagnosticsSchema.optional(),
}).passthrough();

export function readGoldenSnapshotServiceDiagnosticsForOperator(input: unknown) {
  const diagnostics = GoldenSnapshotCallbackOutcomeSchema.safeParse(input).data?.serviceDiagnostics;
  if (!diagnostics) return undefined;
  const { journalTail: _journalTail, ...coarseDiagnostics } = diagnostics;
  return coarseDiagnostics;
}

export function normalizeCleanupProviderResourceId(input: unknown): number {
  return CleanupProviderResourceIdSchema.parse(input);
}
const GoldenSnapshotFailureStageSchema = z.enum([
  'bundle_download',
  'bundle_verify',
  'bundle_extract',
  'host_prerequisites',
  'identity_regeneration',
  'activation',
  'activation_preflight_evidence',
  'activation_preflight_forbidden_state',
  'activation_preflight_host_prerequisites',
  'activation_preflight_user_state',
  'activation_preflight_runtime_state',
  'activation_preflight_owner_state',
  'activation_preflight_root_ssh_state',
  'activation_preflight_root_local_state',
  'activation_preflight_log_state',
  'activation_preflight_cloud_init',
  'activation_preflight_container_state',
  'activation_runtime_setup',
  'activation_terminal_runtime',
  'activation_docker_start',
  'activation_postgres_pull',
  'activation_postgres_start',
  'activation_postgres_ready',
  'activation_services_start',
  'activation_services_ready',
  'activation_terminal_runtime_ready',
  'activation_gateway_ready',
  'activation_shell_ready',
  'activation_sync_agent_ready',
  'activation_gateway_health',
  'validation_check_exact_bundle',
  'validation_check_health',
  'validation_check_fresh_activation',
  'validation_check_machine_id',
  'validation_check_ssh_host_key',
  'validation_check_forbidden_state',
  'cloud_final_wait',
  'service_shutdown',
  'finalizer_timeout',
  'sanitization',
  'sanitization_callback_material',
  'sanitization_root_device',
  'sanitization_free_blocks',
  'sanitization_residue',
  'sanitization_scan_execution',
  'checks',
  'callback_delivery',
]);
export const GoldenSnapshotCallbackSchema = z.discriminatedUnion('phase', [
  z.object({
    eventId: UuidSchema,
    phase: z.literal('builder_booted'),
    bundleVersion: GoldenSnapshotBundleVersionSchema,
    bundleSha256: Sha256Schema,
    builderMachineIdSha256: Sha256Schema,
    builderSshHostKeySha256: Sha256Schema,
    healthy: z.boolean(),
  }).strict(),
  z.object({
    eventId: UuidSchema,
    phase: z.literal('sanitized'),
    bundleVersion: GoldenSnapshotBundleVersionSchema,
    bundleSha256: Sha256Schema,
    builderMachineIdSha256: Sha256Schema,
    builderSshHostKeySha256: Sha256Schema,
  }).strict(),
  z.object({
    eventId: UuidSchema,
    phase: z.literal('validated'),
    bundleVersion: GoldenSnapshotBundleVersionSchema,
    bundleSha256: Sha256Schema,
    validationMachineIdSha256: Sha256Schema,
    validationSshHostKeySha256: Sha256Schema,
    evidence: z.object({
      exactBundle: z.boolean(),
      healthy: z.boolean(),
      freshActivation: z.boolean(),
      uniqueMachineId: z.boolean(),
      uniqueSshHostKey: z.boolean(),
      forbiddenStateAbsent: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    eventId: UuidSchema,
    phase: z.literal('failed'),
    role: z.enum(['builder', 'validation']),
    stage: GoldenSnapshotFailureStageSchema,
    bundleVersion: GoldenSnapshotBundleVersionSchema,
    bundleSha256: Sha256Schema,
    serviceDiagnostics: GoldenSnapshotServiceDiagnosticsSchema.optional(),
  }).strict(),
]);

const GRACEFUL_SHUTDOWN_DEADLINE_MS = 2 * 60 * 1000;

// Extraction plan: keep createGoldenSnapshotService as the orchestration facade, then move
// provider create/adoption recovery, callback confirmation, and cleanup reconciliation into
// focused modules after this stacked feature lands. Keeping that boundary explicit here avoids
// mixing a large mechanical split into the snapshot state-machine review.

export type GoldenSnapshotCallback = z.input<typeof GoldenSnapshotCallbackSchema>;
export { GoldenSnapshotCallbackError };

export interface GoldenSnapshotServiceDeps {
  db: PlatformDB;
  config: GoldenSnapshotRuntimeConfig;
  hetzner: HetznerClient;
  builderCloudInitTemplate: string;
  bundleBaseUrl: string;
  callbackBaseUrl: string;
  tokenFactory: () => string;
  now?: () => string;
}

export interface GoldenSnapshotService {
  runBuildStep(buildId: string): Promise<string>;
  runOrphanReconciliationStep(buildId: string): Promise<'queued' | 'pending' | 'absent'>;
  runCleanupStep(cleanupId: string): Promise<'deleted' | 'pending' | 'quarantined'>;
  consumeCallback(buildId: string, token: string, payload: GoldenSnapshotCallback): Promise<void>;
}



export function createGoldenSnapshotService(rawDeps: GoldenSnapshotServiceDeps): GoldenSnapshotService {
  const config = GoldenSnapshotRuntimeConfigSchema.parse(rawDeps.config);
  const deps = { ...rawDeps, config };
  const now = deps.now ?? (() => new Date().toISOString());
  const buildServerType = config.serverType
    ?? (config.compatibility.architecture === 'arm' ? 'cax11' : 'cx23');

  const ops = createGoldenSnapshotBuildOperations({
    db: deps.db,
    hetzner: deps.hetzner,
    config,
    tokenFactory: deps.tokenFactory,
    callbackBaseUrl: deps.callbackBaseUrl,
    buildServerType,
  });

  const callbackHandler = createGoldenSnapshotCallbackHandler({
    db: deps.db,
    hetzner: deps.hetzner,
    config,
    now,
    ops,
  });


  async function runOrphanReconciliationStep(
    rawBuildId: string,
  ): Promise<'queued' | 'pending' | 'absent'> {
    const buildId = UuidSchema.parse(rawBuildId);
    const at = now();
    const { build, snapshot } = await ops.load(buildId);
    if (build.status !== 'failed' || snapshot.state !== 'quarantined' || build.pendingOperation === null) {
      throw new Error('Golden snapshot orphan reconciliation is not pending');
    }
    if (build.pendingOperation.startsWith('snapshot:')) {
      if (build.pendingOperation !== `snapshot:${snapshot.snapshotId}`) {
        throw new Error('Golden snapshot image orphan provenance is invalid');
      }
      if (!deps.hetzner.listImagesByLabel) {
        throw new Error('Golden snapshot image orphan discovery is unavailable');
      }
      const matches = await deps.hetzner.listImagesByLabel(
        `matrix.snapshot-build=${buildId},matrix.snapshot-id=${snapshot.snapshotId}`,
      );
      const exact = matches.filter((image) =>
        image.labels['matrix.snapshot-build'] === buildId
        && image.labels['matrix.snapshot-id'] === snapshot.snapshotId
        && image.labels['matrix.role'] === 'builder');
      if (exact.length === 0) {
        if (build.callbackExpiresAt !== null && build.callbackExpiresAt <= at) {
          await deps.db.executor.updateTable('golden_snapshot_builds').set({
            pending_operation: null, callback_expires_at: null,
            last_error_code: 'snapshot_create_absence_confirmed', updated_at: at,
          }).where('build_id', '=', buildId).where('status', '=', 'failed')
            .where('pending_operation', '=', build.pendingOperation).execute();
          return 'absent';
        }
        await deps.db.executor.updateTable('golden_snapshot_builds').set({ updated_at: at })
          .where('build_id', '=', buildId).where('status', '=', 'failed')
          .where('pending_operation', '=', build.pendingOperation).execute();
        return 'pending';
      }
      await deps.db.transaction(async (trx) => {
        const active = await trx.executor.selectFrom('golden_snapshot_builds').select('pending_operation')
          .where('build_id', '=', buildId).where('status', '=', 'failed').forUpdate().executeTakeFirst();
        if (!active || active.pending_operation !== build.pendingOperation) return;
        for (const image of exact) {
          await trx.executor.insertInto('golden_snapshot_cleanup').values({
            cleanup_id: randomUUID(), snapshot_id: snapshot.snapshotId, build_id: buildId,
            resource_type: 'snapshot_image', provider_resource_id: image.id,
            provenance_key: `snapshot:${snapshot.snapshotId}`,
            reason: 'snapshot_create_unresolved', status: 'queued', attempts: 0,
            next_attempt_at: at, lease_expires_at: null, last_error_code: null,
            created_at: at, completed_at: null,
          }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
            .where('completed_at', 'is', null).doNothing()).execute();
        }
        await trx.executor.updateTable('golden_snapshot_builds').set({
          pending_operation: null, callback_expires_at: null, updated_at: at,
        }).where('build_id', '=', buildId).where('pending_operation', '=', build.pendingOperation).execute();
      });
      return 'queued';
    }
    const role = build.pendingOperation.startsWith('builder:')
      ? 'builder'
      : build.pendingOperation.startsWith('validation:')
        ? 'validation'
        : undefined;
    if (!role) throw new Error('Golden snapshot orphan provenance is invalid');
    const validationOrdinal = role === 'validation'
      ? Number(build.pendingOperation.split(':').at(-1))
      : undefined;
    if (role === 'validation' && validationOrdinal !== 1 && validationOrdinal !== 2) {
      throw new Error('Golden snapshot validation orphan provenance is invalid');
    }
    if (!deps.hetzner.listServersByLabel) throw new Error('Golden snapshot orphan discovery is unavailable');
    const matches = await deps.hetzner.listServersByLabel(
      `matrix.snapshot-build=${buildId},matrix.role=${role}`,
    );
    const exact = matches.filter((server) => {
      const labels = server.labels ?? {};
      return labels['matrix.snapshot-build'] === buildId
        && labels['matrix.snapshot-id'] === snapshot.snapshotId
        && labels['matrix.role'] === role
        && (role !== 'validation' || labels['matrix.validation-ordinal'] === String(validationOrdinal));
    });
    if (exact.length === 0) {
      if (build.callbackExpiresAt !== null && build.callbackExpiresAt <= at) {
        await deps.db.executor.updateTable('golden_snapshot_builds').set({
          pending_operation: null, callback_expires_at: null,
          last_error_code: `${role}_create_absence_confirmed`, updated_at: at,
        }).where('build_id', '=', buildId).where('status', '=', 'failed')
          .where('pending_operation', '=', build.pendingOperation).execute();
        return 'absent';
      }
      await deps.db.executor.updateTable('golden_snapshot_builds').set({ updated_at: at })
        .where('build_id', '=', buildId).where('status', '=', 'failed')
        .where('pending_operation', '=', build.pendingOperation).execute();
      return 'pending';
    }
    await deps.db.transaction(async (trx) => {
      const active = await trx.executor.selectFrom('golden_snapshot_builds').select('pending_operation')
        .where('build_id', '=', buildId).where('status', '=', 'failed').forUpdate().executeTakeFirst();
      if (!active || active.pending_operation !== build.pendingOperation) return;
      for (const server of exact) {
        await trx.executor.insertInto('golden_snapshot_cleanup').values({
          cleanup_id: randomUUID(), snapshot_id: snapshot.snapshotId, build_id: buildId,
          resource_type: role === 'builder' ? 'builder_server' : 'validation_server',
          provider_resource_id: server.id,
          provenance_key: `build:${buildId}:${role}_server`,
          reason: `${role}_create_unresolved`, status: 'queued', attempts: 0,
          next_attempt_at: at, lease_expires_at: null, last_error_code: null,
          created_at: at, completed_at: null,
        }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
          .where('completed_at', 'is', null).doNothing()).execute();
      }
      await trx.executor.updateTable('golden_snapshot_builds').set({
        pending_operation: null, callback_expires_at: null, updated_at: at,
      }).where('build_id', '=', buildId).where('pending_operation', '=', build.pendingOperation).execute();
    });
    return 'queued';
  }

  async function runBuildStep(rawBuildId: string): Promise<string> {
    const buildId = UuidSchema.parse(rawBuildId);
    if (!config.buildsEnabled) throw new Error('Golden snapshot builds are disabled');
    const at = now();
    const { build, snapshot, release } = await ops.load(buildId);
    if (build.status !== 'running') throw new Error('Golden snapshot build is not claimed');

    if (build.phase === 'requested') {
      const callbackToken = deps.tokenFactory();
      const callbackEventId = randomUUID();
      const builderBootEventId = randomUUID();
      const callbackHash = hashToken(callbackToken);
      const changed = await deps.db.transaction(async (trx) => {
        const buildRow = await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'builder_create', pending_operation: `builder:${buildId}`,
          callback_phase: 'sanitized', callback_token_hash: callbackHash,
          callback_expires_at: addMilliseconds(at, deps.config.callbackDeadlineMs), updated_at: at,
        }).where('build_id', '=', buildId).where('phase', '=', 'requested').where('status', '=', 'running')
          .returning('build_id').executeTakeFirst();
        if (!buildRow) return false;
        const snapshotRow = await trx.executor.updateTable('golden_snapshots').set({
          state: 'building', updated_at: at, revision: sql<number>`revision + 1`,
        }).where('snapshot_id', '=', snapshot.snapshotId).where('state', '=', 'candidate')
          .returning('snapshot_id').executeTakeFirst();
        if (!snapshotRow) throw new Error('Golden snapshot candidate transition failed');
        return true;
      });
      if (!changed) return 'builder_create';
      const userData = replaceTemplate(deps.builderCloudInitTemplate, {
        bundleVersion: snapshot.bundleVersion,
        bundleSha256: snapshot.bundleSha256,
        bundleUrl: `${deps.bundleBaseUrl.replace(/\/$/, '')}/${release.bundle_key}`,
        callbackToken,
        callbackEventId,
        builderBootEventId,
        callbackUrl: `${deps.callbackBaseUrl.replace(/\/$/, '')}/system-bundles/snapshot-builds/${buildId}/callback`,
      });
      try {
        const server = await deps.hetzner.createServer({
          name: `matrix-golden-${buildId.slice(0, 8)}`,
          userData,
          labels: exactLabels(buildId, snapshot.snapshotId, 'builder'),
          image: snapshot.compatibility.baseImage,
          serverType: buildServerType,
          sshKeys: [],
        });
        await ops.persistCreatedBuilder(buildId, server, at);
        return 'builder_boot';
      } catch (err: unknown) {
        return ops.handleDefinitiveServerCreateFailure(
          buildId, snapshot.snapshotId, 'builder', build.attempts, at, err,
        );
      }
    }

    if (build.phase === 'builder_create') {
      try {
        const adopted = await ops.adoptServer(buildId, snapshot.snapshotId, 'builder', at);
        if (adopted) return 'builder_boot';
        if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await ops.quarantine(buildId, snapshot.snapshotId, 'builder_create_unresolved', at, build.phase);
          throw new Error('Golden snapshot builder recovery window expired');
        }
        return 'builder_create';
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'Golden snapshot builder recovery window expired') throw err;
        throw providerFailure('builder reconciliation', err);
      }
    }

    if (build.phase === 'builder_boot' || build.phase === 'validation_boot') {
      if (!build.callbackExpiresAt || build.callbackExpiresAt <= at) {
        await ops.quarantine(buildId, snapshot.snapshotId, 'callback_timeout', at, build.phase);
        throw new Error('Golden snapshot callback timed out');
      }
      return build.phase;
    }

    if (build.phase === 'snapshot_create') {
      if (build.providerBuilderId === null) throw new Error('Golden snapshot builder identity missing');
      const server = await deps.hetzner.getServer(build.providerBuilderId);
      if (!server) {
        await ops.quarantine(buildId, snapshot.snapshotId, 'builder_missing', at, build.phase);
        throw new Error('Golden snapshot builder is missing');
      }
      if (server.status !== 'off') {
        const gracefulStartedAt = build.pendingOperation?.startsWith('shutdown:')
          ? build.pendingOperation.slice('shutdown:'.length)
          : undefined;
        const powerOffStartedAt = build.pendingOperation?.startsWith('poweroff:')
          ? build.pendingOperation.slice('poweroff:'.length)
          : undefined;
        if (powerOffStartedAt) {
          if (new Date(at).getTime() - new Date(powerOffStartedAt).getTime() >= GRACEFUL_SHUTDOWN_DEADLINE_MS) {
            await ops.quarantine(buildId, snapshot.snapshotId, 'builder_shutdown_timeout', at, build.phase);
            throw new Error('Golden snapshot builder shutdown timed out');
          }
        } else if (gracefulStartedAt
          && new Date(at).getTime() - new Date(gracefulStartedAt).getTime() >= GRACEFUL_SHUTDOWN_DEADLINE_MS) {
          await deps.hetzner.powerOffServer(server.id);
          await deps.db.executor.updateTable('golden_snapshot_builds').set({
            pending_operation: `poweroff:${at}`, updated_at: at,
          }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_create').execute();
        } else {
          await deps.hetzner.shutdownServer(server.id);
          if (!gracefulStartedAt) {
            await deps.db.executor.updateTable('golden_snapshot_builds').set({
              pending_operation: `shutdown:${at}`, updated_at: at,
            }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_create').execute();
          }
        }
        return 'snapshot_create';
      }
      const armed = await deps.db.executor.updateTable('golden_snapshot_builds').set({
        phase: 'snapshot_wait', pending_operation: `snapshot:${snapshot.snapshotId}`,
        callback_expires_at: addMilliseconds(at, deps.config.callbackDeadlineMs), updated_at: at,
      }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_create')
        .returning('build_id').executeTakeFirst();
      if (!armed) return 'snapshot_wait';
      let created: Awaited<ReturnType<HetznerClient['createSnapshot']>>;
      try {
        created = await deps.hetzner.createSnapshot(server.id, {
          description: `Matrix OS ${snapshot.bundleVersion} golden snapshot`,
          labels: exactLabels(buildId, snapshot.snapshotId, 'builder'),
        });
      } catch (err: unknown) {
        if (err instanceof CustomerVpsError && err.code === 'quota_exceeded') {
          await deps.db.executor.updateTable('golden_snapshot_builds').set({
            phase: 'snapshot_create', pending_operation: null, callback_expires_at: null,
            updated_at: at,
          }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_wait')
            .where('provider_snapshot_action_id', 'is', null).execute();
          throw new CustomerVpsError(
            err.status,
            'snapshot_quota_exceeded',
            'Snapshot capacity unavailable',
          );
        }
        throw providerFailure('snapshot create', err);
      }
      if (created.image.status === 'deleting') {
        await ops.quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, 'snapshot_wait');
        throw new Error('Golden snapshot image validation failed');
      }
      if (!build.leaseExpiresAt || !await recordGoldenSnapshotProviderImage(
        deps.db,
        snapshot.snapshotId,
        {
          buildId,
          expectedLeaseExpiresAt: build.leaseExpiresAt,
          providerSnapshotActionId: created.action.id,
          providerImageId: created.image.id,
          providerImageStatus: created.image.status,
          imageDiskGb: created.image.diskGb,
          imageArchitecture: created.image.architecture,
          now: at,
        },
      )) throw new Error('Golden snapshot build lease lost after image creation');
      return 'snapshot_wait';
    }

    if (build.phase === 'snapshot_wait') {
      const observeDeadline = (): { expired: boolean; observedAt: string } => {
        const observedAt = now();
        return {
          expired: !build.callbackExpiresAt || build.callbackExpiresAt <= observedAt,
          observedAt,
        };
      };
      const readProviderState = async <T>(
        context: string,
        read: () => Promise<T>,
        expiredFailure: { code: string; message: string } = {
          code: 'snapshot_creation_timeout',
          message: 'Golden snapshot creation timed out',
        },
      ): Promise<T> => {
        try {
          return await read();
        } catch (err: unknown) {
          const deadline = observeDeadline();
          if (deadline.expired) {
            await ops.quarantine(
              buildId,
              snapshot.snapshotId,
              expiredFailure.code,
              deadline.observedAt,
              build.phase,
            );
            throw new Error(expiredFailure.message);
          }
          throw providerFailure(context, err);
        }
      };
      const providerImageId = snapshot.providerImageId;
      const providerSnapshotActionId = build.providerSnapshotActionId;
      let image = providerImageId === null
        ? null
        : await readProviderState(
          'snapshot image confirmation',
          () => deps.hetzner.getImage(providerImageId),
        );
      const action = providerSnapshotActionId === null
        ? null
        : await readProviderState(
          'snapshot action confirmation',
          () => deps.hetzner.getAction(providerSnapshotActionId),
        );
      if (snapshot.providerImageId === null) {
        const selector = `matrix.snapshot-build=${buildId},matrix.snapshot-id=${snapshot.snapshotId}`;
        const candidates = (await readProviderState(
          'snapshot image reconciliation',
          () => deps.hetzner.listImagesByLabel(selector),
          {
            code: 'snapshot_create_unresolved',
            message: 'Golden snapshot image recovery window expired',
          },
        )).filter((candidate) => candidate.labels['matrix.snapshot-build'] === buildId
          && candidate.labels['matrix.snapshot-id'] === snapshot.snapshotId
          && candidate.labels['matrix.role'] === 'builder');
        if (candidates.length > 1) {
          await ops.quarantine(buildId, snapshot.snapshotId, 'snapshot_create_ambiguous', at, build.phase);
          throw new Error('Golden snapshot image reconciliation was ambiguous');
        }
        image = candidates[0] ?? null;
        if (image) {
          if (image.status === 'deleting') {
            await ops.quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
            throw new Error('Golden snapshot image validation failed');
          }
          if (!build.leaseExpiresAt || !await recordGoldenSnapshotProviderImage(
            deps.db,
            snapshot.snapshotId,
            {
              buildId,
              expectedLeaseExpiresAt: build.leaseExpiresAt,
              providerImageId: image.id,
              providerImageStatus: image.status,
              imageDiskGb: image.diskGb,
              imageArchitecture: image.architecture,
              now: at,
            },
          )) throw new Error('Golden snapshot build lease lost during image adoption');
        } else {
          const deadline = observeDeadline();
          if (deadline.expired) {
            await ops.quarantine(
              buildId,
              snapshot.snapshotId,
              'snapshot_create_unresolved',
              deadline.observedAt,
              build.phase,
            );
            throw new Error('Golden snapshot image recovery window expired');
          }
          return 'snapshot_wait';
        }
      }
      if (image?.status === 'deleting') {
        await ops.quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
        throw new Error('Golden snapshot image validation failed');
      }
      if (!image || action?.status === 'error') {
        await ops.quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
        throw new Error('Golden snapshot image validation failed');
      }
      if (action === null && (build.providerSnapshotActionId !== null || image.status !== 'available')) {
        const deadline = observeDeadline();
        if (deadline.expired) {
          await ops.quarantine(
            buildId,
            snapshot.snapshotId,
            'snapshot_action_unconfirmed',
            deadline.observedAt,
            build.phase,
          );
          throw new Error('Golden snapshot action confirmation timed out');
        }
        return 'snapshot_wait';
      }
      if (image.status !== 'available' || (action !== null && action.status !== 'success')) {
        const deadline = observeDeadline();
        if (deadline.expired) {
          await ops.quarantine(
            buildId,
            snapshot.snapshotId,
            'snapshot_creation_timeout',
            deadline.observedAt,
            build.phase,
          );
          throw new Error('Golden snapshot creation timed out');
        }
        return 'snapshot_wait';
      }
      if (image.architecture !== snapshot.compatibility.architecture || image.deleteProtected) {
        await ops.quarantine(buildId, snapshot.snapshotId, 'image_incompatible', at, build.phase);
        throw new Error('Golden snapshot image compatibility validation failed');
      }
      if (!build.builderMachineIdSha256 || !build.builderSshHostKeySha256) {
        await ops.quarantine(buildId, snapshot.snapshotId, 'builder_identity_missing', at, build.phase);
        throw new Error('Golden snapshot builder identity evidence missing');
      }
      const builderCleanupId = await deps.db.transaction(async (trx) => {
        const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds')
          .select('provider_builder_id').where('build_id', '=', buildId)
          .where('phase', '=', 'snapshot_wait').forUpdate().executeTakeFirst();
        if (!currentBuild) return undefined;
        await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'validation_create', pending_operation: null,
          callback_phase: null, callback_token_hash: null,
          callback_expires_at: null, updated_at: at,
        }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_wait')
          .executeTakeFirstOrThrow();
        if (currentBuild.provider_builder_id !== null) {
          const cleanupId = randomUUID();
          const inserted = await trx.executor.insertInto('golden_snapshot_cleanup').values({
            cleanup_id: cleanupId, snapshot_id: snapshot.snapshotId, build_id: buildId,
            resource_type: 'builder_server', provider_resource_id: currentBuild.provider_builder_id,
            provenance_key: `build:${buildId}:builder_server`, reason: 'snapshot_image_available',
            status: 'queued', attempts: 0, next_attempt_at: at, lease_expires_at: null,
            last_error_code: null, created_at: at, completed_at: null,
          }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
            .where('completed_at', 'is', null).doNothing())
            .returning('cleanup_id').executeTakeFirst();
          if (inserted) return inserted.cleanup_id;
          const existing = await trx.executor.selectFrom('golden_snapshot_cleanup')
            .select('cleanup_id').where('resource_type', '=', 'builder_server')
            .where('provider_resource_id', '=', currentBuild.provider_builder_id)
            .where('completed_at', 'is', null).executeTakeFirstOrThrow();
          return existing.cleanup_id;
        }
        return null;
      });
      if (builderCleanupId === undefined) return 'validation_create';
      if (builderCleanupId !== null) {
        const cleanupResult = await runCleanupStep(builderCleanupId);
        if (cleanupResult === 'pending') return 'validation_create';
        if (cleanupResult === 'quarantined') {
          await ops.quarantine(buildId, snapshot.snapshotId, 'builder_cleanup_unsafe', at, 'validation_create');
          throw new Error('Golden snapshot builder cleanup was unsafe');
        }
      }
      return ops.createValidationClone({
        buildId, snapshotId: snapshot.snapshotId, imageId: image.id,
        bundleVersion: snapshot.bundleVersion, bundleSha256: snapshot.bundleSha256,
        builderMachineIdSha256: build.builderMachineIdSha256,
        builderSshHostKeySha256: build.builderSshHostKeySha256,
        validationOrdinal: build.validationCloneOrdinal, attempts: build.attempts, at,
      });
    }

    if (build.phase === 'validation_create') {
      if (build.providerBuilderId !== null) {
        const cleanup = await deps.db.executor.selectFrom('golden_snapshot_cleanup')
          .select(['cleanup_id', 'status'])
          .where('build_id', '=', buildId)
          .where('resource_type', '=', 'builder_server')
          .where('provider_resource_id', '=', build.providerBuilderId)
          .where('completed_at', 'is', null)
          .executeTakeFirst();
        const refreshedBuild = cleanup ? undefined : await getGoldenSnapshotBuild(deps.db, buildId);
        const cleanupUnsafe = cleanup
          ? !['queued', 'running'].includes(cleanup.status)
          : !refreshedBuild || refreshedBuild.providerBuilderId !== null;
        if (cleanupUnsafe) {
          await ops.quarantine(buildId, snapshot.snapshotId, 'builder_cleanup_unsafe', at, build.phase);
          throw new Error('Golden snapshot builder cleanup was unsafe');
        }
        return 'validation_create';
      }
      if (build.callbackTokenHash === null) {
        if (snapshot.providerImageId === null || !build.builderMachineIdSha256 || !build.builderSshHostKeySha256) {
          await ops.quarantine(buildId, snapshot.snapshotId, 'validation_provenance_missing', at, build.phase);
          throw new Error('Golden snapshot validation provenance missing');
        }
        return ops.createValidationClone({
          buildId, snapshotId: snapshot.snapshotId, imageId: snapshot.providerImageId,
          bundleVersion: snapshot.bundleVersion, bundleSha256: snapshot.bundleSha256,
          builderMachineIdSha256: build.builderMachineIdSha256,
          builderSshHostKeySha256: build.builderSshHostKeySha256,
          validationOrdinal: build.validationCloneOrdinal, attempts: build.attempts, at,
        });
      }
      try {
        const adopted = await ops.adoptServer(
          buildId, snapshot.snapshotId, 'validation', at, build.validationCloneOrdinal,
        );
        if (adopted) return 'validation_boot';
        if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await ops.quarantine(buildId, snapshot.snapshotId, 'validation_create_unresolved', at, build.phase);
          throw new Error('Golden snapshot validation recovery window expired');
        }
        return 'validation_create';
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'Golden snapshot validation recovery window expired') throw err;
        throw providerFailure('validation reconciliation', err);
      }
    }

    return build.phase;
  }

  async function runCleanupStep(rawCleanupId: string): Promise<'deleted' | 'pending' | 'quarantined'> {
    const cleanupId = UuidSchema.parse(rawCleanupId);
    const at = now();
    const leaseExpiresAt = addMilliseconds(at, config.buildLeaseMs);
    const exhausted = await deps.db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'quarantined', lease_expires_at: null, last_error_code: 'retry_budget_exhausted',
    }).where('cleanup_id', '=', cleanupId).where('status', '=', 'running')
      .where('attempts', '>=', config.maxBuildAttempts).where('lease_expires_at', '<=', at)
      .returning('cleanup_id').executeTakeFirst();
    if (exhausted) return 'quarantined';
    const rawCleanup = await deps.db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'running', attempts: sql<number>`attempts + 1`, lease_expires_at: leaseExpiresAt,
      last_error_code: null,
    }).where('cleanup_id', '=', cleanupId).where('attempts', '<', config.maxBuildAttempts)
      .where((eb) => eb.or([
        eb('status', '=', 'queued'),
        eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', at)]),
      ])).returningAll().executeTakeFirst();
    if (!rawCleanup) return 'pending';
    // PostgreSQL BIGINT values are strings in the node-postgres driver. Normalize
    // before the provider boundary so exact-ID cleanup does not fail schema
    // validation and strand the image after its retry budget is exhausted.
    const cleanup = {
      ...rawCleanup,
      provider_resource_id: normalizeCleanupProviderResourceId(rawCleanup.provider_resource_id),
    };
    const build = cleanup.build_id
      ? await getGoldenSnapshotBuild(deps.db, cleanup.build_id)
      : undefined;
    const snapshot = cleanup.snapshot_id
      ? await getGoldenSnapshot(deps.db, cleanup.snapshot_id)
      : undefined;
    const complete = async () => {
      await deps.db.transaction(async (trx) => {
        if (cleanup.resource_type === 'snapshot_image' && snapshot?.state === 'retiring') {
          await trx.executor.updateTable('golden_snapshots').set({
            state: 'deleted', deleted_at: at, updated_at: at, revision: sql<number>`revision + 1`,
          }).where('snapshot_id', '=', snapshot.snapshotId).where('state', '=', 'retiring').executeTakeFirstOrThrow();
        }
        if (cleanup.resource_type === 'builder_server' && cleanup.build_id !== null) {
          await trx.executor.updateTable('golden_snapshot_builds').set({
            provider_builder_id: null, provider_builder_action_id: null, updated_at: at,
          }).where('build_id', '=', cleanup.build_id)
            .where('provider_builder_id', '=', cleanup.provider_resource_id).execute();
        }
        await trx.executor.updateTable('golden_snapshot_cleanup').set({
          status: 'completed', completed_at: at, lease_expires_at: null,
        }).where('cleanup_id', '=', cleanupId).where('status', '=', 'running').executeTakeFirstOrThrow();
      });
      return 'deleted' as const;
    };
    const quarantineCleanup = async () => {
      await deps.db.executor.updateTable('golden_snapshot_cleanup').set({
        status: 'quarantined', lease_expires_at: null, last_error_code: 'provenance_mismatch',
      }).where('cleanup_id', '=', cleanupId).where('status', '=', 'running').execute();
      return 'quarantined' as const;
    };
    const retry = async (code: string) => {
      const exhausted = cleanup.attempts >= config.maxBuildAttempts;
      await deps.db.executor.updateTable('golden_snapshot_cleanup').set({
        status: exhausted ? 'quarantined' : 'queued', lease_expires_at: null, last_error_code: code,
        next_attempt_at: addMilliseconds(at, 60_000),
      }).where('cleanup_id', '=', cleanupId).where('status', '=', 'running').execute();
      return 'pending' as const;
    };

    try {
      if (cleanup.resource_type === 'snapshot_image') {
        const imageWasAdopted = snapshot?.providerImageId === cleanup.provider_resource_id
          && ['sanitizing', 'validating', 'ready'].includes(snapshot.state);
        if (imageWasAdopted) return quarantineCleanup();
        const image = await deps.hetzner.getImage(cleanup.provider_resource_id);
        if (!image) return complete();
        const snapshotScoped = snapshot !== undefined
          && cleanup.provenance_key === `snapshot:${snapshot.snapshotId}`;
        if (!snapshot || image.deleteProtected
          || image.labels['matrix.snapshot-id'] !== snapshot.snapshotId
          || (!snapshotScoped && (!build || image.labels['matrix.snapshot-build'] !== build.buildId))) {
          return quarantineCleanup();
        }
        await deps.hetzner.deleteImage(image.id);
        return await deps.hetzner.getImage(image.id) === null ? complete() : retry('delete_pending');
      }

      const server = await deps.hetzner.getServer(cleanup.provider_resource_id);
      if (!server) return complete();
      const role = cleanup.resource_type === 'builder_server' ? 'builder' : 'validation';
      if (!build || !snapshot
        || server.labels?.['matrix.snapshot-build'] !== build.buildId
        || server.labels?.['matrix.snapshot-id'] !== snapshot.snapshotId
        || server.labels?.['matrix.role'] !== role) return quarantineCleanup();
      await deps.hetzner.deleteServer(server.id);
      return await deps.hetzner.getServer(server.id) === null ? complete() : retry('delete_pending');
    } catch (err: unknown) {
      await retry('provider_unavailable');
      throw providerFailure('cleanup', err);
    }
  }

  return { runBuildStep, runOrphanReconciliationStep, runCleanupStep, consumeCallback: callbackHandler.consumeCallback };
}