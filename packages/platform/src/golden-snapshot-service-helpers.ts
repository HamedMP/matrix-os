/**
 * Golden snapshot service pure helpers (validation, tokens, templates, receipts).
 *
 * Extracted from ./golden-snapshot-service.ts (Phase 1-A4). Pure move: no logic changes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
export const UuidSchema = z.string().uuid();
import type { PlatformDB } from './db.js';
import type { HetznerServer } from './customer-vps-hetzner.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import {
  GoldenSnapshotBundleVersionSchema,
} from './golden-snapshot-schema.js';
import type {
  GoldenSnapshotCallback,
  GoldenSnapshotCallbackSchema,
  GoldenSnapshotServiceDiagnosticsSchema,
} from './golden-snapshot-service.js';

export function validationEvidenceFailureCode(
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

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function callbackPayloadDigest(payload: GoldenSnapshotCallback): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function isExactBuildServer(
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

export async function callbackReplayStatus(
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

export async function recordCallbackReceipt(
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

export function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString();
}

export function replaceTemplate(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [name, value] of Object.entries(values)) {
    if (value.includes("'")) throw new Error(`Unsafe golden snapshot template value: ${name}`);
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  if (/{{[a-zA-Z][a-zA-Z0-9]*}}/.test(rendered)) throw new Error('Golden snapshot template is incomplete');
  return rendered;
}

export function validationUserData(input: {
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
          activation_preflight_evidence|activation_preflight_forbidden_state|activation_preflight_host_prerequisites|activation_preflight_user_state|activation_preflight_runtime_state|activation_preflight_owner_state|activation_preflight_root_ssh_state|activation_preflight_root_local_state|activation_preflight_log_state|activation_preflight_cloud_init|activation_preflight_container_state|activation_runtime_setup|activation_terminal_runtime|activation_docker_start|activation_postgres_pull|activation_postgres_start|activation_postgres_ready|activation_services_start|activation_services_ready|activation_terminal_runtime_ready|activation_gateway_ready|activation_shell_ready|activation_sync_agent_ready|activation_gateway_health) reportedStage="$activationStage" ;;
        esac
      fi
      callbackToken="$(cat /run/matrix-golden-snapshot-callback-token 2>/dev/null)"
      python3 - "$reportedStage" /run/matrix-golden-service-diagnostics.json >/run/matrix-golden-failure.json <<'PY'
    import json
    import os
    import sys

    reported_stage, diagnostics_path = sys.argv[1:]
    payload = {
        'eventId': '${input.callbackEventId}',
        'phase': 'failed',
        'role': 'validation',
        'stage': reported_stage,
        'bundleVersion': '${bundleVersion}',
        'bundleSha256': '${input.bundleSha256}',
    }
    if os.path.isfile(diagnostics_path) and not os.path.islink(diagnostics_path):
        try:
            with open(diagnostics_path, 'rb') as handle:
                raw = handle.read(131073)
            if len(raw) <= 131072:
                diagnostics = json.loads(raw)
                if isinstance(diagnostics, dict):
                    payload['serviceDiagnostics'] = diagnostics
        except (OSError, ValueError, UnicodeError):
            print('Golden service diagnostics unavailable; reporting failure stage only', file=sys.stderr)
    json.dump(payload, sys.stdout, separators=(',', ':'))
    PY
      printf 'header = "authorization: Bearer %s"\\n' "$callbackToken" |
        curl --config - --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 2 --retry-max-time 60 --connect-timeout 10 --max-time 10 -H 'content-type: application/json' --data-binary @/run/matrix-golden-failure.json '${input.callbackUrl}'
      rm -f /run/matrix-golden-snapshot-callback-token /run/matrix-golden-failure.json /run/matrix-golden-validation.json /run/matrix-golden-activation-stage /run/matrix-golden-service-diagnostics.json
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
    rm -f /run/matrix-golden-snapshot-callback-token /run/matrix-golden-validation.json /run/matrix-golden-activation-stage /run/matrix-golden-service-diagnostics.json
    exit "$validationStatus"
`;
}

export function exactLabels(buildId: string, snapshotId: string, role: 'builder' | 'validation', validationOrdinal?: number) {
  return {
    'matrix.snapshot-build': buildId,
    'matrix.snapshot-id': snapshotId,
    'matrix.role': role,
    ...(role === 'validation' ? { 'matrix.validation-ordinal': String(validationOrdinal) } : {}),
  };
}

export function providerFailure(context: string, err: unknown): Error {
  const kind = err instanceof Error ? err.name : typeof err;
  console.error(`[golden-snapshot] ${context} failed: ${kind}`);
  return err instanceof CustomerVpsError
    ? err
    : new Error('Golden snapshot provider operation failed');
}
