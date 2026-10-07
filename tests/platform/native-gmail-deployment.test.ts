import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/platform-cloud-run.yml', 'utf8'));
const steps = workflow.jobs.deploy.steps as { name: string; run?: string; if?: string }[];
const step = (name: string) => steps.find(entry => entry.name === name);
const callback = 'https://app.example.com/api/integrations/gmail/oauth/callback';
const baseEnv: Record<string, string> = {
  ...Object.fromEntries(Object.keys(workflow.jobs.deploy.env).map(key => [key, 'fixture'])),
  DEPLOY_ENVIRONMENT: 'staging', PLATFORM_PUBLIC_URL: 'https://app.example.com',
  MATRIX_API_ORIGIN: 'https://api.example.com', CUSTOM_MCP_ENABLED: 'false',
  WHATSAPP_ENABLED: 'false', WHATSAPP_ENCRYPTION_KEY_VERSION: '1',
  GOLDEN_SNAPSHOT_BUILDS_ENABLED: 'false', MATRIX_CARD_TRIALS_ENABLED: 'true',
  MATRIX_CARD_TRIAL_DAYS: '3', MATRIX_PREBILLING_PROVISIONING_MAX_ACTIVE: '4',
  PLATFORM_SPEECH_ENABLED: 'false', MATRIX_PLATFORM_SPEECH_RUNTIME_ENABLED: 'false',
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'false', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'false',
  MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: 'false', IMAGE_DIGEST: 'image@sha256:fixture',
  GMAIL_OAUTH_ENABLED: 'false', GMAIL_OAUTH_CLIENT_ID: '', GMAIL_OAUTH_CALLBACK_URL: '',
  GMAIL_OAUTH_CLIENT_SECRET_VERSION: '1', GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1',
};
const enabledEnv = { GMAIL_OAUTH_ENABLED: 'true',
  GMAIL_OAUTH_CLIENT_ID: 'fixture.apps.googleusercontent.com', GMAIL_OAUTH_CALLBACK_URL: callback };
const execute = (script: string, overrides: Record<string, string> = {}) => spawnSync('bash', ['-c', script], {
  encoding: 'utf8', env: { PATH: process.env.PATH, ...baseEnv, ...overrides },
});
const validate = (overrides: Record<string, string> = {}) => execute(step('Validate deployment configuration')!.run!, overrides);
function deploy(overrides: Record<string, string> = {}) {
  // Exercise the workflow's real command with a local function; GCP is never contacted.
  return execute(`gcloud() { if [ "$2 $3" = "services describe" ]; then return 1; fi; printf '%s\\n' "$@"; }
    ${step('Deploy tagged revision')!.run!.split('candidate_url=')[0]}
    printf '%s\\n' "$deploy_json"`, overrides);
}
function bindings(result: ReturnType<typeof deploy>, flag: string) {
  expect(result.status, result.stderr).toBe(0);
  const args = result.stdout.trim().split('\n');
  return args[args.indexOf(flag) + 1];
}

