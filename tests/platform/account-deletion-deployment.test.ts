import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const script = join(root, 'scripts/ci/platform-account-deletion-env.sh');
const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
const temporaryDirectories: string[] = [];
const validApplePrivateKey = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
}).privateKey;
const legacyApplePrivateKey = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { format: 'pem', type: 'sec1' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
}).privateKey;
const validSecretValues = {
  'account-deletion-secret': 'd'.repeat(48),
  'clerk-user-webhook-signing-secret': `whsec_${Buffer.alloc(24, 7).toString('base64')}`,
  'apple-team-id': 'PX4JL74Y2K',
  'apple-sign-in-key-id': 'ABC123DEFG',
  'apple-sign-in-private-key': validApplePrivateKey,
  'apple-services-id': 'com.matrixos.web',
  'apple-native-client-id': 'com.matrixos.mobile',
};

function run(mode: string, extra: NodeJS.ProcessEnv = {}, fixture: Record<string, unknown> = {}, role?: 'api' | 'worker') {
  const directory = mkdtempSync(join(tmpdir(), 'account-deletion-deploy-'));
  temporaryDirectories.push(directory);
  const calls = join(directory, 'calls');
  writeFileSync(calls, '');
  const gcloud = join(directory, 'gcloud');
  writeFileSync(gcloud, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('access')) {
  const name = args[args.indexOf('--secret') + 1];
  const values = JSON.parse(process.env.MOCK_VALUES || '{}');
  process.stdout.write(values[name] || '');
} else if (args.includes('get-iam-policy')) {
  process.stdout.write('serviceAccount:runtime@example.com\\n');
} else if (args.includes('revisions')) {
  process.stdout.write(process.env.MOCK_REVISION || '{}');
} else {
  process.stdout.write('ENABLED\\n');
}
`);
  chmodSync(gcloud, 0o700);
  const values = validSecretValues;
  const args = [script, mode, 'reviewed-revision'];
  if (role) args.push(role);
  const result = spawnSync('bash', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      ACCOUNT_DELETION_CONFIGURED: 'true',
      ACCOUNT_DELETION_ENABLED: 'true',
      ACCOUNT_DELETION_SECRET_VERSION: '1',
      CLERK_USER_WEBHOOK_SECRET_VERSION: '1',
      APPLE_SIGN_IN_SECRET_VERSION: '1',
      GCP_PROJECT_ID: 'project',
      GCP_REGION: 'region',
      CLOUD_RUN_SERVICE_ACCOUNT: 'runtime@example.com',
      TMPDIR: directory,
      MOCK_CALLS: calls,
      MOCK_VALUES: JSON.stringify(values),
      MOCK_REVISION: JSON.stringify(fixture),
      ...extra,
    },
  });
  return { ...result, calls: readFileSync(calls, 'utf8'), directory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('production account deletion deployment contract', () => {
  it('defaults off and performs no secret-manager work while disabled', () => {
    for (const mode of ['validate', 'secret-bindings', 'preflight-secrets']) {
      const result = run(mode, { ACCOUNT_DELETION_CONFIGURED: 'false', ACCOUNT_DELETION_ENABLED: 'false' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(result.calls).toBe('');
    }
  });

  it('pins the durable deletion key, webhook key, and atomic Apple credential set', () => {
    const result = run('secret-bindings');
    expect(result.status, result.stderr).toBe(0);
    for (const binding of [
      'ACCOUNT_DELETION_SECRET=account-deletion-secret:1',
      'CLERK_USER_WEBHOOK_SIGNING_SECRET=clerk-user-webhook-signing-secret:1',
      'APPLE_TEAM_ID=apple-team-id:1',
      'APPLE_KEY_ID=apple-sign-in-key-id:1',
      'APPLE_PRIVATE_KEY=apple-sign-in-private-key:1',
      'APPLE_SERVICES_ID=apple-services-id:1',
      'APPLE_NATIVE_CLIENT_ID=apple-native-client-id:1',
    ]) expect(result.stdout).toContain(binding);
  });

  it('fails closed on invalid flags, versions, or secret values', () => {
    expect(run('validate', { ACCOUNT_DELETION_ENABLED: 'yes' }).status).not.toBe(0);
    expect(run('validate', { ACCOUNT_DELETION_CONFIGURED: 'false', ACCOUNT_DELETION_ENABLED: 'true' }).status).not.toBe(0);
    expect(run('validate', { ACCOUNT_DELETION_SECRET_VERSION: 'latest' }).status).not.toBe(0);
    expect(run('preflight-secrets', { MOCK_VALUES: JSON.stringify({ 'account-deletion-secret': 'short' }) }).status).not.toBe(0);
  });

  it('rejects malformed or non-PKCS8 Apple signing keys and removes the secret temp file on failure', () => {
    for (const privateKey of [
      '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n',
      legacyApplePrivateKey,
    ]) {
      const rejected = run('preflight-secrets', {
        MOCK_VALUES: JSON.stringify({ ...validSecretValues, 'apple-sign-in-private-key': privateKey }),
      });
      expect(rejected.status).not.toBe(0);
      expect(readdirSync(rejected.directory).sort()).toEqual(['calls', 'gcloud']);
    }
  });

  it('rejects Apple identifiers with trailing newlines', () => {
    for (const name of [
      'apple-team-id',
      'apple-sign-in-key-id',
      'apple-services-id',
      'apple-native-client-id',
    ] as const) {
      const rejected = run('preflight-secrets', {
        MOCK_VALUES: JSON.stringify({ ...validSecretValues, [name]: `${validSecretValues[name]}\n` }),
      });
      expect(rejected.status, `${name}: ${rejected.stderr}`).not.toBe(0);
    }
  });

  it('preflights every configured secret without printing its value', () => {
    const result = run('preflight-secrets');
    expect(result.status, result.stderr).toBe(0);
    for (const name of [
      'account-deletion-secret', 'clerk-user-webhook-signing-secret', 'apple-team-id',
      'apple-sign-in-key-id', 'apple-sign-in-private-key', 'apple-services-id', 'apple-native-client-id',
    ]) expect(result.calls).toContain(name);
    expect(result.stdout).not.toContain('PRIVATE KEY');
    expect(result.stderr).not.toContain('PRIVATE KEY');
  });

  it('verifies exact candidate, production, and worker bindings', () => {
    const env = [
      { name: 'ACCOUNT_DELETION_CONFIGURED', value: 'true' },
      { name: 'ACCOUNT_DELETION_ENABLED', value: 'true' },
      { name: 'ACCOUNT_DELETION_SECRET', valueFrom: { secretKeyRef: { name: 'account-deletion-secret', key: '1' } } },
      { name: 'CLERK_USER_WEBHOOK_SIGNING_SECRET', valueFrom: { secretKeyRef: { name: 'clerk-user-webhook-signing-secret', key: '1' } } },
      { name: 'APPLE_TEAM_ID', valueFrom: { secretKeyRef: { name: 'apple-team-id', key: '1' } } },
      { name: 'APPLE_KEY_ID', valueFrom: { secretKeyRef: { name: 'apple-sign-in-key-id', key: '1' } } },
      { name: 'APPLE_PRIVATE_KEY', valueFrom: { secretKeyRef: { name: 'apple-sign-in-private-key', key: '1' } } },
      { name: 'APPLE_SERVICES_ID', valueFrom: { secretKeyRef: { name: 'apple-services-id', key: '1' } } },
      { name: 'APPLE_NATIVE_CLIENT_ID', valueFrom: { secretKeyRef: { name: 'apple-native-client-id', key: '1' } } },
    ];
    const fixture = { spec: { containers: [{ env }] } };
    expect(run('verify-revision', {}, fixture).status).toBe(0);
    expect(run('verify-revision', {}, { spec: { containers: [{ env: env.slice(0, -1) }] } }).status).not.toBe(0);
    expect(run('verify-revision', { ACCOUNT_DELETION_SECRET_VERSION: '2' }, fixture).status).not.toBe(0);
  });

  it('retains pinned secrets while the API is disabled for rollback', () => {
    const env = [
      { name: 'ACCOUNT_DELETION_CONFIGURED', value: 'true' },
      { name: 'ACCOUNT_DELETION_ENABLED', value: 'false' },
      { name: 'ACCOUNT_DELETION_SECRET', valueFrom: { secretKeyRef: { name: 'account-deletion-secret', key: '1' } } },
      { name: 'CLERK_USER_WEBHOOK_SIGNING_SECRET', valueFrom: { secretKeyRef: { name: 'clerk-user-webhook-signing-secret', key: '1' } } },
      { name: 'APPLE_TEAM_ID', valueFrom: { secretKeyRef: { name: 'apple-team-id', key: '1' } } },
      { name: 'APPLE_KEY_ID', valueFrom: { secretKeyRef: { name: 'apple-sign-in-key-id', key: '1' } } },
      { name: 'APPLE_PRIVATE_KEY', valueFrom: { secretKeyRef: { name: 'apple-sign-in-private-key', key: '1' } } },
      { name: 'APPLE_SERVICES_ID', valueFrom: { secretKeyRef: { name: 'apple-services-id', key: '1' } } },
      { name: 'APPLE_NATIVE_CLIENT_ID', valueFrom: { secretKeyRef: { name: 'apple-native-client-id', key: '1' } } },
    ];
    const fixture = { spec: { containers: [{ env }] } };
    expect(run('verify-revision', { ACCOUNT_DELETION_ENABLED: 'false' }, fixture).status).toBe(0);
    const workerEnv = structuredClone(env);
    workerEnv[1] = { name: 'ACCOUNT_DELETION_ENABLED', value: 'true' };
    expect(run(
      'verify-revision',
      { ACCOUNT_DELETION_ENABLED: 'false' },
      { spec: { containers: [{ env: workerEnv }] } },
      'worker',
    ).status).toBe(0);
  });

  it('wires the same gated contract through API and worker revisions', () => {
    expect(workflow).toContain("ACCOUNT_DELETION_CONFIGURED: ${{ vars.ACCOUNT_DELETION_CONFIGURED || 'false' }}");
    expect(workflow).toContain("ACCOUNT_DELETION_ENABLED: ${{ vars.ACCOUNT_DELETION_ENABLED || 'false' }}");
    expect(workflow).toContain('scripts/ci/platform-account-deletion-env.sh preflight-secrets');
    expect(workflow).toContain('account_deletion_secret_bindings="$(scripts/ci/platform-account-deletion-env.sh secret-bindings)"');
    expect(workflow).toContain('ACCOUNT_DELETION_ENABLED=${ACCOUNT_DELETION_ENABLED}');
    for (const revision of ['CANDIDATE_REVISION', 'PRODUCTION_REVISION', 'worker_revision']) {
      const suffix = revision === 'worker_revision' ? ' worker' : '';
      expect(workflow).toContain(`scripts/ci/platform-account-deletion-env.sh verify-revision "$${revision}"${suffix}`);
    }
  });
});
