/**
 * Golden snapshot build callback handler.
*
 * Extracted from ./golden-snapshot-service.ts (Phase 1-A4). Pure move: no logic changes.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import type { HetznerClient, HetznerServer } from './customer-vps-hetzner.js';
import type { createGoldenSnapshotBuildOperations } from './golden-snapshot-build-operations.js';
import type { GoldenSnapshotRuntimeConfig } from './golden-snapshot-schema.js';
import { GoldenSnapshotValidationSummarySchema } from './golden-snapshot-schema.js';
import type { GoldenSnapshotCallback } from './golden-snapshot-service.js';
// Value import from the service module: only used inside the handler body
// (post-evaluation), so the service<->callback cycle is safe.
import { GoldenSnapshotCallbackSchema } from './golden-snapshot-service.js';
import {
  addMilliseconds,
  callbackPayloadDigest,
  callbackReplayStatus,
  hashToken,
  UuidSchema,
  isExactBuildServer,
  providerFailure,
  recordCallbackReceipt,
  tokenMatches,
  validationEvidenceFailureCode,
} from './golden-snapshot-service-helpers.js';
import { appendGoldenSnapshotAuditEvent } from './golden-snapshot-repository.js';

export class GoldenSnapshotCallbackError extends Error {
  constructor(readonly code: 'unauthorized' | 'rejected') {
    super('Golden snapshot callback rejected');
    this.name = 'GoldenSnapshotCallbackError';
  }
}

export interface GoldenSnapshotCallbackHandlerDeps {
  db: PlatformDB;
  hetzner: HetznerClient;
  config: GoldenSnapshotRuntimeConfig;
  now: () => string;
  ops: ReturnType<typeof createGoldenSnapshotBuildOperations>;
}

export function createGoldenSnapshotCallbackHandler(
  handlerDeps: GoldenSnapshotCallbackHandlerDeps,
) {
  const deps = handlerDeps;
  const now = handlerDeps.now;
  async function consumeCallback(rawBuildId: string, rawToken: string, rawPayload: GoldenSnapshotCallback): Promise<void> {
    const buildId = UuidSchema.parse(rawBuildId);
    const token = z.string().min(16).max(512).parse(rawToken);
    const payload = GoldenSnapshotCallbackSchema.parse(rawPayload);
    const tokenDigest = hashToken(token);
    const payloadDigest = callbackPayloadDigest(payload);
    const at = now();
    let { build, snapshot } = await deps.ops.load(buildId);
    const replay = await callbackReplayStatus(deps.db, buildId, payload.eventId, token, payloadDigest);
    if (replay === 'accepted') return;
    if (replay === 'unauthorized') throw new GoldenSnapshotCallbackError('unauthorized');
    if (replay === 'conflict') throw new GoldenSnapshotCallbackError('rejected');
    const expectedCallbackPhase = payload.phase === 'failed'
      ? payload.role === 'builder' ? 'sanitized' : 'validated'
      : payload.phase === 'builder_booted' ? 'sanitized' : payload.phase;
    if (!build.callbackTokenHash || build.callbackPhase !== expectedCallbackPhase
      || !tokenMatches(token, build.callbackTokenHash)) {
      throw new GoldenSnapshotCallbackError('unauthorized');
    }
    if (!build.callbackExpiresAt || build.callbackExpiresAt <= at) {
      await deps.ops.quarantine(buildId, snapshot.snapshotId, 'callback_timeout', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (payload.bundleVersion !== snapshot.bundleVersion || payload.bundleSha256 !== snapshot.bundleSha256) {
      await deps.ops.quarantine(buildId, snapshot.snapshotId, 'provenance_mismatch', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }

    const reportedRole = payload.phase === 'failed'
      ? payload.role
      : payload.phase === 'sanitized' || payload.phase === 'builder_booted' ? 'builder' : 'validation';
    const earlyRole = reportedRole === 'builder' && build.phase === 'builder_create'
      ? 'builder'
      : reportedRole === 'validation' && build.phase === 'validation_create'
        ? 'validation'
        : undefined;
    if (earlyRole) {
      let adopted: HetznerServer | undefined;
      try {
        adopted = await deps.ops.adoptServer(
          buildId,
          snapshot.snapshotId,
          earlyRole,
          at,
          earlyRole === 'validation' ? build.validationCloneOrdinal : undefined,
        );
      } catch (err: unknown) {
        throw providerFailure(`${earlyRole} callback reconciliation`, err);
      }
      if (!adopted) throw new GoldenSnapshotCallbackError('rejected');
      ({ build, snapshot } = await deps.ops.load(buildId));
    }

    if (payload.phase !== 'failed') {
      const actionId = reportedRole === 'builder'
        ? build.providerBuilderActionId
        : build.providerValidationActionId;
      let action;
      try {
        action = actionId === null ? null : await deps.hetzner.getAction(actionId);
      } catch (err: unknown) {
        throw providerFailure(`${reportedRole} create action confirmation`, err);
      }
      if (action?.status === 'error') {
        await deps.ops.quarantine(
          buildId, snapshot.snapshotId, `${reportedRole}_create_action_failed`, at, build.phase,
        );
        throw new GoldenSnapshotCallbackError('rejected');
      }
      if (actionId === null) {
        const serverId = reportedRole === 'builder'
          ? build.providerBuilderId
          : build.providerValidationId;
        let server: HetznerServer | null;
        try {
          server = serverId === null ? null : await deps.hetzner.getServer(serverId);
        } catch (err: unknown) {
          throw providerFailure(`${reportedRole} server confirmation`, err);
        }
        if (!server || server.status !== 'running' || !isExactBuildServer(
          server,
          buildId,
          snapshot.snapshotId,
          reportedRole,
          reportedRole === 'validation' ? build.validationCloneOrdinal : undefined,
        )) {
          throw new GoldenSnapshotCallbackError('rejected');
        }
      } else if (!action || action.status !== 'success') {
        throw new GoldenSnapshotCallbackError('rejected');
      }
    }

    if (payload.phase === 'failed') {
      const expectedPhase = payload.role === 'builder' ? 'builder_boot' : 'validation_boot';
      if (build.phase !== expectedPhase || build.status !== 'running') {
        throw new GoldenSnapshotCallbackError('rejected');
      }
      const failureCode = `${payload.role}_${payload.stage}_failed`;
      if (!await deps.ops.quarantine(buildId, snapshot.snapshotId, failureCode, at, expectedPhase, {
        eventId: payload.eventId,
        phase: payload.phase,
        tokenDigest,
        payloadDigest,
        serviceDiagnostics: payload.serviceDiagnostics,
      })) {
        throw new GoldenSnapshotCallbackError('rejected');
      }
      return;
    }

    if (payload.phase === 'builder_booted') {
      if (!payload.healthy) {
        await deps.ops.quarantine(buildId, snapshot.snapshotId, 'builder_health_failed', at, build.phase);
        throw new GoldenSnapshotCallbackError('rejected');
      }
      await deps.db.transaction(async (trx) => {
        const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
          .where('build_id', '=', buildId).forUpdate().executeTakeFirstOrThrow();
        const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, token, payloadDigest);
        if (currentReplay === 'accepted') return;
        if (currentReplay === 'unauthorized') throw new GoldenSnapshotCallbackError('unauthorized');
        if (currentReplay === 'conflict'
          || currentBuild.phase !== 'builder_boot'
          || currentBuild.status !== 'running'
          || currentBuild.callback_phase !== 'sanitized'
          || currentBuild.callback_token_hash !== hashToken(token)
          || !currentBuild.callback_expires_at
          || currentBuild.callback_expires_at <= at) throw new GoldenSnapshotCallbackError('rejected');
        const currentSnapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
          .where('snapshot_id', '=', snapshot.snapshotId).forUpdate().executeTakeFirstOrThrow();
        if (currentSnapshot.state !== 'building') throw new GoldenSnapshotCallbackError('rejected');
        await trx.executor.updateTable('golden_snapshots').set({
          state: 'sanitizing', updated_at: at, revision: sql<number>`revision + 1`,
        }).where('snapshot_id', '=', snapshot.snapshotId).where('revision', '=', currentSnapshot.revision)
          .where('state', '=', 'building').executeTakeFirstOrThrow();
        await trx.executor.updateTable('golden_snapshot_builds').set({
          builder_machine_id_sha256: payload.builderMachineIdSha256,
          builder_ssh_host_key_sha256: payload.builderSshHostKeySha256,
          updated_at: at,
        }).where('build_id', '=', buildId).where('phase', '=', 'builder_boot')
          .executeTakeFirstOrThrow();
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId: snapshot.snapshotId, buildId, eventType: 'builder_booted', actorType: 'worker',
          fromState: 'building', toState: 'sanitizing', now: at,
        });
        await recordCallbackReceipt(trx, {
          buildId, eventId: payload.eventId, phase: payload.phase, tokenDigest, payloadDigest, at,
          expiresAt: addMilliseconds(at, deps.config.auditRetentionMs),
        });
      });
      return;
    }

    if (payload.phase === 'sanitized') {
      const bootIdentityRecorded = build.builderMachineIdSha256 !== null
        || build.builderSshHostKeySha256 !== null;
      if (bootIdentityRecorded && (build.builderMachineIdSha256 !== payload.builderMachineIdSha256
        || build.builderSshHostKeySha256 !== payload.builderSshHostKeySha256)) {
        await deps.ops.quarantine(buildId, snapshot.snapshotId, 'builder_identity_changed', at, build.phase);
        throw new GoldenSnapshotCallbackError('rejected');
      }
      await deps.db.transaction(async (trx) => {
        const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
          .where('build_id', '=', buildId).forUpdate().executeTakeFirstOrThrow();
        const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, token, payloadDigest);
        if (currentReplay === 'accepted') return;
        if (currentReplay === 'unauthorized') throw new GoldenSnapshotCallbackError('unauthorized');
        if (currentReplay === 'conflict'
          || currentBuild.phase !== 'builder_boot'
          || currentBuild.status !== 'running'
          || currentBuild.callback_phase !== 'sanitized'
          || currentBuild.callback_token_hash !== hashToken(token)
          || !currentBuild.callback_expires_at
          || currentBuild.callback_expires_at <= at) throw new GoldenSnapshotCallbackError('rejected');
        const currentSnapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
          .where('snapshot_id', '=', snapshot.snapshotId).forUpdate().executeTakeFirstOrThrow();
        if (!['building', 'sanitizing'].includes(currentSnapshot.state)) {
          throw new GoldenSnapshotCallbackError('rejected');
        }
        await trx.executor.updateTable('golden_snapshots').set({
          state: 'sanitizing', updated_at: at, revision: sql<number>`revision + 1`,
        }).where('snapshot_id', '=', snapshot.snapshotId).where('revision', '=', currentSnapshot.revision)
          .where('state', 'in', ['building', 'sanitizing'])
          .returning('snapshot_id').executeTakeFirstOrThrow();
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId: snapshot.snapshotId, buildId, eventType: 'snapshot_sanitized', actorType: 'worker',
          fromState: currentSnapshot.state, toState: 'sanitizing', now: at,
        });
        await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'snapshot_create', callback_phase: null, callback_token_hash: null,
          callback_expires_at: null,
          callback_event_id: payload.eventId,
          callback_payload_sha256: payloadDigest,
          callback_outcome: { accepted: true },
          builder_machine_id_sha256: currentBuild.builder_machine_id_sha256
            ?? payload.builderMachineIdSha256,
          builder_ssh_host_key_sha256: currentBuild.builder_ssh_host_key_sha256
            ?? payload.builderSshHostKeySha256,
          updated_at: at,
        }).where('build_id', '=', buildId).where('phase', '=', 'builder_boot')
          .returning('build_id').executeTakeFirstOrThrow();
        await recordCallbackReceipt(trx, {
          buildId, eventId: payload.eventId, phase: payload.phase, tokenDigest, payloadDigest, at,
          expiresAt: addMilliseconds(at, deps.config.auditRetentionMs),
        });
      });
      return;
    }

    const evidence = GoldenSnapshotValidationSummarySchema.safeParse(payload.evidence);
    if (!evidence.success) {
      await deps.ops.quarantine(
        buildId,
        snapshot.snapshotId,
        validationEvidenceFailureCode(payload.evidence),
        at,
        build.phase,
      );
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (!build.builderMachineIdSha256 || !build.builderSshHostKeySha256
      || payload.validationMachineIdSha256 === build.builderMachineIdSha256
      || payload.validationSshHostKeySha256 === build.builderSshHostKeySha256) {
      await deps.ops.quarantine(buildId, snapshot.snapshotId, 'validation_identity_reused', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (build.validationCloneOrdinal === 2
      && (!build.firstValidationMachineIdSha256 || !build.firstValidationSshHostKeySha256
        || payload.validationMachineIdSha256 === build.firstValidationMachineIdSha256
        || payload.validationSshHostKeySha256 === build.firstValidationSshHostKeySha256)) {
      await deps.ops.quarantine(buildId, snapshot.snapshotId, 'validation_identity_reused', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (build.validationCloneOrdinal === 1) {
      await deps.db.transaction(async (trx) => {
        const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
          .where('build_id', '=', buildId).forUpdate().executeTakeFirstOrThrow();
        const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, token, payloadDigest);
        if (currentReplay === 'accepted') return;
        if (currentReplay === 'unauthorized') throw new GoldenSnapshotCallbackError('unauthorized');
        if (currentReplay === 'conflict'
          || currentBuild.phase !== 'validation_boot'
          || currentBuild.status !== 'running'
          || currentBuild.validation_clone_ordinal !== 1
          || currentBuild.callback_phase !== 'validated'
          || currentBuild.callback_token_hash !== hashToken(token)
          || !currentBuild.callback_expires_at
          || currentBuild.callback_expires_at <= at) throw new GoldenSnapshotCallbackError('rejected');
        await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'validation_create', validation_clone_ordinal: 2,
          first_validation_machine_id_sha256: payload.validationMachineIdSha256,
          first_validation_ssh_host_key_sha256: payload.validationSshHostKeySha256,
          provider_validation_id: null, provider_validation_action_id: null,
          pending_operation: null, callback_phase: null, callback_token_hash: null,
          callback_expires_at: null,
          callback_event_id: payload.eventId,
          callback_payload_sha256: payloadDigest,
          callback_outcome: { accepted: true },
          updated_at: at,
        }).where('build_id', '=', buildId).where('phase', '=', 'validation_boot')
          .where('validation_clone_ordinal', '=', 1).executeTakeFirstOrThrow();
        await recordCallbackReceipt(trx, {
          buildId, eventId: payload.eventId, phase: payload.phase, tokenDigest, payloadDigest, at,
          expiresAt: addMilliseconds(at, deps.config.auditRetentionMs),
        });
        if (currentBuild.provider_validation_id !== null) {
          await trx.executor.insertInto('golden_snapshot_cleanup').values({
            cleanup_id: randomUUID(), snapshot_id: snapshot.snapshotId, build_id: buildId,
            resource_type: 'validation_server', provider_resource_id: currentBuild.provider_validation_id,
            provenance_key: `build:${buildId}:validation_server:1`, reason: 'validation_clone_completed',
            status: 'queued', attempts: 0, next_attempt_at: at, lease_expires_at: null,
            last_error_code: null, created_at: at, completed_at: null,
          }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
            .where('completed_at', 'is', null).doNothing()).execute();
        }
      });
      return;
    }
    let verifiedImage;
    try {
      verifiedImage = snapshot.providerImageId === null
        ? null
        : await deps.hetzner.getImage(snapshot.providerImageId);
    } catch (err: unknown) {
      throw providerFailure('final snapshot image confirmation', err);
    }
    if (!verifiedImage || verifiedImage.status !== 'available') {
      await deps.ops.quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (verifiedImage.id !== snapshot.providerImageId
      || verifiedImage.architecture !== snapshot.compatibility.architecture
      || verifiedImage.deleteProtected
      || (snapshot.imageDiskGb !== null && verifiedImage.diskGb !== snapshot.imageDiskGb)) {
      await deps.ops.quarantine(buildId, snapshot.snapshotId, 'image_incompatible', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    await deps.db.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${snapshot.compatibility.baseGeneration}))`
        .execute(trx.executor);
      const revokedGeneration = await trx.executor
        .selectFrom('golden_snapshot_revoked_base_generations')
        .select('base_generation')
        .where('base_generation', '=', snapshot.compatibility.baseGeneration)
        .executeTakeFirst();
      if (revokedGeneration) throw new GoldenSnapshotCallbackError('rejected');
      const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
        .where('build_id', '=', buildId).forUpdate().executeTakeFirstOrThrow();
      const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, token, payloadDigest);
      if (currentReplay === 'accepted') return;
      if (currentReplay === 'unauthorized') throw new GoldenSnapshotCallbackError('unauthorized');
      if (currentReplay === 'conflict'
        || currentBuild.phase !== 'validation_boot'
        || currentBuild.status !== 'running'
        || currentBuild.validation_clone_ordinal !== 2
        || currentBuild.callback_phase !== 'validated'
        || currentBuild.callback_token_hash !== hashToken(token)
        || !currentBuild.callback_expires_at
        || currentBuild.callback_expires_at <= at) throw new GoldenSnapshotCallbackError('rejected');
      await trx.executor.updateTable('golden_snapshots').set({
       state: 'ready', validation_summary: evidence.data, provider_image_status: verifiedImage.status,
       ready_at: at, updated_at: at, failure_code: null, revision: sql<number>`revision + 1`,
      }).where('snapshot_id', '=', snapshot.snapshotId).where('state', '=', 'validating')
        .where('provider_image_id', 'is not', null)
        .where('image_architecture', '=', snapshot.compatibility.architecture)
        .returning('snapshot_id').executeTakeFirstOrThrow();
      await appendGoldenSnapshotAuditEvent(trx, {
        snapshotId: snapshot.snapshotId, buildId, eventType: 'snapshot_ready', actorType: 'worker',
        fromState: 'validating', toState: 'ready', now: at,
      });
      await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: 'completed', status: 'completed', completed_at: at, updated_at: at,
        lease_expires_at: null, callback_phase: null, callback_token_hash: null, callback_expires_at: null,
        callback_event_id: payload.eventId,
        callback_payload_sha256: payloadDigest,
        callback_outcome: { accepted: true },
      }).where('build_id', '=', buildId).where('phase', '=', 'validation_boot')
        .returning('build_id').executeTakeFirstOrThrow();
      await recordCallbackReceipt(trx, {
        buildId, eventId: payload.eventId, phase: payload.phase, tokenDigest, payloadDigest, at,
        expiresAt: addMilliseconds(at, deps.config.auditRetentionMs),
      });
      const resources = [
        currentBuild.provider_builder_id === null ? undefined : { type: 'builder_server', id: currentBuild.provider_builder_id },
        currentBuild.provider_validation_id === null ? undefined : { type: 'validation_server', id: currentBuild.provider_validation_id },
      ].filter((value): value is { type: 'builder_server' | 'validation_server'; id: number } => value !== undefined);
      for (const resource of resources) {
        await trx.executor.insertInto('golden_snapshot_cleanup').values({
          cleanup_id: randomUUID(), snapshot_id: snapshot.snapshotId, build_id: buildId,
          resource_type: resource.type, provider_resource_id: resource.id,
          provenance_key: `build:${buildId}:${resource.type}`, reason: 'build_completed', status: 'queued', attempts: 0,
          next_attempt_at: at, lease_expires_at: null, last_error_code: null, created_at: at, completed_at: null,
        }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
          .where('completed_at', 'is', null).doNothing()).execute();
      }
    });
  }
  return { consumeCallback };
}
