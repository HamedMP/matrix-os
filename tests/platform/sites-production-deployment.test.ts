import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { checkPublicSitesEnv } from '../../packages/platform/src/platform-startup-env.js';

type Step = { name?: string; run?: string };
const root = process.cwd();
const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
const operations = readFileSync(join(root, 'specs/551-public-app-sites/operations.md'), 'utf8');
const deployment = YAML.parse(workflow).jobs.deploy;
const temporaryDirectories: string[] = [];
const secretNames = [
  'sites-edge-secret',
  'r2-sites-account-id',
  'r2-sites-bucket',
  'r2-sites-endpoint',
  'r2-sites-access-key-id',
  'r2-sites-secret-access-key',
] as const;

const step = (name: string): string => {
  const script = deployment.steps.find((entry: Step) => entry.name === name)?.run;
  expect(script, name).toBeTypeOf('string');
  return script;
};

function fakeGcloud() {
  const bin = mkdtempSync(join(tmpdir(), 'matrix-sites-gcloud-'));
  temporaryDirectories.push(bin);
  const executable = join(bin, 'gcloud');
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const secret = args[args.indexOf('--secret') + 1];
if (args.includes('revisions')) process.stdout.write(process.env.MOCK_REVISION || '{}');
else if (args.includes('get-iam-policy')) process.stdout.write('serviceAccount:runtime@example.com\\n');
else if (args.includes('access')) {
  const values = JSON.parse(process.env.MOCK_VALUES || '{}');
  const value = values[secret] || '';
  const out = args.find((value) => value.startsWith('--out-file='));
  if (out) fs.writeFileSync(out.slice('--out-file='.length), value);
  else process.stdout.write(value);
} else process.stdout.write('ENABLED\\n');
`);
  chmodSync(executable, 0o700);
  return bin;
}

const goodValues = {
  'sites-edge-secret': 's'.repeat(40),
  'r2-sites-account-id': 'a'.repeat(32),
  'r2-sites-bucket': 'matrix-public-sites',
  'r2-sites-endpoint': `https://${'a'.repeat(32)}.eu.r2.cloudflarestorage.com`,
  'r2-sites-access-key-id': 'sites-access-key',
  'r2-sites-secret-access-key': 'sites-secret-key',
  'r2-bucket': 'matrixos-sync',
  'r2-bundles-bucket': 'matrixos-bundles',
};

