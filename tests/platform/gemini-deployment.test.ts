import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const binding = 'platform-gemini-live-api-key:1';
const member = 'serviceAccount:runtime@example.com';
const policy = { bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [member] }] };
const secretEnv = { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'platform-gemini-live-api-key', key: '1' } } };
function run(mode: string, overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-deploy-')); dirs.push(dir);
  writeFileSync(join(dir, 'gcloud'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('access')) throw new Error('Deployment must not read key bytes');
if (args.includes('revisions')) process.stdout.write(process.env.REVISION);
else if (args.includes('get-iam-policy')) process.stdout.write(process.env[args[0] === 'projects' ? 'PROJECT_POLICY' : 'SECRET_POLICY']);
else process.stdout.write(process.env.SECRET_STATE);
`);
  chmodSync(join(dir, 'gcloud'), 0o700);
  return spawnSync('bash', ['scripts/ci/platform-gemini-env.sh', mode, 'reviewed-revision'], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
      GCP_PROJECT_ID: 'example', GCP_REGION: 'example', CLOUD_RUN_SERVICE_ACCOUNT: 'runtime@example.com',
      GEMINI_API_KEY_SECRET_BINDING: binding, SECRET_STATE: 'ENABLED', SECRET_POLICY: JSON.stringify(policy),
      PROJECT_POLICY: '{"bindings":[]}', REVISION: JSON.stringify({ spec: { containers: [{ env: [secretEnv] }] } }), ...overrides },
  });
}
describe('Gemini platform deployment', () => {
  it('keeps the existing key mounted across the real production deployment path', () => {
    const workflow = readFileSync('.github/workflows/platform-cloud-run.yml', 'utf8');
    expect(workflow).toContain('GEMINI_API_KEY_SECRET_BINDING: ${{ vars.GEMINI_API_KEY_SECRET_BINDING }}');
    expect(workflow).toContain('gemini_secret_bindings="$(scripts/ci/platform-gemini-env.sh secret-bindings)"');
    expect(workflow).toMatch(/--set-secrets [^\n]*\$\{gemini_secret_bindings\}/);
    expect(workflow).toContain('scripts/ci/platform-gemini-env.sh preflight-secrets');
    for (const revision of ['CANDIDATE_REVISION', 'PRODUCTION_REVISION', 'worker_revision']) {
      expect(workflow).toContain(`scripts/ci/platform-gemini-env.sh verify-revision "$${revision}"`);
    }
  });
  it('uses a pinned secret reference and leaves unconfigured environments off', () => {
    expect(run('secret-bindings').stdout).toBe(`,GEMINI_API_KEY=${binding}`);
    expect(run('secret-bindings', { GEMINI_API_KEY_SECRET_BINDING: '' }).stdout).toBe('');
    for (const invalid of ['key:latest', 'key:0', 'key:1,OTHER=secret:1', '../key:1']) {
      expect(run('secret-bindings', { GEMINI_API_KEY_SECRET_BINDING: invalid }).status).not.toBe(0);
    }
  });
  it('checks enabled metadata and unconditional runtime access without reading key bytes', () => {
    const good = run('preflight-secrets'); expect(good.status, good.stderr).toBe(0); expect(good.stdout).toBe('');
    expect(run('preflight-secrets', { SECRET_STATE: 'DISABLED' }).status).not.toBe(0);
    expect(run('preflight-secrets', { SECRET_POLICY: '{"bindings":[]}', PROJECT_POLICY: JSON.stringify(policy) }).status).toBe(0);
    expect(run('preflight-secrets', { SECRET_POLICY: '{}', PROJECT_POLICY: JSON.stringify(policy) }).status).toBe(0);
    expect(run('preflight-secrets', { SECRET_POLICY: '{"bindings":[]}' }).status).not.toBe(0);
    expect(run('preflight-secrets', { SECRET_POLICY: 'invalid' }).status).not.toBe(0);
    expect(run('preflight-secrets', { SECRET_POLICY: '{"bindings":[{"role":4,"members":[]}]}', PROJECT_POLICY: JSON.stringify(policy) }).status).not.toBe(0);
    expect(run('preflight-secrets', { SECRET_POLICY: JSON.stringify({ bindings: [{ ...policy.bindings[0], condition: { expression: 'false' } }] }) }).status).not.toBe(0);
  });
  it('rejects a deployed revision with missing, plaintext, duplicate, or incorrect key bindings', () => {
    expect(run('verify-revision').status).toBe(0);
    for (const env of [[], [{ name: 'GEMINI_API_KEY', value: 'private-key' }], [secretEnv, secretEnv],
      [{ ...secretEnv, valueFrom: { secretKeyRef: { name: 'other', key: '1' } } }]]) {
      const result = run('verify-revision', { REVISION: JSON.stringify({ spec: { containers: [{ env }] } }) });
      expect(result.status).not.toBe(0); expect(result.stdout + result.stderr).not.toContain('private-key');
    }
  });
});
