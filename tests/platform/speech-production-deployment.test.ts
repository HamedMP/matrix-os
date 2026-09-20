import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workflow = readFileSync(join(root, '.github/workflows/platform-cloud-run.yml'), 'utf8');
const installer = readFileSync(join(root, 'scripts/install-server.sh'), 'utf8');
const enabledEnv = {
  PLATFORM_SPEECH_ENABLED: 'true', MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: 'true',
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'false',
  MATRIX_FUNDED_AI_RELAY_URL: '', PLATFORM_SPEECH_PROVIDER: 'openai', PLATFORM_SPEECH_MODEL: 'gpt-4o-mini-transcribe',
  PLATFORM_SPEECH_POLICY_REVISION: 'speech-v1', PLATFORM_SPEECH_MICROUSD_PER_MINUTE: '1000',
  PLATFORM_SPEECH_FUNDING_SOURCES: 'addon', PLATFORM_SPEECH_OWNER_AUDIO_ENABLED: 'true',
};

function run(mode: string, env: Record<string, string>) {
  return execFileSync('bash', ['scripts/ci/platform-speech-production-env.sh', mode], {
    cwd: root, env: { PATH: process.env.PATH!, ...env }, stdio: 'pipe',
  });
}

function fakeGcloud(script: string) {
  const bin = mkdtempSync(join(tmpdir(), 'speech-gcloud-'));
  const path = join(bin, 'gcloud');
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
  chmodSync(path, 0o755);
  return bin;
}

describe('production speech deployment contract', () => {
  it('keeps platform service, host provisioning, and text relay rollout independent', () => {
    expect(workflow).toContain("PLATFORM_SPEECH_ENABLED: ${{ vars.PLATFORM_SPEECH_ENABLED || 'false' }}");
    expect(workflow).toContain("MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: ${{ vars.MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED || 'false' }}");
    expect(workflow).toContain("MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: ${{ vars.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED || 'false' }}");
    expect(workflow).toContain("MATRIX_FUNDED_AI_RUNTIME_ENABLED: ${{ vars.MATRIX_FUNDED_AI_RUNTIME_ENABLED || 'false' }}");
    expect(workflow).toContain('scripts/ci/platform-speech-production-env.sh validate');
  });

  it('preflights and binds dedicated speech secrets', () => {
    for (const binding of [
      'PLATFORM_SPEECH_OPENAI_API_KEY=platform-speech-openai-api-key:latest',
      'PLATFORM_SPEECH_SECRET=platform-speech-secret:latest',
    ]) expect(workflow).toContain(binding);
    expect(workflow).toContain('scripts/ci/platform-speech-production-env.sh preflight-secrets');
    expect(workflow).toContain('scripts/ci/platform-speech-production-env.sh verify-revision');
  });

  it('fails closed on invalid enabled production policy', () => {
    for (const override of [
      { PLATFORM_SPEECH_ENABLED: 'yes' },
      { PLATFORM_SPEECH_MICROUSD_PER_MINUTE: '0' },
      { PLATFORM_SPEECH_FUNDING_SOURCES: 'free' },
      { PLATFORM_SPEECH_MODEL: 'model|injected' },
    ]) expect(() => run('validate', { ...enabledEnv, ...override })).toThrow();
    expect(() => run('validate', enabledEnv)).not.toThrow();
    expect(() => run('validate', { ...enabledEnv, MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: 'http://relay.test' })).toThrow();
  });

  it('accepts independent host exposure and text relay flags', () => {
    expect(() => run('validate', { ...enabledEnv, MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: 'false' })).not.toThrow();
    expect(() => run('validate', { ...enabledEnv, MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'false' })).not.toThrow();
    expect(() => run('validate', { ...enabledEnv, MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true', MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.example.com' })).not.toThrow();
    expect(() => run('validate', {
      ...enabledEnv,
      PLATFORM_SPEECH_ENABLED: 'false',
      MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: 'true',
      MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'false',
    })).not.toThrow();
  });

  it('rejects missing speech secret IAM access', () => {
    const bin = fakeGcloud('[[ "$*" == *"versions describe"* ]] && exit 0\nprintf "serviceAccount:somebody-else@example.com\\n"');
    expect(() => run('preflight-secrets', { ...enabledEnv, PATH: `${bin}:${process.env.PATH}`, GCP_PROJECT_ID: 'project', CLOUD_RUN_SERVICE_ACCOUNT: 'runtime@example.com' })).toThrow();
  });

  it('rejects tampered candidate values, secret versions, and preview fields', () => {
    const fixture = (price = '1000', secretVersion = 'latest', preview = false) => JSON.stringify({ spec: { containers: [{ env: [
      ...Object.entries(enabledEnv).filter(([name]) => name !== 'MATRIX_FUNDED_AI_RELAY_URL').map(([name, value]) => ({ name, value: name === 'PLATFORM_SPEECH_MICROUSD_PER_MINUTE' ? price : value })),
      { name: 'PLATFORM_SPEECH_OPENAI_API_KEY', valueFrom: { secretKeyRef: { name: 'platform-speech-openai-api-key', key: secretVersion } } },
      { name: 'PLATFORM_SPEECH_SECRET', valueFrom: { secretKeyRef: { name: 'platform-speech-secret', key: 'latest' } } },
      ...(preview ? [{ name: 'PLATFORM_SPEECH_PREVIEW_NO_CHARGE', value: 'true' }] : []),
    ] }] } });
    for (const json of [fixture('999'), fixture('1000', '1'), fixture('1000', 'latest', true)]) {
      const bin = fakeGcloud(`cat <<'JSON'\n${json}\nJSON`);
      expect(() => run('verify-revision', { ...enabledEnv, PATH: `${bin}:${process.env.PATH}`, GCP_PROJECT_ID: 'project', GCP_REGION: 'region', CANDIDATE_REVISION: 'candidate' })).toThrow();
    }
    const bin = fakeGcloud(`cat <<'JSON'\n${fixture()}\nJSON`);
    expect(() => run('verify-revision', { ...enabledEnv, PATH: `${bin}:${process.env.PATH}`, GCP_PROJECT_ID: 'project', GCP_REGION: 'region', CANDIDATE_REVISION: 'candidate' })).not.toThrow();
  });

  it('forbids preview funding knobs in production', () => {
    const deploy = workflow.slice(workflow.indexOf('- name: Deploy tagged revision'), workflow.indexOf('- name: Verify deployed provisioning contract'));
    expect(deploy).toContain('--set-env-vars');
    expect(deploy).not.toContain('--remove-env-vars');
    expect(deploy).not.toMatch(/PLATFORM_SPEECH_PREVIEW_(NO_CHARGE|NOT_AFTER|MAX_OPERATIONS_PER_RUNTIME)/);
  });

  it('preserves activated host speech configuration on installer reruns', () => {
    for (const name of ['MATRIX_PLATFORM_SPEECH_ENABLED', 'MATRIX_PLATFORM_SPEECH_ORIGIN', 'MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN']) {
      expect(installer).toContain(`read_env_value /opt/matrix/env/host.env ${name}`);
      expect(installer).toContain(`${name}=\${`);
    }
  });
});
