import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = join(root, 'scripts/ci/platform-whatsapp-env.sh');
const bindings = [
  ['WHATSAPP_APP_SECRET', 'whatsapp-app-secret', 'latest'],
  ['WHATSAPP_VERIFY_TOKEN', 'whatsapp-verify-token', 'latest'],
  ['WHATSAPP_ACCESS_TOKEN', 'whatsapp-access-token', 'latest'],
  ['WHATSAPP_PHONE_NUMBER_ID', 'whatsapp-phone-number-id', 'latest'],
  ['WHATSAPP_GRAPH_API_VERSION', 'whatsapp-graph-api-version', 'latest'],
  ['WHATSAPP_ENCRYPTION_KEY', 'whatsapp-encryption-key', '1'],
  ['WHATSAPP_PUBLIC_URL', 'whatsapp-public-url', 'latest'],
  ['WHATSAPP_ALLOWED_SENDERS', 'whatsapp-allowed-senders', 'latest'],
] as const;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(mode: string, extra: NodeJS.ProcessEnv = {}, fixture?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-whatsapp-deploy-')); dirs.push(dir);
  const mock = join(dir, 'gcloud');
  writeFileSync(mock, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const args = process.argv.slice(2);
if (args.includes('get-iam-policy')) process.stdout.write('serviceAccount:runtime@example.com');
else if (args.includes('revisions')) process.stdout.write(process.env.MOCK_REVISION || '{}');
else if (args.includes('access')) {
  const name = args[args.indexOf('--secret') + 1];
  const values = JSON.parse(process.env.MOCK_VALUES || '{}');
  process.stdout.write(values[name] || '');
} else process.stdout.write('ENABLED');
`); chmodSync(mock, 0o700);
  const values = {
    'whatsapp-app-secret': 'private-app-secret', 'whatsapp-verify-token': 'private-verify-token',
    'whatsapp-access-token': 'private-access-token', 'whatsapp-phone-number-id': '123456789',
    'whatsapp-graph-api-version': 'v25.0', 'whatsapp-encryption-key': 'a'.repeat(64),
    'whatsapp-public-url': 'https://app.example.com', 'whatsapp-allowed-senders': '46700000000,SE.abc',
  };
  const calls = join(dir, 'calls'); writeFileSync(calls, '');
  const result = spawnSync('bash', [script, mode, 'reviewed-revision'], { encoding: 'utf8', env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, WHATSAPP_ENABLED: 'false', WHATSAPP_ENCRYPTION_KEY_VERSION: '1',
    GCP_PROJECT_ID: 'example-project', GCP_REGION: 'example-region', CLOUD_RUN_SERVICE_ACCOUNT: 'runtime@example.com',
    MOCK_CALLS: calls, MOCK_VALUES: JSON.stringify(values), MOCK_REVISION: JSON.stringify(fixture ?? {}), ...extra,
  } });
  return { ...result, calls: readFileSync(calls, 'utf8') };
}

describe('WhatsApp Cloud Run deployment contract', () => {
  it('defaults off with no secret bindings or secret-manager activity', () => {
    for (const mode of ['validate', 'secret-bindings', 'preflight-secrets']) {
      const result = run(mode, { WHATSAPP_ENABLED: undefined });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(''); expect(result.calls).toBe('');
    }
  });
  it('requires explicit boolean opt-in and a numeric pinned encryption version', () => {
    expect(run('validate', { WHATSAPP_ENABLED: 'yes' }).status).not.toBe(0);
    expect(run('validate', { WHATSAPP_ENABLED: 'true', WHATSAPP_ENCRYPTION_KEY_VERSION: 'latest' }).status).not.toBe(0);
    expect(run('validate', { WHATSAPP_ENABLED: 'true' }).status).toBe(0);
  });
  it('binds every config value as a secret and pins the encryption key', () => {
    const result = run('secret-bindings', { WHATSAPP_ENABLED: 'true', WHATSAPP_ENCRYPTION_KEY_VERSION: '7' });
    expect(result.status, result.stderr).toBe(0);
    for (const [name, secret, version] of bindings) expect(result.stdout).toContain(`${name}=${secret}:${name === 'WHATSAPP_ENCRYPTION_KEY' ? '7' : version}`);
    expect(result.stdout).not.toContain('private-access-token');
  });
  it('preflights all secret versions, validates private configuration and checks runtime IAM', () => {
    const result = run('preflight-secrets', { WHATSAPP_ENABLED: 'true' });
    expect(result.status, result.stderr).toBe(0);
    for (const [, name] of bindings) expect(result.calls).toContain(name);
    expect(result.calls).toContain('get-iam-policy'); expect(result.calls).toContain('access');
    expect(result.stdout).not.toContain('private-'); expect(result.stderr).not.toContain('private-');
    const invalid = run('preflight-secrets', { WHATSAPP_ENABLED: 'true', MOCK_VALUES: JSON.stringify({ 'whatsapp-app-secret': 'private-invalid' }) });
    expect(invalid.status).not.toBe(0); expect(invalid.stderr).not.toContain('private-invalid');
  });
  it('verifies exact secret bindings and rejects a partially configured or disabled revision', () => {
    const env = bindings.map(([name, secret, key]) => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } }));
    const complete = { spec: { containers: [{ env }] } };
    expect(run('verify-revision', { WHATSAPP_ENABLED: 'true' }, complete).status).toBe(0);
    expect(run('verify-revision', { WHATSAPP_ENABLED: 'true' }, { spec: { containers: [{ env: env.slice(1) }] } }).status).not.toBe(0);
    expect(run('verify-revision', {}, complete).status).not.toBe(0);
    expect(run('verify-revision', {}, { spec: { containers: [{ env: [] }] } }).status).toBe(0);
  });
  it('preserves the configuration across candidate, production, and CPU-backed worker revisions', () => {
    const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
    expect(workflow).toContain("WHATSAPP_ENABLED: ${{ vars.WHATSAPP_ENABLED || 'false' }}");
    expect(workflow).toContain("WHATSAPP_ENCRYPTION_KEY_VERSION: ${{ vars.WHATSAPP_ENCRYPTION_KEY_VERSION || '1' }}");
    expect(workflow).toContain('scripts/ci/platform-whatsapp-env.sh validate');
    expect(workflow).toContain('scripts/ci/platform-whatsapp-env.sh preflight-secrets');
    expect(workflow).toContain('whatsapp_secret_bindings="$(scripts/ci/platform-whatsapp-env.sh secret-bindings)"');
    expect(workflow).toContain('${speech_secret_bindings}${whatsapp_secret_bindings}');
    for (const revision of ['CANDIDATE_REVISION', 'PRODUCTION_REVISION', 'worker_revision']) {
      expect(workflow).toContain(`scripts/ci/platform-whatsapp-env.sh verify-revision "$${revision}"`);
    }
    const candidate = workflow.slice(workflow.indexOf('- name: Deploy tagged revision'), workflow.indexOf('- name: Verify deployed provisioning contract'));
    expect(candidate).not.toContain('--no-cpu-throttling');
    expect(workflow).toContain('render-platform-worker-service.mjs');
    const renderer = readFileSync(join(root, 'scripts/render-platform-worker-service.mjs'), 'utf8');
    expect(renderer).toContain('const spec = structuredClone(sourceSpec)');
    expect(renderer).toContain('annotations["run.googleapis.com/cpu-throttling"] = "false"');
  });
});
