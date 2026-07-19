import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDB } from './db.js';
import type { HetznerClient, HetznerServer } from './customer-vps-hetzner.js';
import {
  appendGoldenSnapshotAuditEvent,
  getGoldenSnapshot,
  getGoldenSnapshotBuild,
  recordGoldenSnapshotProviderImage,
} from './golden-snapshot-repository.js';
import {
  GoldenSnapshotRuntimeConfigSchema,
  GoldenSnapshotBundleVersionSchema,
  GoldenSnapshotValidationSummarySchema,
  type GoldenSnapshotRuntimeConfig,
} from './golden-snapshot-schema.js';

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const GoldenSnapshotCallbackSchema = z.discriminatedUnion('phase', [
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
]);

const CALLBACK_DEADLINE_MS = 30 * 60 * 1000;
const ORPHAN_RECONCILIATION_DEADLINE_MS = 24 * 60 * 60 * 1000;
const GRACEFUL_SHUTDOWN_DEADLINE_MS = 2 * 60 * 1000;

export type GoldenSnapshotCallback = z.input<typeof GoldenSnapshotCallbackSchema>;

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

export class GoldenSnapshotCallbackError extends Error {
  constructor(readonly code: 'unauthorized' | 'rejected') {
    super('Golden snapshot callback rejected');
    this.name = 'GoldenSnapshotCallbackError';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function callbackPayloadDigest(payload: GoldenSnapshotCallback): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function callbackReplayStatus(
  db: PlatformDB,
  buildId: string,
  eventId: string,
  payloadDigest: string,
): Promise<'new' | 'accepted' | 'conflict'> {
  const receipt = await db.executor.selectFrom('golden_snapshot_callback_receipts')
    .select(['payload_sha256', 'outcome']).where('build_id', '=', buildId)
    .where('event_id', '=', eventId).executeTakeFirst();
  if (!receipt) return 'new';
  if (receipt.payload_sha256 !== payloadDigest) return 'conflict';
  return typeof receipt.outcome === 'object'
    && receipt.outcome !== null
    && 'accepted' in receipt.outcome
    && receipt.outcome.accepted === true
    ? 'accepted'
    : 'conflict';
}

async function recordCallbackReceipt(
  db: PlatformDB,
  input: { buildId: string; eventId: string; phase: string; payloadDigest: string; at: string; expiresAt: string },
): Promise<void> {
  await db.executor.insertInto('golden_snapshot_callback_receipts').values({
    build_id: input.buildId, event_id: input.eventId, callback_phase: input.phase,
    payload_sha256: input.payloadDigest, outcome: { accepted: true },
    created_at: input.at, expires_at: input.expiresAt,
  }).onConflict((oc) => oc.columns(['build_id', 'event_id']).doNothing()).execute();
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString();
}

function replaceTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    if (value.includes("'")) throw new Error(`Unsafe golden snapshot template value: ${name}`);
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  if (/{{[a-zA-Z][a-zA-Z0-9]*}}/.test(rendered)) throw new Error('Golden snapshot template is incomplete');
  return rendered;
}

function validationUserData(input: {
  callbackUrl: string;
  callbackToken: string;
  callbackEventId: string;
  bundleVersion: string;
  bundleSha256: string;
  builderMachineIdSha256: string;
  builderSshHostKeySha256: string;
}): string {
  const bundleVersion = GoldenSnapshotBundleVersionSchema.parse(input.bundleVersion);
  for (const [name, value] of Object.entries(input)) {
    if (value.includes("'") || /[\r\n]/.test(value)) {
      throw new Error(`Unsafe golden snapshot validation template value: ${name}`);
    }
  }
  return `#cloud-config
write_files:
  - path: /run/matrix-golden-snapshot-callback-token
    owner: root:root
    permissions: '0600'
    content: '${input.callbackToken}'
runcmd:
  - |
    set -eu
    systemd-machine-id-setup
    ssh-keygen -A
    /opt/matrix/bin/matrix-golden-snapshot-activate validation
    set +e
    MATRIX_CALLBACK_EVENT_ID='${input.callbackEventId}' MATRIX_EXPECTED_BUNDLE_VERSION='${bundleVersion}' MATRIX_EXPECTED_BUNDLE_SHA256='${input.bundleSha256}' MATRIX_BUILDER_MACHINE_ID_SHA256='${input.builderMachineIdSha256}' MATRIX_BUILDER_SSH_HOST_KEY_SHA256='${input.builderSshHostKeySha256}' /opt/matrix/bin/matrix-golden-snapshot-validate >/run/matrix-golden-validation.json
    validationStatus=$?
    set -e
    callbackToken="$(cat /run/matrix-golden-snapshot-callback-token)"
    printf 'header = "authorization: Bearer %s"\n' "$callbackToken" |
      curl --config - --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 60 --connect-timeout 10 --max-time 10 -H 'content-type: application/json' --data-binary @/run/matrix-golden-validation.json '${input.callbackUrl}'
    rm -f /run/matrix-golden-snapshot-callback-token /run/matrix-golden-validation.json
    exit "$validationStatus"
`;
}

function exactLabels(buildId: string, snapshotId: string, role: 'builder' | 'validation', validationOrdinal?: number) {
  return {
    'matrix.snapshot-build': buildId,
    'matrix.snapshot-id': snapshotId,
    'matrix.role': role,
    ...(role === 'validation' ? { 'matrix.validation-ordinal': String(validationOrdinal) } : {}),
  };
}

function providerFailure(context: string, err: unknown): Error {
  const kind = err instanceof Error ? err.name : typeof err;
  console.error(`[golden-snapshot] ${context} failed: ${kind}`);
  return new Error('Golden snapshot provider operation failed');
}

export function createGoldenSnapshotService(rawDeps: GoldenSnapshotServiceDeps): GoldenSnapshotService {
  const config = GoldenSnapshotRuntimeConfigSchema.parse(rawDeps.config);
  const deps = { ...rawDeps, config };
  const now = deps.now ?? (() => new Date().toISOString());

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
      callback_expires_at: addMilliseconds(at, CALLBACK_DEADLINE_MS),
      updated_at: at,
    }).where('build_id', '=', buildId).where('phase', '=', 'builder_create')
      .where('provider_builder_id', 'is', null).returning('build_id').executeTakeFirst();
    return row !== undefined;
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
    const exact = matches.filter((server) => {
      const labels = server.labels ?? {};
      return labels['matrix.snapshot-build'] === buildId
        && labels['matrix.snapshot-id'] === snapshotId
        && labels['matrix.role'] === role
        && (role !== 'validation' || labels['matrix.validation-ordinal'] === String(validationOrdinal));
    });
    if (exact.length !== 1) return undefined;
    if (role === 'builder') await persistCreatedBuilder(buildId, exact[0]!, at);
    else {
      await deps.db.executor.updateTable('golden_snapshot_builds').set({
        phase: 'validation_boot', provider_validation_id: exact[0]!.id,
        provider_validation_action_id: exact[0]!.createActionId ?? null,
        pending_operation: null, callback_expires_at: addMilliseconds(at, CALLBACK_DEADLINE_MS),
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
    at: string;
  }): Promise<string> {
    const callbackToken = deps.tokenFactory();
    const callbackEventId = randomUUID();
    const armed = await deps.db.executor.updateTable('golden_snapshot_builds').set({
      pending_operation: `validation:${input.buildId}:${input.validationOrdinal}`,
      callback_phase: 'validated', callback_token_hash: hashToken(callbackToken),
      callback_expires_at: addMilliseconds(input.at, CALLBACK_DEADLINE_MS), updated_at: input.at,
    }).where('build_id', '=', input.buildId).where('phase', '=', 'validation_create')
      .where('validation_clone_ordinal', '=', input.validationOrdinal)
      .where('callback_token_hash', 'is', null).returning('build_id').executeTakeFirst();
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
        sshKeys: [],
      });
      await deps.db.executor.updateTable('golden_snapshot_builds').set({
        phase: 'validation_boot', provider_validation_id: server.id,
        provider_validation_action_id: server.createActionId ?? null,
        pending_operation: null, callback_expires_at: addMilliseconds(input.at, CALLBACK_DEADLINE_MS),
        updated_at: input.at,
      }).where('build_id', '=', input.buildId).where('phase', '=', 'validation_create')
        .where('validation_clone_ordinal', '=', input.validationOrdinal).executeTakeFirstOrThrow();
      return 'validation_boot';
    } catch (err: unknown) {
      throw providerFailure('validation create', err);
    }
  }

  async function quarantine(
    buildId: string,
    snapshotId: string,
    code: string,
    at: string,
    expectedPhase: string,
  ): Promise<boolean> {
    return deps.db.transaction(async (trx) => {
      const build = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
        .where('build_id', '=', buildId).where('snapshot_id', '=', snapshotId).forUpdate().executeTakeFirstOrThrow();
      if (build.status !== 'running' || build.phase !== expectedPhase) return false;
      const reconcileUnknownCreate = (code === 'builder_create_unresolved' || code === 'validation_create_unresolved')
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
      await trx.executor.updateTable('golden_snapshot_builds').set({
        phase: 'failed', status: 'failed', last_error_code: code, updated_at: at,
        completed_at: at, lease_expires_at: null, callback_phase: null, callback_token_hash: null,
        callback_expires_at: reconcileUnknownCreate
          ? addMilliseconds(at, ORPHAN_RECONCILIATION_DEADLINE_MS)
          : null,
        pending_operation: reconcileUnknownCreate ? build.pending_operation : null,
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
      return true;
    });
  }

  async function runOrphanReconciliationStep(
    rawBuildId: string,
  ): Promise<'queued' | 'pending' | 'absent'> {
    const buildId = UuidSchema.parse(rawBuildId);
    const at = now();
    const { build, snapshot } = await load(buildId);
    if (build.status !== 'failed' || snapshot.state !== 'quarantined' || build.pendingOperation === null) {
      throw new Error('Golden snapshot orphan reconciliation is not pending');
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
    const { build, snapshot, release } = await load(buildId);
    if (build.status !== 'running') throw new Error('Golden snapshot build is not claimed');

    if (build.phase === 'requested') {
      const callbackToken = deps.tokenFactory();
      const callbackEventId = randomUUID();
      const callbackHash = hashToken(callbackToken);
      const changed = await deps.db.transaction(async (trx) => {
        const buildRow = await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'builder_create', pending_operation: `builder:${buildId}`,
          callback_phase: 'sanitized', callback_token_hash: callbackHash,
          callback_expires_at: addMilliseconds(at, CALLBACK_DEADLINE_MS), updated_at: at,
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
        callbackUrl: `${deps.callbackBaseUrl.replace(/\/$/, '')}/system-bundles/snapshot-builds/${buildId}/callback`,
      });
      try {
        const server = await deps.hetzner.createServer({
          name: `matrix-golden-${buildId.slice(0, 8)}`,
          userData,
          labels: exactLabels(buildId, snapshot.snapshotId, 'builder'),
          image: snapshot.compatibility.baseImage,
          sshKeys: [],
        });
        await persistCreatedBuilder(buildId, server, at);
        return 'builder_boot';
      } catch (err: unknown) {
        throw providerFailure('builder create', err);
      }
    }

    if (build.phase === 'builder_create') {
      try {
        const adopted = await adoptServer(buildId, snapshot.snapshotId, 'builder', at);
        if (adopted) return 'builder_boot';
        if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await quarantine(buildId, snapshot.snapshotId, 'builder_create_unresolved', at, build.phase);
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
        await quarantine(buildId, snapshot.snapshotId, 'callback_timeout', at, build.phase);
        throw new Error('Golden snapshot callback timed out');
      }
      return build.phase;
    }

    if (build.phase === 'snapshot_create') {
      if (build.providerBuilderId === null) throw new Error('Golden snapshot builder identity missing');
      const server = await deps.hetzner.getServer(build.providerBuilderId);
      if (!server) {
        await quarantine(buildId, snapshot.snapshotId, 'builder_missing', at, build.phase);
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
            await quarantine(buildId, snapshot.snapshotId, 'builder_shutdown_timeout', at, build.phase);
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
        callback_expires_at: addMilliseconds(at, CALLBACK_DEADLINE_MS), updated_at: at,
      }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_create')
        .returning('build_id').executeTakeFirst();
      if (!armed) return 'snapshot_wait';
      try {
        const created = await deps.hetzner.createSnapshot(server.id, {
          description: `Matrix OS ${snapshot.bundleVersion} golden snapshot`,
          labels: exactLabels(buildId, snapshot.snapshotId, 'builder'),
        });
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
      } catch (err: unknown) {
        throw providerFailure('snapshot create', err);
      }
    }

    if (build.phase === 'snapshot_wait') {
      let image = snapshot.providerImageId === null
        ? null
        : await deps.hetzner.getImage(snapshot.providerImageId);
      const action = build.providerSnapshotActionId === null
        ? null
        : await deps.hetzner.getAction(build.providerSnapshotActionId);
      if (snapshot.providerImageId === null) {
        const selector = `matrix.snapshot-build=${buildId},matrix.snapshot-id=${snapshot.snapshotId}`;
        const candidates = (await deps.hetzner.listImagesByLabel(selector)).filter((candidate) =>
          candidate.labels['matrix.snapshot-build'] === buildId
          && candidate.labels['matrix.snapshot-id'] === snapshot.snapshotId
          && candidate.labels['matrix.role'] === 'builder');
        if (candidates.length > 1) {
          await quarantine(buildId, snapshot.snapshotId, 'snapshot_create_ambiguous', at, build.phase);
          throw new Error('Golden snapshot image reconciliation was ambiguous');
        }
        image = candidates[0] ?? null;
        if (image) {
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
        } else if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await quarantine(buildId, snapshot.snapshotId, 'snapshot_create_unresolved', at, build.phase);
          throw new Error('Golden snapshot image recovery window expired');
        } else {
          return 'snapshot_wait';
        }
      }
      if (!image || action?.status === 'error') {
        await quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
        throw new Error('Golden snapshot image validation failed');
      }
      if (action === null && (build.providerSnapshotActionId !== null || image.status !== 'available')) {
        if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await quarantine(buildId, snapshot.snapshotId, 'snapshot_action_unconfirmed', at, build.phase);
          throw new Error('Golden snapshot action confirmation timed out');
        }
        return 'snapshot_wait';
      }
      if (image.status !== 'available' || (action !== null && action.status !== 'success')) return 'snapshot_wait';
      if (image.architecture !== snapshot.compatibility.architecture || image.deleteProtected) {
        await quarantine(buildId, snapshot.snapshotId, 'image_incompatible', at, build.phase);
        throw new Error('Golden snapshot image compatibility validation failed');
      }
      if (!build.builderMachineIdSha256 || !build.builderSshHostKeySha256) {
        await quarantine(buildId, snapshot.snapshotId, 'builder_identity_missing', at, build.phase);
        throw new Error('Golden snapshot builder identity evidence missing');
      }
      const armed = await deps.db.executor.updateTable('golden_snapshot_builds').set({
        phase: 'validation_create', pending_operation: null,
        callback_phase: null, callback_token_hash: null,
        callback_expires_at: null, updated_at: at,
      }).where('build_id', '=', buildId).where('phase', '=', 'snapshot_wait')
        .returning('build_id').executeTakeFirst();
      if (!armed) return 'validation_create';
      return createValidationClone({
        buildId, snapshotId: snapshot.snapshotId, imageId: image.id,
        bundleVersion: snapshot.bundleVersion, bundleSha256: snapshot.bundleSha256,
        builderMachineIdSha256: build.builderMachineIdSha256,
        builderSshHostKeySha256: build.builderSshHostKeySha256,
        validationOrdinal: build.validationCloneOrdinal, at,
      });
    }

    if (build.phase === 'validation_create') {
      if (build.callbackTokenHash === null) {
        if (snapshot.providerImageId === null || !build.builderMachineIdSha256 || !build.builderSshHostKeySha256) {
          await quarantine(buildId, snapshot.snapshotId, 'validation_provenance_missing', at, build.phase);
          throw new Error('Golden snapshot validation provenance missing');
        }
        return createValidationClone({
          buildId, snapshotId: snapshot.snapshotId, imageId: snapshot.providerImageId,
          bundleVersion: snapshot.bundleVersion, bundleSha256: snapshot.bundleSha256,
          builderMachineIdSha256: build.builderMachineIdSha256,
          builderSshHostKeySha256: build.builderSshHostKeySha256,
          validationOrdinal: build.validationCloneOrdinal, at,
        });
      }
      try {
        const adopted = await adoptServer(
          buildId, snapshot.snapshotId, 'validation', at, build.validationCloneOrdinal,
        );
        if (adopted) return 'validation_boot';
        if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await quarantine(buildId, snapshot.snapshotId, 'validation_create_unresolved', at, build.phase);
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

  async function consumeCallback(rawBuildId: string, rawToken: string, rawPayload: GoldenSnapshotCallback): Promise<void> {
    const buildId = UuidSchema.parse(rawBuildId);
    const token = z.string().min(16).max(512).parse(rawToken);
    const payload = GoldenSnapshotCallbackSchema.parse(rawPayload);
    const payloadDigest = callbackPayloadDigest(payload);
    const at = now();
    let { build, snapshot } = await load(buildId);
    const replay = await callbackReplayStatus(deps.db, buildId, payload.eventId, payloadDigest);
    if (replay === 'accepted') return;
    if (replay === 'conflict') throw new GoldenSnapshotCallbackError('rejected');
    if (!build.callbackTokenHash || build.callbackPhase !== payload.phase || !tokenMatches(token, build.callbackTokenHash)) {
      throw new GoldenSnapshotCallbackError('unauthorized');
    }
    if (!build.callbackExpiresAt || build.callbackExpiresAt <= at) {
      await quarantine(buildId, snapshot.snapshotId, 'callback_timeout', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (payload.bundleVersion !== snapshot.bundleVersion || payload.bundleSha256 !== snapshot.bundleSha256) {
      await quarantine(buildId, snapshot.snapshotId, 'provenance_mismatch', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }

    const earlyRole = payload.phase === 'sanitized' && build.phase === 'builder_create'
      ? 'builder'
      : payload.phase === 'validated' && build.phase === 'validation_create'
        ? 'validation'
        : undefined;
    if (earlyRole) {
      let adopted: HetznerServer | undefined;
      try {
        adopted = await adoptServer(
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
      ({ build, snapshot } = await load(buildId));
    }

    if (payload.phase === 'sanitized') {
      await deps.db.transaction(async (trx) => {
        const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
          .where('build_id', '=', buildId).forUpdate().executeTakeFirstOrThrow();
        const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, payloadDigest);
        if (currentReplay === 'accepted') return;
        if (currentReplay === 'conflict'
          || currentBuild.phase !== 'builder_boot'
          || currentBuild.status !== 'running'
          || currentBuild.callback_phase !== 'sanitized'
          || currentBuild.callback_token_hash !== hashToken(token)
          || !currentBuild.callback_expires_at
          || currentBuild.callback_expires_at <= at) throw new GoldenSnapshotCallbackError('rejected');
        await trx.executor.updateTable('golden_snapshots').set({
          state: 'sanitizing', updated_at: at, revision: sql<number>`revision + 1`,
        }).where('snapshot_id', '=', snapshot.snapshotId).where('state', '=', 'building')
          .returning('snapshot_id').executeTakeFirstOrThrow();
        await appendGoldenSnapshotAuditEvent(trx, {
          snapshotId: snapshot.snapshotId, buildId, eventType: 'snapshot_sanitized', actorType: 'worker',
          fromState: 'building', toState: 'sanitizing', now: at,
        });
        await trx.executor.updateTable('golden_snapshot_builds').set({
          phase: 'snapshot_create', callback_phase: null, callback_token_hash: null,
          callback_expires_at: null,
          callback_event_id: payload.eventId,
          callback_payload_sha256: payloadDigest,
          callback_outcome: { accepted: true },
          builder_machine_id_sha256: payload.builderMachineIdSha256,
          builder_ssh_host_key_sha256: payload.builderSshHostKeySha256,
          updated_at: at,
        }).where('build_id', '=', buildId).where('phase', '=', 'builder_boot')
          .returning('build_id').executeTakeFirstOrThrow();
        await recordCallbackReceipt(trx, {
          buildId, eventId: payload.eventId, phase: payload.phase, payloadDigest, at,
          expiresAt: addMilliseconds(at, deps.config.auditRetentionMs),
        });
      });
      return;
    }

    const evidence = GoldenSnapshotValidationSummarySchema.safeParse(payload.evidence);
    if (!evidence.success) {
      await quarantine(buildId, snapshot.snapshotId, 'validation_failed', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (!build.builderMachineIdSha256 || !build.builderSshHostKeySha256
      || payload.validationMachineIdSha256 === build.builderMachineIdSha256
      || payload.validationSshHostKeySha256 === build.builderSshHostKeySha256) {
      await quarantine(buildId, snapshot.snapshotId, 'validation_identity_reused', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (build.validationCloneOrdinal === 2
      && (!build.firstValidationMachineIdSha256 || !build.firstValidationSshHostKeySha256
        || payload.validationMachineIdSha256 === build.firstValidationMachineIdSha256
        || payload.validationSshHostKeySha256 === build.firstValidationSshHostKeySha256)) {
      await quarantine(buildId, snapshot.snapshotId, 'validation_identity_reused', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (build.validationCloneOrdinal === 1) {
      await deps.db.transaction(async (trx) => {
        const currentBuild = await trx.executor.selectFrom('golden_snapshot_builds').selectAll()
          .where('build_id', '=', buildId).forUpdate().executeTakeFirstOrThrow();
        const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, payloadDigest);
        if (currentReplay === 'accepted') return;
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
          buildId, eventId: payload.eventId, phase: payload.phase, payloadDigest, at,
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
      const currentReplay = await callbackReplayStatus(trx, buildId, payload.eventId, payloadDigest);
      if (currentReplay === 'accepted') return;
      if (currentReplay === 'conflict'
        || currentBuild.phase !== 'validation_boot'
        || currentBuild.status !== 'running'
        || currentBuild.validation_clone_ordinal !== 2
        || currentBuild.callback_phase !== 'validated'
        || currentBuild.callback_token_hash !== hashToken(token)
        || !currentBuild.callback_expires_at
        || currentBuild.callback_expires_at <= at) throw new GoldenSnapshotCallbackError('rejected');
      await trx.executor.updateTable('golden_snapshots').set({
       state: 'ready', validation_summary: evidence.data, provider_image_status: 'available',
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
        buildId, eventId: payload.eventId, phase: payload.phase, payloadDigest, at,
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
    const cleanup = await deps.db.executor.updateTable('golden_snapshot_cleanup').set({
      status: 'running', attempts: sql<number>`attempts + 1`, lease_expires_at: leaseExpiresAt,
      last_error_code: null,
    }).where('cleanup_id', '=', cleanupId).where('attempts', '<', config.maxBuildAttempts)
      .where((eb) => eb.or([
        eb('status', '=', 'queued'),
        eb.and([eb('status', '=', 'running'), eb('lease_expires_at', '<=', at)]),
      ])).returningAll().executeTakeFirst();
    if (!cleanup) return 'pending';
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

  return { runBuildStep, runOrphanReconciliationStep, runCleanupStep, consumeCallback };
}