function run(mode: string, values: Record<string, string> = goodValues, revision: unknown = {}) {
  const bin = fakeGcloud();
  return spawnSync('bash', ['scripts/ci/platform-sites-env.sh', mode, 'reviewed-revision'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GCP_PROJECT_ID: 'example',
      GCP_REGION: 'europe-west3',
      CLOUD_RUN_SERVICE_ACCOUNT: 'runtime@example.com',
      MATRIX_PUBLIC_SITES_ENABLED: 'true',
      PLATFORM_PUBLIC_URL: 'https://platform.example.com',
      MOCK_VALUES: JSON.stringify(values),
      MOCK_REVISION: JSON.stringify(revision),
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production Matrix.page deployment contract', () => {
  it('fails startup when public Sites are enabled without edge proof or dedicated storage', () => {
    expect(checkPublicSitesEnv({ MATRIX_PUBLIC_SITES_ENABLED: 'false' })).toEqual([]);
    expect(checkPublicSitesEnv({ MATRIX_PUBLIC_SITES_ENABLED: 'true' }, () => {})).toEqual([
      'SITES_EDGE_SECRET',
      'R2_SITES_ACCOUNT_ID/R2_SITES_ENDPOINT',
      'R2_SITES_BUCKET',
      'R2_SITES_ACCESS_KEY_ID',
      'R2_SITES_SECRET_ACCESS_KEY',
    ]);
    expect(checkPublicSitesEnv({
      MATRIX_PUBLIC_SITES_ENABLED: 'true',
      SITES_EDGE_SECRET: 's'.repeat(40),
      R2_SITES_ACCOUNT_ID: 'a'.repeat(32),
      R2_SITES_ENDPOINT: `https://${'a'.repeat(32)}.eu.r2.cloudflarestorage.com`,
      R2_SITES_BUCKET: 'matrix-public-sites',
      R2_SITES_ACCESS_KEY_ID: 'sites-key',
      R2_SITES_SECRET_ACCESS_KEY: 'sites-secret',
      R2_BUCKET: 'matrixos-sync',
      R2_BUNDLES_BUCKET: 'matrixos-bundles',
    }, () => {})).toEqual([]);
    expect(checkPublicSitesEnv({
      MATRIX_PUBLIC_SITES_ENABLED: 'true',
      SITES_EDGE_SECRET: `${'s'.repeat(40)}\n`,
      R2_SITES_ACCOUNT_ID: 'a'.repeat(32),
      R2_SITES_ENDPOINT: 'https://other.invalid',
      R2_SITES_BUCKET: 'matrixos-sync',
      R2_SITES_ACCESS_KEY_ID: 'sites-key',
      R2_SITES_SECRET_ACCESS_KEY: 'sites-secret',
      R2_BUCKET: 'matrixos-sync',
    }, () => {})).toEqual(expect.arrayContaining([
      'SITES_EDGE_SECRET',
      'R2_SITES_ENDPOINT',
      'R2_SITES_BUCKET',
    ]));
  });

  it('keeps every Sites credential secret-backed in replacement deployments', () => {
    expect(workflow).toContain('- "scripts/ci/platform-sites-env.sh"');
    expect(deployment.env.MATRIX_PUBLIC_SITES_ENABLED).toBe("${{ vars.MATRIX_PUBLIC_SITES_ENABLED || 'true' }}");
    const bindings = run('secret-bindings');
    expect(bindings.status, bindings.stderr).toBe(0);
    for (const name of secretNames) expect(bindings.stdout).toContain(name);
    expect(workflow).toContain('${sites_secret_bindings}');
    expect(workflow).toContain('scripts/ci/platform-sites-env.sh preflight-secrets');
    expect(operations).toContain('sites-edge-secret');
    expect(operations).toContain('r2-sites-bucket');
    expect(operations).toContain('CLOUDFLARE_API_TOKEN');
    expect(operations).toContain('platform-cloud-run.yml');
  });

  it('refuses incomplete, shared, or malformed private Sites storage without exposing values', () => {
    expect(run('preflight-secrets').status).toBe(0);
    for (const values of [
      { ...goodValues, 'sites-edge-secret': 'short' },
      { ...goodValues, 'r2-sites-bucket': goodValues['r2-bucket'] },
      { ...goodValues, 'r2-sites-bucket': goodValues['r2-bundles-bucket'] },
      { ...goodValues, 'r2-sites-endpoint': 'http://private.invalid' },
      { ...goodValues, 'r2-sites-secret-access-key': '' },
    ]) {
      const result = run('preflight-secrets', values);
      expect(result.status).not.toBe(0);
      if (values['r2-sites-secret-access-key']) {
        expect(result.stdout + result.stderr).not.toContain(values['r2-sites-secret-access-key']);
      }
    }
  });

  it('rejects a candidate or promoted revision that drops or rewires a Sites binding', () => {
    const env = [
      { name: 'MATRIX_PUBLIC_SITES_ENABLED', value: 'true' },
      ...secretNames.map((name) => ({
        name: name.replaceAll('-', '_').toUpperCase(),
        valueFrom: { secretKeyRef: { name, key: 'latest' } },
      })),
    ];
    const valid = run('verify-revision', goodValues, { spec: { containers: [{ env }] } });
    expect(valid.status, valid.stderr).toBe(0);
    expect(run('verify-revision', goodValues, { spec: { containers: [{ env: env.slice(0, -1) }] } }).status).not.toBe(0);
    const plaintext = [...env.slice(0, -1), { name: 'R2_SITES_SECRET_ACCESS_KEY', value: 'plaintext' }];
    expect(run('verify-revision', goodValues, { spec: { containers: [{ env: plaintext }] } }).status).not.toBe(0);
  });

  it('checks candidate storage, deploys the fixed-domain Worker, and verifies the edge after promotion', () => {
    expect(step('Smoke candidate revision')).toContain('$CANDIDATE_URL/vps/sites-storage-check');
    const deployWorker = step('Deploy Matrix.page Worker');
    expect(deployWorker).toContain('--config wrangler.sites.toml');
    expect(deployWorker).not.toContain('--config packages/edge-router/wrangler.sites.toml');
    expect(deployWorker).toContain('SITES_PLATFORM_ORIGIN:${PLATFORM_PUBLIC_URL}');
    expect(deployWorker).toContain('--secrets-file');
    expect(deployWorker).not.toContain('echo "$sites_edge_secret"');
    const verify = step('Verify Matrix.page routing');
    expect(verify).toContain('https://matrix.page/sites-deployment-smoke');
    expect(verify).toContain('expected a 404');
  });
});
