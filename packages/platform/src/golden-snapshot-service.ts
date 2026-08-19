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

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CleanupProviderResourceIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const SystemdStateSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:@-]+$/);
export const GoldenSnapshotServiceDiagnosticsSchema = z.object({
  unit: z.enum([
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

export function readGoldenSnapshotServiceDiagnostics(input: unknown) {
  return GoldenSnapshotCallbackOutcomeSchema.safeParse(input).data?.serviceDiagnostics;
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

const ORPHAN_RECONCILIATION_DEADLINE_MS = 24 * 60 * 60 * 1000;
const GRACEFUL_SHUTDOWN_DEADLINE_MS = 2 * 60 * 1000;

// Extraction plan: keep createGoldenSnapshotService as the orchestration facade, then move
// provider create/adoption recovery, callback confirmation, and cleanup reconciliation into
// focused modules after this stacked feature lands. Keeping that boundary explicit here avoids
// mixing a large mechanical split into the snapshot state-machine review.

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

function validationEvidenceFailureCode(
  evidence: Extract<z.infer<typeof GoldenSnapshotCallbackSchema>, { phase: 'validated' }>['evidence'],
): string {
  const checks = [
    ['exactBundle', 'validation_check_exact_bundle_failed'],
    ['healthy', 'validation_check_health_failed'],
    ['freshActivation', 'validation_check_fresh_activation_failed'],
    ['uniqueMachineId', 'validation_check_machine_id_failed'],
    ['uniqueSshHostKey', 'validation_check_ssh_host_key_failed'],
    ['forbiddenStateAbsent', 'validation_check_forbidden_state_failed'],
  ] as const;
  return checks.find(([name]) => evidence[name] !== true)?.[1] ?? 'validation_failed';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function callbackPayloadDigest(payload: GoldenSnapshotCallback): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function isExactBuildServer(
  server: HetznerServer,
  buildId: string,
  snapshotId: string,
  role: 'builder' | 'validation',
  validationOrdinal?: number,
): boolean {
  const labels = server.labels ?? {};
  return labels['matrix.snapshot-build'] === buildId
    && labels['matrix.snapshot-id'] === snapshotId
    && labels['matrix.role'] === role
    && (role !== 'validation'
      || labels['matrix.validation-ordinal'] === String(validationOrdinal));
}

async function callbackReplayStatus(
  db: PlatformDB,
  buildId: string,
  eventId: string,
  token: string,
  payloadDigest: string,
): Promise<'new' | 'accepted' | 'conflict' | 'unauthorized'> {
  const receipt = await db.executor.selectFrom('golden_snapshot_callback_receipts')
    .select(['token_sha256', 'payload_sha256', 'outcome']).where('build_id', '=', buildId)
    .where('event_id', '=', eventId).executeTakeFirst();
  if (!receipt) return 'new';
  if (!receipt.token_sha256 || !tokenMatches(token, receipt.token_sha256)) return 'unauthorized';
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
  input: {
    buildId: string;
    eventId: string;
    phase: string;
    tokenDigest: string;
    payloadDigest: string;
    at: string;
    expiresAt: string;
  },
): Promise<void> {
  await db.executor.insertInto('golden_snapshot_callback_receipts').values({
    build_id: input.buildId, event_id: input.eventId, callback_phase: input.phase,
    token_sha256: input.tokenDigest, payload_sha256: input.payloadDigest, outcome: { accepted: true },
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
    failureStage='identity_regeneration'
    failureArmed=1
    reportFailure() {
      failureStatus="$?"
      [ "$failureArmed" = 1 ] || return 0
      failureArmed=0
      trap - EXIT
      set +e
      reportedStage="$failureStage"
      if [ "$failureStage" = activation ] && [ -f /run/matrix-golden-activation-stage ] \
        && [ ! -L /run/matrix-golden-activation-stage ]; then
        activationStage="$(cat /run/matrix-golden-activation-stage)"
        case "$activationStage" in
          activation_preflight_evidence|activation_preflight_forbidden_state|activation_preflight_host_prerequisites|activation_preflight_user_state|activation_preflight_runtime_state|activation_preflight_owner_state|activation_preflight_root_ssh_state|activation_preflight_root_local_state|activation_preflight_log_state|activation_preflight_cloud_init|activation_preflight_container_state|activation_runtime_setup|activation_terminal_runtime|activation_docker_start|activation_postgres_pull|activation_postgres_start|activation_postgres_ready|activation_services_start|activation_services_ready|activation_gateway_ready|activation_shell_ready|activation_sync_agent_ready|activation_gateway_health) reportedStage="$activationStage" ;;
        esac
      fi
      callbackToken="$(cat /run/matrix-golden-snapshot-callback-token 2>/dev/null)"
      printf '{"eventId":"${input.callbackEventId}","phase":"failed","role":"validation","stage":"%s","bundleVersion":"${bundleVersion}","bundleSha256":"${input.bundleSha256}"}\\n' "$reportedStage" >/run/matrix-golden-failure.json
      printf 'header = "authorization: Bearer %s"\\n' "$callbackToken" |
        curl --config - --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 60 --connect-timeout 10 --max-time 10 -H 'content-type: application/json' --data-binary @/run/matrix-golden-failure.json '${input.callbackUrl}'
      rm -f /run/matrix-golden-snapshot-callback-token /run/matrix-golden-failure.json /run/matrix-golden-validation.json /run/matrix-golden-activation-stage
      exit "$failureStatus"
    }
    trap reportFailure EXIT
    systemd-machine-id-setup
    ssh-keygen -A
    failureStage='activation'
    timeout --kill-after=30 1200 /opt/matrix/bin/matrix-golden-snapshot-activate validation
    failureStage='checks'
    set +e
    MATRIX_CALLBACK_EVENT_ID='${input.callbackEventId}' MATRIX_EXPECTED_BUNDLE_VERSION='${bundleVersion}' MATRIX_EXPECTED_BUNDLE_SHA256='${input.bundleSha256}' MATRIX_BUILDER_MACHINE_ID_SHA256='${input.builderMachineIdSha256}' MATRIX_BUILDER_SSH_HOST_KEY_SHA256='${input.builderSshHostKeySha256}' /opt/matrix/bin/matrix-golden-snapshot-validate >/run/matrix-golden-validation.json
    validationStatus=$?
    set -e
    test -s /run/matrix-golden-validation.json
    if [ "$validationStatus" -ne 0 ]; then
      failureStage="$(python3 - /run/matrix-golden-validation.json <<'PY'
    import json
    import sys

    stages = (
        ("exactBundle", "validation_check_exact_bundle"),
        ("healthy", "validation_check_health"),
        ("freshActivation", "validation_check_fresh_activation"),
        ("uniqueMachineId", "validation_check_machine_id"),
        ("uniqueSshHostKey", "validation_check_ssh_host_key"),
        ("forbiddenStateAbsent", "validation_check_forbidden_state"),
    )
    try:
        evidence = json.load(open(sys.argv[1], encoding="utf-8"))["evidence"]
        print(next((stage for check, stage in stages if evidence.get(check) is not True), "checks"))
    except (OSError, KeyError, TypeError, ValueError):
        print("checks")
    PY
      )"
      exit "$validationStatus"
    fi
    failureStage='callback_delivery'
    callbackToken="$(cat /run/matrix-golden-snapshot-callback-token)"
    printf 'header = "authorization: Bearer %s"\\n' "$callbackToken" |
      curl --config - --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 60 --connect-timeout 10 --max-time 10 -H 'content-type: application/json' --data-binary @/run/matrix-golden-validation.json '${input.callbackUrl}'
    failureArmed=0
    trap - EXIT
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
  return err instanceof CustomerVpsError
    ? err
    : new Error('Golden snapshot provider operation failed');
}

export function createGoldenSnapshotService(rawDeps: GoldenSnapshotServiceDeps): GoldenSnapshotService {
  const config = GoldenSnapshotRuntimeConfigSchema.parse(rawDeps.config);
  const deps = { ...rawDeps, config };
  const now = deps.now ?? (() => new Date().toISOString());
  const buildServerType = config.serverType
    ?? (config.compatibility.architecture === 'arm' ? 'cax11' : 'cx23');

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

  async function runOrphanReconciliationStep(
    rawBuildId: string,
  ): Promise<'queued' | 'pending' | 'absent'> {
    const buildId = UuidSchema.parse(rawBuildId);
    const at = now();
    const { build, snapshot } = await load(buildId);
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
    const { build, snapshot, release } = await load(buildId);
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
        await persistCreatedBuilder(buildId, server, at);
        return 'builder_boot';
      } catch (err: unknown) {
        return handleDefinitiveServerCreateFailure(
          buildId, snapshot.snapshotId, 'builder', build.attempts, at, err,
        );
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
        await quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, 'snapshot_wait');
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
          if (image.status === 'deleting') {
            await quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
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
        } else if (build.callbackExpiresAt && build.callbackExpiresAt <= at) {
          await quarantine(buildId, snapshot.snapshotId, 'snapshot_create_unresolved', at, build.phase);
          throw new Error('Golden snapshot image recovery window expired');
        } else {
          return 'snapshot_wait';
        }
      }
      if (image?.status === 'deleting') {
        await quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
        throw new Error('Golden snapshot image validation failed');
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
          await quarantine(buildId, snapshot.snapshotId, 'builder_cleanup_unsafe', at, 'validation_create');
          throw new Error('Golden snapshot builder cleanup was unsafe');
        }
      }
      return createValidationClone({
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
          await quarantine(buildId, snapshot.snapshotId, 'builder_cleanup_unsafe', at, build.phase);
          throw new Error('Golden snapshot builder cleanup was unsafe');
        }
        return 'validation_create';
      }
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
          validationOrdinal: build.validationCloneOrdinal, attempts: build.attempts, at,
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
    const tokenDigest = hashToken(token);
    const payloadDigest = callbackPayloadDigest(payload);
    const at = now();
    let { build, snapshot } = await load(buildId);
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
      await quarantine(buildId, snapshot.snapshotId, 'callback_timeout', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (payload.bundleVersion !== snapshot.bundleVersion || payload.bundleSha256 !== snapshot.bundleSha256) {
      await quarantine(buildId, snapshot.snapshotId, 'provenance_mismatch', at, build.phase);
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
        await quarantine(
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
      if (!await quarantine(buildId, snapshot.snapshotId, failureCode, at, expectedPhase, {
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
        await quarantine(buildId, snapshot.snapshotId, 'builder_health_failed', at, build.phase);
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
        await quarantine(buildId, snapshot.snapshotId, 'builder_identity_changed', at, build.phase);
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
      await quarantine(
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
      await quarantine(buildId, snapshot.snapshotId, 'image_unavailable', at, build.phase);
      throw new GoldenSnapshotCallbackError('rejected');
    }
    if (verifiedImage.id !== snapshot.providerImageId
      || verifiedImage.architecture !== snapshot.compatibility.architecture
      || verifiedImage.deleteProtected
      || (snapshot.imageDiskGb !== null && verifiedImage.diskGb !== snapshot.imageDiskGb)) {
      await quarantine(buildId, snapshot.snapshotId, 'image_incompatible', at, build.phase);
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

  return { runBuildStep, runOrphanReconciliationStep, runCleanupStep, consumeCallback };
}