describe('Native Gmail Cloud Run deployment', () => {
  it('defaults off and declares only public configuration and pinned version inputs', () => {
    expect(workflow.jobs.deploy.env.GMAIL_OAUTH_ENABLED).toBe("${{ vars.GMAIL_OAUTH_ENABLED || 'false' }}");
    for (const key of ['GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CALLBACK_URL']) {
      expect(workflow.jobs.deploy.env[key]).toBe(`\${{ vars.${key} }}`);
    }
    for (const key of ['GMAIL_OAUTH_CLIENT_SECRET_VERSION', 'GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION']) {
      expect(workflow.jobs.deploy.env[key]).toBe(`\${{ vars.${key} || '1' }}`);
    }
    expect(workflow.jobs.deploy.env).not.toHaveProperty('GMAIL_OAUTH_CLIENT_SECRET');
    expect(workflow.jobs.deploy.env).not.toHaveProperty('GMAIL_CREDENTIAL_ENCRYPTION_KEY');
    expect(validate().status).toBe(0);
  });

  it.each(['true', 'false'])('retains configured credentials for cleanup when the feature switch is %s', enabled => {
    const configuredEnv = { ...enabledEnv, GMAIL_OAUTH_ENABLED: enabled };
    const validation = validate(configuredEnv);
    expect(validation.status, validation.stderr).toBe(0);
    const result = deploy({ ...configuredEnv, GMAIL_OAUTH_CLIENT_SECRET_VERSION: '3', GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION: '7' });
    const env = bindings(result, '--set-env-vars').slice(3).split('|');
    const secrets = bindings(result, '--set-secrets').split(',');
    expect(env).toContain(`GMAIL_OAUTH_ENABLED=${enabled}`);
    expect(env).toContain(`GMAIL_OAUTH_CALLBACK_URL=${callback}`);
    expect(env).toContain('GMAIL_OAUTH_CLIENT_ID=fixture.apps.googleusercontent.com');
    expect(env.some(value => /^GMAIL_(OAUTH_CLIENT_SECRET|CREDENTIAL_ENCRYPTION_KEY)=/.test(value))).toBe(false);
    expect(secrets).toContain('GMAIL_OAUTH_CLIENT_SECRET=gmail-oauth-client-secret:3');
    expect(secrets).toContain('GMAIL_CREDENTIAL_ENCRYPTION_KEY=gmail-credential-encryption-key:7');
  });

  it('requires no Gmail registration or secret bindings for an unconfigured disabled deployment', () => {
    const result = deploy();
    expect(bindings(result, '--set-env-vars').slice(3).split('|')).toContain('GMAIL_OAUTH_ENABLED=false');
    expect(bindings(result, '--set-secrets')).not.toContain('GMAIL_');
    expect(bindings(result, '--set-env-vars')).not.toContain('GMAIL_OAUTH_CLIENT_ID=');
    expect(bindings(result, '--set-env-vars')).not.toContain('GMAIL_OAUTH_CALLBACK_URL=');
  });

  it.each([
    { GMAIL_OAUTH_ENABLED: 'TRUE' },
    { GMAIL_OAUTH_CLIENT_ID: '' },
    { GMAIL_OAUTH_CLIENT_ID: 'client|INJECTED=true' },
    { GMAIL_OAUTH_CLIENT_ID: 'client\nINJECTED=true' },
    { GMAIL_OAUTH_CLIENT_ID: 'x'.repeat(513) },
    { GMAIL_OAUTH_CALLBACK_URL: 'http://app.example.com/api/integrations/gmail/oauth/callback' },
    { GMAIL_OAUTH_CALLBACK_URL: 'https://api.example.com/api/integrations/gmail/oauth/callback' },
    { GMAIL_OAUTH_CALLBACK_URL: `${callback}?audience=other` },
    { GMAIL_OAUTH_CALLBACK_URL: `${callback}#fragment` },
    { GMAIL_OAUTH_CALLBACK_URL: 'https://owner@app.example.com/api/integrations/gmail/oauth/callback' },
    { PLATFORM_PUBLIC_URL: 'https://owner@app.example.com', GMAIL_OAUTH_CALLBACK_URL: 'https://owner@app.example.com/api/integrations/gmail/oauth/callback' },
    { PLATFORM_PUBLIC_URL: 'https://app.example.com/path', GMAIL_OAUTH_CALLBACK_URL: 'https://app.example.com/path/api/integrations/gmail/oauth/callback' },
    { GMAIL_OAUTH_CLIENT_SECRET_VERSION: 'latest' },
    { GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION: '0' },
    { GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION: '1,INJECTED=secret:1' },
  ])('rejects unsafe enabled configuration: %j', overrides => {
    expect(validate({ ...enabledEnv, ...overrides }).status).not.toBe(0);
  });

  it('rejects delimiters in public origins or disabled Gmail inputs', () => {
    expect(validate({ GMAIL_OAUTH_CALLBACK_URL: 'invalid|INJECTED=true' }).status).not.toBe(0);
    expect(validate({ PLATFORM_PUBLIC_URL: 'https://app.example.com|INJECTED=true' }).status).not.toBe(0);
  });

  it.each([
    { GMAIL_OAUTH_CLIENT_ID: enabledEnv.GMAIL_OAUTH_CLIENT_ID },
    { GMAIL_OAUTH_CALLBACK_URL: callback },
    { ...enabledEnv, GMAIL_OAUTH_ENABLED: 'false', GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION: 'latest' },
    { ...enabledEnv, GMAIL_OAUTH_ENABLED: 'false', GMAIL_OAUTH_CLIENT_SECRET_VERSION: '0' },
    { ...enabledEnv, GMAIL_OAUTH_ENABLED: 'false', GMAIL_OAUTH_CALLBACK_URL: `${callback}?wrong=1` },
  ])('fails closed on partial or invalid retained cleanup configuration: %j', overrides => {
    expect(validate(overrides).status).not.toBe(0);
  });

  it.each([
    ['ENABLED', true, false, 0],
    ['DISABLED', true, false, 1],
    ['DESTROYED', true, false, 1],
    ['ENABLED', false, false, 1],
    ['ENABLED', true, true, 1],
  ])('verifies both secret versions and unconditional runtime access (%s, %s, %s)', (state, access, conditional, expectedStatus) => {
    const verification = step('Verify Gmail OAuth secrets');
    expect(verification).toHaveProperty('if', "${{ env.GMAIL_OAUTH_ENABLED == 'true' || env.GMAIL_OAUTH_CLIENT_ID != '' || env.GMAIL_OAUTH_CALLBACK_URL != '' }}");
    const policy = JSON.stringify({ bindings: access ? [{ role: 'roles/secretmanager.secretAccessor',
      members: ['serviceAccount:fixture'], ...(conditional ? { condition: { expression: 'false' } } : {}) }] : [] });
    const result = execute(`gcloud() {
      printf '%s\\n' "$*" >&2
      if [ "$2 $3" = "versions describe" ]; then printf '%s\\n' "$TEST_STATE";
      elif [ "$2" = "get-iam-policy" ]; then printf '%s\\n' "$TEST_POLICY";
      else return 1; fi
    }
    ${verification!.run}`, { TEST_STATE: state, TEST_POLICY: policy, GMAIL_OAUTH_CLIENT_SECRET_VERSION: '3', GMAIL_CREDENTIAL_ENCRYPTION_KEY_VERSION: '7' });
    expect(result.status, result.stderr).toBe(expectedStatus);
    if (expectedStatus === 0) {
      expect(result.stderr).toContain('versions describe 3 --secret gmail-oauth-client-secret');
      expect(result.stderr).toContain('versions describe 7 --secret gmail-credential-encryption-key');
    }
    expect(result.stderr).not.toContain('versions access');
  });

  it('fails before deployment when the second secret is disabled or lacks runtime access', () => {
    const policy = JSON.stringify({ bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:fixture'] }] });
    for (const mode of ['disabled', 'denied', 'failed']) {
      const result = execute(`gcloud() {
        if [ "$2 $3" = "versions describe" ]; then
          if [[ "$*" == *gmail-credential-encryption-key* ]] && [ "$TEST_MODE" = disabled ]; then printf 'DISABLED'; else printf 'ENABLED'; fi
        elif [ "$2" = "get-iam-policy" ]; then
          if [ "$3" = gmail-credential-encryption-key ]; then
            if [ "$TEST_MODE" = failed ]; then return 1;
            elif [ "$TEST_MODE" = denied ]; then printf '{"bindings":[]}';
            else printf '%s' "$TEST_POLICY"; fi
          else printf '%s' "$TEST_POLICY"; fi
        else return 1; fi
      }
      ${step('Verify Gmail OAuth secrets')!.run}`, { TEST_MODE: mode, TEST_POLICY: policy });
      expect(result.status, result.stderr).not.toBe(0);
    }
  });
});
