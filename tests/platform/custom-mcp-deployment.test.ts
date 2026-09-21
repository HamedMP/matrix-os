import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/platform-cloud-run.yml', 'utf8'));
const steps = workflow.jobs.deploy.steps as { name: string; run?: string }[];
const step = (name: string) => steps.find((entry) => entry.name === name)!.run!;
const baseEnv = Object.fromEntries([
  'GCP_PROJECT_ID', 'GCP_REGION', 'ARTIFACT_REPOSITORY', 'CLOUD_RUN_SERVICE',
  'CLOUD_RUN_SERVICE_ACCOUNT', 'PLATFORM_PUBLIC_URL', 'MATRIX_API_ORIGIN',
  'MATRIX_COLLABORATION_ACTIVE_KEY_ID', 'MATRIX_COLLABORATION_ALLOWED_ORIGINS',
  'MATRIX_APP_URL', 'MATRIX_APP_DOMAIN_HOSTS', 'MATRIX_CODE_DOMAIN_HOSTS',
  'PLATFORM_SPEECH_ENABLED', 'MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED',
  'MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED', 'MATRIX_FUNDED_AI_RUNTIME_ENABLED',
].map((name) => [name, 'fixture']));
baseEnv.PLATFORM_PUBLIC_URL = 'https://app.example.com';
baseEnv.MATRIX_API_ORIGIN = 'https://api.example.com';
baseEnv.PLATFORM_SPEECH_ENABLED = 'false';
baseEnv.MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED = 'false';
baseEnv.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED = 'false';
baseEnv.MATRIX_FUNDED_AI_RUNTIME_ENABLED = 'false';

function validate(overrides: Record<string, string>) {
  return spawnSync('bash', ['-c', step('Validate deployment configuration')], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...baseEnv,
      DEPLOY_ENVIRONMENT: 'staging', GOLDEN_SNAPSHOT_BUILDS_ENABLED: 'false',
      MATRIX_CARD_TRIALS_ENABLED: 'true', MATRIX_CARD_TRIAL_DAYS: '3',
      MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: '4', CUSTOM_MCP_ENABLED: 'false', MCP_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1', ...overrides },
  });
}

function deploy(enabled: boolean) {
  // Run the actual deployment command with a shell stub; never contact GCP.
  const script = step('Deploy tagged revision').split('candidate_url=')[0];
  return spawnSync('bash', ['-c', `gcloud() { if [ "$2 $3" = "services describe" ]; then return 1; fi; printf '%s\\n' "$@"; }\n${script}\nprintf '%s\\n' "$deploy_json"`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, ...Object.fromEntries(
      Object.keys(workflow.jobs.deploy.env).map((key) => [key, 'fixture'])),
      DEPLOY_ENVIRONMENT: 'staging', IMAGE_DIGEST: 'image@sha256:fixture',
      CUSTOM_MCP_ENABLED: String(enabled), MCP_OAUTH_CLIENT_ID: '', MCP_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1',
      MCP_OAUTH_CALLBACK_URL: 'https://app.example.com/api/mcp-servers/oauth/callback' },
  });
}

describe('Custom MCP Cloud Run deployment', () => {
  it('passes the broker configuration and dedicated secret to the actual deploy command', () => {
    for (const key of ['CUSTOM_MCP_ENABLED', 'MCP_OAUTH_CLIENT_ID', 'MCP_OAUTH_CALLBACK_URL']) {
      expect(workflow.jobs.deploy.env[key]).toContain(`vars.${key}`);
    }
    const result = deploy(true);
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split('\n');
    const env = args[args.indexOf('--set-env-vars') + 1];
    const secrets = args[args.indexOf('--set-secrets') + 1];
    expect(env.startsWith('^|^')).toBe(true);
    expect(env.slice(3).split('|')).toContain('CUSTOM_MCP_ENABLED=true');
    expect(env).not.toContain('MCP_CREDENTIAL_ENCRYPTION_KEY=');
    expect(secrets.split(',')).toContain('MCP_CREDENTIAL_ENCRYPTION_KEY=mcp-credential-encryption-key:1');
    expect(result.stdout).toContain('MCP_OAUTH_CALLBACK_URL=https://app.example.com/api/mcp-servers/oauth/callback');
    expect(result.stdout).toContain('MCP_OAUTH_CLIENT_ID=');
    expect(result.stdout).toContain('MCP_CREDENTIAL_ENCRYPTION_KEY=mcp-credential-encryption-key:1');
  });

  it('does not require or bind an encryption secret when explicitly disabled', () => {
    expect(validate({}).status).toBe(0);
    const result = deploy(false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CUSTOM_MCP_ENABLED=false');
    expect(result.stdout).not.toContain('MCP_CREDENTIAL_ENCRYPTION_KEY=');
  });

  it.each([
    { CUSTOM_MCP_ENABLED: 'typo' },
    { CUSTOM_MCP_ENABLED: 'true', MCP_OAUTH_CALLBACK_URL: '' },
    { CUSTOM_MCP_ENABLED: 'true', MCP_OAUTH_CALLBACK_URL: 'http://app.example.com/api/mcp-servers/oauth/callback' },
    { MCP_OAUTH_CLIENT_ID: 'client|INJECTED=true' },
    { CUSTOM_MCP_ENABLED: 'true', MCP_OAUTH_CALLBACK_URL: 'https://wrong.example.com/api/mcp-servers/oauth/callback' },
    { CUSTOM_MCP_ENABLED: 'true', MCP_OAUTH_CALLBACK_URL: 'https://app.example.com/api/mcp-servers/oauth/callback', MCP_CREDENTIAL_ENCRYPTION_KEY_VERSION: 'latest' },
  ])('rejects invalid broker deployment configuration: %j', (env) => {
    expect(validate(env).status).not.toBe(0);
  });

  it.each([
    ['ENABLED', 'serviceAccount:fixture', 0],
    ['DISABLED', 'serviceAccount:fixture', 1],
    ['ENABLED', '', 1],
  ])('checks secret version and runtime access before deployment (%s, %s)', (state, member, status) => {
    const verification = steps.find((entry) => entry.name === 'Verify Custom MCP credential secret');
    expect(verification).toHaveProperty('if', "${{ env.CUSTOM_MCP_ENABLED == 'true' }}");
    const result = spawnSync('bash', ['-c', `
      gcloud() {
        if [ "$2 $3" = "versions describe" ]; then printf '%s\\n' "$TEST_STATE";
        elif [ "$2" = "get-iam-policy" ]; then printf '%s\\n' "$TEST_MEMBER";
        else return 1; fi
      }
      ${verification!.run}
    `], { encoding: 'utf8', env: { PATH: process.env.PATH, ...baseEnv,
      MCP_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1', TEST_STATE: String(state), TEST_MEMBER: String(member) } });
    expect(result.status, result.stderr).toBe(status);
  });

  it('allows dynamic OAuth registration without a static client ID', () => {
    expect(validate({ CUSTOM_MCP_ENABLED: 'true', MCP_OAUTH_CLIENT_ID: '',
      MCP_OAUTH_CALLBACK_URL: 'https://app.example.com/api/mcp-servers/oauth/callback' }).status).toBe(0);
  });
});
