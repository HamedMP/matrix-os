/**
 * Golden snapshot build operations (load/adopt/quarantine/create helpers).
 *
 * Extracted from ./golden-snapshot-service.ts (Phase 1-A4). Pure move: no logic changes.
 * Shared by runBuildStep/runCleanupStep/consumeCallback via one sub-factory so the
 * state-machine helpers keep a single owner.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import type { HetznerClient, HetznerServer } from './customer-vps-hetzner.js';
import { DefinitiveProviderRejectionError } from './customer-vps-errors.js';
import {
  appendGoldenSnapshotAuditEvent,
  getGoldenSnapshot,
  getGoldenSnapshotBuild,
  reserveGoldenSnapshotValidationCreate,
} from './golden-snapshot-repository.js';
import type {
  GoldenSnapshotRuntimeConfig,
} from './golden-snapshot-schema.js';
import type { GoldenSnapshotServiceDiagnosticsSchema } from './golden-snapshot-service.js';
import {
  addMilliseconds,
  exactLabels,
  hashToken,
  isExactBuildServer,
  providerFailure,
  recordCallbackReceipt,
  validationUserData,
} from './golden-snapshot-service-helpers.js';

const ORPHAN_RECONCILIATION_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface GoldenSnapshotBuildOperationsDeps {
  db: PlatformDB;
  hetzner: HetznerClient;
  config: GoldenSnapshotRuntimeConfig;
  tokenFactory: () => string;
  callbackBaseUrl: string;
  buildServerType: string;
}

export function createGoldenSnapshotBuildOperations(
  opsDeps: GoldenSnapshotBuildOperationsDeps,
) {
  const deps = opsDeps;
  const buildServerType = opsDeps.buildServerType;
  async function load(buildId: string) {
    const build = await getGoldenSnapshotBuild(deps.db, buildId);
    if (!build) throw new Error('Golden snapshot build not found');
    const snapshot = await getGoldenSnapshot(deps.db, build.snapshotId);
    if (!snapshot) throw new Error('Golden snapshot not found');
    const release = await deps.db.executor.selectFrom('host_bundle_releases').selectAll()
      .where('version', '=', snapshot.bundleVersion).executeTakeFirstOrThrow();
    if (release.sha256.toLowerCase() !== snapshot.bundleSha256) {
      throw new Error('Golden snapshot release provenance mismatch');
    }
    return { build, snapshot, release };
  }

  async function persistCreatedBuilder(buildId: string, server: HetznerServer, at: string): Promise<boolean> {
    const row = await deps.db.executor.updateTable('golden_snapshot_builds').set({
      phase: 'builder_boot',
      provider_builder_id: server.id,
      provider_builder_action_id: server.createActionId ?? null,
      pending_operation: null,
      callback_expires_at: addMilliseconds(at, deps.config.callbackDeadlineMs),
      updated_at: at,
    }).where('build_id', '=', buildId).where('phase', '=', 'builder_create')
      .where('provider_builder_id', 'is', null).returning('build_id').executeTakeFirst();
    return row !== undefined;
  }

  async function requeueDefinitiveServerCreate(
    buildId: string,
    snapshotId: string,
    role: 'builder' | 'validation',
    at: string,
  ): Promise<boolean> {
    const expectedPhase = role === 'builder' ? 'builder_create' : 'validation_create';
    return deps.db.transaction(async (trx) => {
      const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
        .where('build_id', '=', buildId).where('snapshot_id', '=', snapshotId)
        .forUpdate().executeTakeFirst();
      if (!build || build.status !== 'running' || build.phase !== expectedPhase) return false;
      if (build.pending_operation === null) return false;
      if (role === 'builder') {
        const snapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
          .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
        if (!snapshot || snapshot.state !== 'building' || snapshot.provider_image_id !== null) return false;
        const reset = await trx.executor.updateTable('golden_snapshots').set({
          state: 'candidate', updated_at: at, revision: sql<number>`revision + 1`,
        }).where('snapshot_id', '=', snapshotId).where('revision', '=', snapshot.revision)
          .where('state', '=', 'building').returning('snapshot_id').executeTakeFirst();
        if (!reset) return false;
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId, buildId, eventType: 'builder_create_requeued', actorType: 'worker',
          fromState: 'building', toState: 'candidate', reason: 'provider_capacity', now: at,
        });
      } else {
        const snapshot = await trx.executor.selectFrom('golden_snapshots')
          .select(['snapshot_id', 'state', 'provider_image_id'])
          .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
        if (!snapshot || snapshot.state !== 'validating' || snapshot.provider_image_id === null) return false;
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId, buildId, eventType: 'validation_create_requeued', actorType: 'worker',
          fromState: 'validating', toState: 'validating', reason: 'provider_capacity', now: at,
        });
      }
      const requeued = await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: role === 'builder' ? 'requested' : 'validation_create',
        status: 'queued', available_at: at, claimed_at: null, lease_expires_at: null,
        callback_phase: null, callback_token_hash: null, callback_expires_at: null,
        pending_operation: null, updated_at: at,
      }).where('build_id', '=', buildId).where('status', '=', 'running')
        .where('phase', '=', expectedPhase).returning('build_id').executeTakeFirst();
      if (!requeued) throw new Error('Golden snapshot create requeue lost its build');
      return true;
    });
  }

  async function handleDefinitiveServerCreateFailure(
    buildId: string,
    snapshotId: string,
    role: 'builder' | 'validation',
    attempts: number,
    at: string,
    err: unknown,
  ): Promise<never> {
    if (!(err instanceof DefinitiveProviderRejectionError)) {
      throw providerFailure(`${role} create`, err);
    }
    const phase = role === 'builder' ? 'builder_create' : 'validation_create';
    if (err.code !== 'quota_exceeded') {
      await quarantine(buildId, snapshotId, `${role}_create_rejected`, at, phase);
    } else if (attempts >= deps.config.maxBuildAttempts) {
      await quarantine(buildId, snapshotId, 'provider_capacity_exhausted', at, phase);
    } else {
      await requeueDefinitiveServerCreate(buildId, snapshotId, role, at);
    }
    throw providerFailure(`${role} create`, err);
  }

  async function adoptServer(
    buildId: string,
    snapshotId: string,
    role: 'builder' | 'validation',
    at: string,
    validationOrdinal?: number,
  ) {
    if (!deps.hetzner.listServersByLabel) return undefined;
    const selector = `matrix.snapshot-build=${buildId},matrix.role=${role}`;
    const matches = await deps.hetzner.listServersByLabel(selector);
    const exact = matches.filter((server) => isExactBuildServer(
      server, buildId, snapshotId, role, validationOrdinal,
    ));
    if (exact.length !== 1) return undefined;
    if (role === 'builder') await persistCreatedBuilder(buildId, exact[0]!, at);
    else {
      await deps.db.executor.updateTable('golden_snapshot_builds').set({
        phase: 'validation_boot', provider_validation_id: exact[0]!.id,
        provider_validation_action_id: exact[0]!.createActionId ?? null,
        pending_operation: null, callback_expires_at: addMilliseconds(at, deps.config.callbackDeadlineMs),
        updated_at: at,
      }).where('build_id', '=', buildId).where('phase', '=', 'validation_create')
        .where('validation_clone_ordinal', '=', validationOrdinal ?? 0)
        .where('provider_validation_id', 'is', null).execute();
    }
    return exact[0];
  }

  async function createValidationClone(input: {
    buildId: string;
    snapshotId: string;
    imageId: number;
    bundleVersion: string;
    bundleSha256: string;
    builderMachineIdSha256: string;
    builderSshHostKeySha256: string;
    validationOrdinal: number;
    attempts: number;
    at: string;
  }): Promise<string> {
    const callbackToken = deps.tokenFactory();
    const callbackEventId = randomUUID();
    const armed = await reserveGoldenSnapshotValidationCreate(deps.db, {
      buildId: input.buildId,
      validationOrdinal: input.validationOrdinal,
      callbackTokenHash: hashToken(callbackToken),
      callbackExpiresAt: addMilliseconds(input.at, deps.config.callbackDeadlineMs),
      now: input.at,
      maxResources: deps.config.maxConcurrentBuilds,
    });
    if (!armed) return 'validation_create';
    try {
      const server = await deps.hetzner.createServer({
        name: `matrix-validate-${input.buildId.slice(0, 8)}-${input.validationOrdinal}`,
        userData: validationUserData({
          callbackUrl: `${deps.callbackBaseUrl.replace(/\/$/, '')}/system-bundles/snapshot-builds/${input.buildId}/callback`,
          callbackToken,
          callbackEventId,
          bundleVersion: input.bundleVersion,
          bundleSha256: input.bundleSha256,
          builderMachineIdSha256: input.builderMachineIdSha256,
          builderSshHostKeySha256: input.builderSshHostKeySha256,
        }),
        labels: exactLabels(input.buildId, input.snapshotId, 'validation', input.validationOrdinal),
        image: input.imageId,
        serverType: buildServerType,
        sshKeys: [],
      });
      await deps.db.executor.updateTable('golden_snapshot_builds').set({
        phase: 'validation_boot', provider_validation_id: server.id,
        provider_validation_action_id: server.createActionId ?? null,
        pending_operation: null, callback_expires_at: addMilliseconds(input.at, deps.config.callbackDeadlineMs),
        updated_at: input.at,
      }).where('build_id', '=', input.buildId).where('phase', '=', 'validation_create')
        .where('validation_clone_ordinal', '=', input.validationOrdinal).executeTakeFirstOrThrow();
      return 'validation_boot';
    } catch (err: unknown) {
      return handleDefinitiveServerCreateFailure(
        input.buildId,
        input.snapshotId,
        'validation',
        input.attempts,
        input.at,
        err,
      );
    }
  }

  async function quarantine(
    buildId: string,
    snapshotId: string,
    code: string,
    at: string,
    expectedPhase: string,
    callbackReceipt?: {
      eventId: string;
      phase: string;
      tokenDigest: string;
      payloadDigest: string;
      serviceDiagnostics?: z.infer<typeof GoldenSnapshotServiceDiagnosticsSchema>;
    },
  ): Promise<boolean> {
    return deps.db.transaction(async (trx) => {
      const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
        .where('build_id', '=', buildId).where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirstOrThrow();
      if (build.status !== 'running' || build.phase !== expectedPhase) return false;
      const reconcileUnknownCreate = (code === 'builder_create_unresolved'
        || code === 'validation_create_unresolved'
        || code === 'snapshot_create_unresolved')
        && build.pending_operation !== null;
      const priorSnapshot = await trx.executor.selectFrom('golden_snapshots').selectAll()
        .where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirst();
      const snapshotRow = await trx.executor.updateTable('golden_snapshots').set({
        state: 'quarantined', failure_code: code, quarantined_at: at, updated_at: at,
        revision: sql<number>`revision + 1`,
      }).where('snapshot_id', '=', snapshotId).where('state', 'not in', ['retiring', 'deleted'])
        .returning('provider_image_id').executeTakeFirst();
      if (snapshotRow && priorSnapshot) {
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId, buildId, eventType: 'snapshot_quarantined', actorType: 'worker',
          fromState: priorSnapshot.state, toState: 'quarantined', reason: code, now: at,
        });
      }
      const callbackEvidence = callbackReceipt ? {
        callback_event_id: callbackReceipt.eventId,
        callback_payload_sha256: callbackReceipt.payloadDigest,
        callback_outcome: {
          accepted: true,
          ...(callbackReceipt.serviceDiagnostics
            ? { serviceDiagnostics: callbackReceipt.serviceDiagnostics }
            : {}),
        },
      } : {};
      await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: 'failed', status: 'failed', last_error_code: code, updated_at: at,
        completed_at: at, lease_expires_at: null, callback_phase: null, callback_token_hash: null,
        callback_expires_at: reconcileUnknownCreate
          ? addMilliseconds(at, ORPHAN_RECONCILIATION_DEADLINE_MS)
          : null,
        pending_operation: reconcileUnknownCreate ? build.pending_operation : null,
        ...callbackEvidence,
      }).where('build_id', '=', buildId).where('phase', '=', expectedPhase)
        .where('status', '=', 'running').execute();
      const resources = [
        build.provider_builder_id === null ? undefined : { type: 'builder_server', id: build.provider_builder_id },
        build.provider_validation_id === null ? undefined : { type: 'validation_server', id: build.provider_validation_id },
        snapshotRow?.provider_image_id == null ? undefined : { type: 'snapshot_image', id: snapshotRow.provider_image_id },
      ].filter((value): value is {
        type: 'builder_server' | 'validation_server' | 'snapshot_image'; id: number;
      } => value !== undefined);
      for (const resource of resources) {
        await trx.executor.insertInto('golden_snapshot_cleanup').values({
          cleanup_id: randomUUID(), snapshot_id: snapshotId,
          build_id: resource.type === 'snapshot_image' ? null : buildId,
          resource_type: resource.type, provider_resource_id: resource.id,
          provenance_key: resource.type === 'snapshot_image'
            ? `snapshot:${snapshotId}`
            : `build:${buildId}:${resource.type}`,
          reason: code, status: 'queued', attempts: 0,
          next_attempt_at: at, lease_expires_at: null, last_error_code: null, created_at: at, completed_at: null,
        }).onConflict((oc) => oc.columns(['resource_type', 'provider_resource_id'])
          .where('completed_at', 'is', null).doNothing()).execute();
      }
      if (callbackReceipt) {
        await recordCallbackReceipt(trx, {
          buildId,
          ...callbackReceipt,
          at,
          expiresAt: addMilliseconds(at, deps.config.auditRetentionMs),
        });
      }
      return true;
    });
  }
  return { load, persistCreatedBuilder, requeueDefinitiveServerCreate,
    handleDefinitiveServerCreateFailure, adoptServer, createValidationClone, quarantine };
}
