import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { checkPublicSitesEnv } from '../../packages/platform/src/platform-startup-env.js';

type Step = { name?: string; run?: string; if?: string };
const root = process.cwd();
const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
const sitesEnvScript = readFileSync(join(root, 'scripts/ci/platform-sites-env.sh'), 'utf8');
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
if (args.includes('services') && args.includes('list')) {
  if (process.env.MOCK_SERVICE_LIST_FAIL === 'true') process.exit(1);
  process.stdout.write(process.env.MOCK_SERVICE_NAME || '');
}
else if (args.includes('services')) process.stdout.write(process.env.MOCK_SERVICE || '{}');
else if (args.includes('revisions')) process.stdout.write(process.env.MOCK_REVISION || '{}');
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

function run(mode: string, values: Record<string, string> = goodValues, revision: unknown = {}, service: unknown = {},
  serviceName = 'matrix-platform', serviceListFails = false) {
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
      CLOUD_RUN_SERVICE: 'matrix-platform',
      MATRIX_PUBLIC_SITES_ENABLED: 'true',
      SITES_EDGE_SECRET_VERSION: '2',
      SITES_EDGE_SECRET_PREVIOUS_VERSION: '1',
      PLATFORM_PUBLIC_URL: 'https://platform.example.com',
      MOCK_VALUES: JSON.stringify(values),
      MOCK_REVISION: JSON.stringify(revision),
      MOCK_SERVICE: JSON.stringify(service),
      MOCK_SERVICE_NAME: serviceName,
      MOCK_SERVICE_LIST_FAIL: String(serviceListFails),
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production Matrix.page deployment contract', () => {
  it('narrows endpoint parse failures without hiding unexpected validation errors', () => {
    expect(sitesEnvScript).toContain('catch (error)');
    expect(sitesEnvScript).toContain('error instanceof TypeError');
    expect(sitesEnvScript).toContain("console.error('Sites endpoint URL is invalid.');");
    expect(sitesEnvScript).toContain('throw error;');
    expect(sitesEnvScript).not.toContain('catch {\n  valid = false;');
  });

  it('fails startup when public Sites are enabled without edge proof or dedicated storage', () => {
    expect(checkPublicSitesEnv({ MATRIX_PUBLIC_SITES_ENABLED: 'false' })).toEqual([]);
    expect(checkPublicSitesEnv({ MATRIX_PUBLIC_SITES_ENABLED: 'true' }, () => {})).toEqual([
      'SITES_EDGE_SECRET',
      'SITES_EDGE_SECRET_PREVIOUS',
      'R2_SITES_ACCOUNT_ID/R2_SITES_ENDPOINT',
      'R2_SITES_BUCKET',
      'R2_SITES_ACCESS_KEY_ID',
      'R2_SITES_SECRET_ACCESS_KEY',
    ]);
    expect(checkPublicSitesEnv({
      MATRIX_PUBLIC_SITES_ENABLED: 'true',
      SITES_EDGE_SECRET: 's'.repeat(40),
      SITES_EDGE_SECRET_PREVIOUS: 'p'.repeat(40),
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
      SITES_EDGE_SECRET_PREVIOUS: 'p'.repeat(40),
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
    expect(workflow).toContain('SITES_EDGE_SECRET_VERSION');
    expect(workflow).toContain('SITES_EDGE_SECRET_PREVIOUS_VERSION');
    expect(workflow).toContain('scripts/ci/platform-sites-env.sh preflight-secrets');
    expect(workflow).toContain('scripts/ci/platform-sites-env.sh verify-transition');
    expect(operations).toContain('sites-edge-secret');
    expect(operations).toContain('r2-sites-bucket');
    expect(operations).toContain('CLOUDFLARE_API_TOKEN');
    expect(operations).toContain('platform-cloud-run.yml');
  });

  it('refuses incomplete, shared, or malformed private Sites storage without exposing values', () => {
    expect(run('preflight-secrets').status).toBe(0);
    for (const values of [
      { ...goodValues, 'sites-edge-secret': 'short' },
      { ...goodValues, 'sites-edge-secret': ` ${'s'.repeat(40)}` },
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
    const bindings = [
      { env: 'SITES_EDGE_SECRET', secret: 'sites-edge-secret', version: '2' },
      { env: 'SITES_EDGE_SECRET_PREVIOUS', secret: 'sites-edge-secret', version: '1' },
      ...secretNames.slice(1).map((name) => ({ env: name.replaceAll('-', '_').toUpperCase(), secret: name, version: 'latest' })),
    ];
    const env = [
      { name: 'MATRIX_PUBLIC_SITES_ENABLED', value: 'true' },
      ...bindings.map((binding) => ({
        name: binding.env,
        valueFrom: { secretKeyRef: { name: binding.secret, key: binding.version } },
      })),
    ];
    const valid = run('verify-revision', goodValues, { spec: { containers: [{ env }] } });
    expect(valid.status, valid.stderr).toBe(0);
    expect(run('verify-revision', goodValues, { spec: { containers: [{ env: env.slice(0, -1) }] } }).status).not.toBe(0);
    const plaintext = [...env.slice(0, -1), { name: 'R2_SITES_SECRET_ACCESS_KEY', value: 'plaintext' }];
    expect(run('verify-revision', goodValues, { spec: { containers: [{ env: plaintext }] } }).status).not.toBe(0);
  });

  it('allows only a pinned no-op or one-overlap edge-secret transition', () => {
    const service = { status: { traffic: [{ revisionName: 'live-revision', percent: 100 }] } };
    const revision = (version: string) => ({ spec: { containers: [{ env: [{ name: 'SITES_EDGE_SECRET',
      valueFrom: { secretKeyRef: { name: 'sites-edge-secret', key: version } } }] }] } });
    expect(run('verify-transition', goodValues, revision('1'), service).status).toBe(0);
    expect(run('verify-transition', goodValues, revision('2'), service).status).toBe(0);
    expect(run('verify-transition', goodValues, revision('7'), service).status).not.toBe(0);
    expect(run('verify-transition', goodValues, {}, {}, '').status).toBe(0);
    expect(run('verify-transition', goodValues, {}, {}, '', true).status).not.toBe(0);
  });

  it('checks candidate storage, deploys the fixed-domain Worker, and verifies the edge after promotion', () => {
    const candidateSmoke = step('Smoke candidate revision');
    expect(candidateSmoke).toContain('if [ "$MATRIX_PUBLIC_SITES_ENABLED" = "true" ]');
    expect(candidateSmoke).toContain('$CANDIDATE_URL/vps/sites-storage-check');
    expect(candidateSmoke).toContain('$CANDIDATE_URL/public/sites/_edge-health');
    expect(candidateSmoke).toContain('x-matrix-sites-edge');
    const deployWorker = step('Deploy Matrix.page Worker');
    expect(deployWorker).toContain('--config wrangler.sites.toml');
    expect(deployWorker).not.toContain('--config packages/edge-router/wrangler.sites.toml');
    expect(deployWorker).toContain('SITES_PLATFORM_ORIGIN:${PLATFORM_PUBLIC_URL}');
    expect(deployWorker).toContain('--secrets-file');
    expect(deployWorker).not.toContain('echo "$sites_edge_secret"');
    expect(deployWorker).toContain('wrangler deployments status');
    expect(deployWorker).toContain('wrangler rollback');
    const deployIndex = deployment.steps.findIndex((entry: Step) => entry.name === 'Deploy Matrix.page Worker');
    const promotionIndex = deployment.steps.findIndex((entry: Step) => entry.name === 'Verify promoted revision traffic');
    expect(deployIndex).toBeGreaterThan(promotionIndex);
    const verify = step('Verify Matrix.page routing');
    expect(verify).toContain('https://matrix.page/_edge-health');
    expect(verify).toContain('.status == "ok"');
    expect(verify).toContain('https://matrix.page/sites-deployment-smoke');
    expect(verify).toContain('expected a 404');
    for (const name of [
      'Set up pnpm for Matrix.page Worker',
      'Set up Node for Matrix.page Worker',
      'Install locked Matrix.page Worker dependencies',
      'Deploy Matrix.page Worker',
      'Verify Matrix.page routing',
    ]) {
      expect(deployment.steps.find((entry: Step) => entry.name === name)?.if).toContain("env.MATRIX_PUBLIC_SITES_ENABLED == 'true'");
    }
  });
});
