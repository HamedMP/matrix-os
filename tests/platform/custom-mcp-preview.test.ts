import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/preview-platform.yml', 'utf8'));
const deploy = workflow.jobs.preview.steps.find((s: { name?: string }) => s.name === 'Deploy zero-traffic tagged revision to preview service').run as string;

describe('Custom MCP isolated platform preview', () => {
  it.each([true, false])('binds only the preview key when enabled=%s', (enabled) => {
    expect(workflow.on.workflow_dispatch.inputs.custom_mcp.default).toBe(false);
    const script = deploy.split('service_base_url=')[0];
    const result = spawnSync('bash', ['-c', `gcloud() { printf '%s\\n' "$@"; }\n${script}\ndeploy_preview https://pr-42---preview.example.com`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GCP_PROJECT_ID: 'fixture', GCP_REGION: 'region',
        CLOUD_RUN_PREVIEW_SERVICE: 'preview', CLOUD_RUN_SERVICE_ACCOUNT: 'preview-sa', IMAGE: 'image',
        PR_NUMBER: '42', PREVIEW_PUBLIC_URL: 'https://preview.example.com', MATRIX_CARD_TRIALS_ENABLED: 'true',
        MATRIX_CARD_TRIAL_DAYS: '3', CUSTOM_MCP_ENABLED: String(enabled),
        MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'false', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'false' },
    });
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split('\n');
    const env = args[args.indexOf('--set-env-vars') + 1];
    const secrets = args[args.indexOf('--set-secrets') + 1];
    expect(env.slice(3).split('|')).toContain(`CUSTOM_MCP_ENABLED=${enabled}`);
    expect(env.slice(3).split('|')).toContain('MCP_OAUTH_CALLBACK_URL=https://pr-42---preview.example.com/api/mcp-servers/oauth/callback');
    expect(env.startsWith('^|^')).toBe(true);
    expect(env.slice(3).split('|')).toContain('MATRIX_APP_DOMAIN_HOSTS=preview.example.com,pr-42---preview.example.com');
    expect(env).not.toContain('MCP_CREDENTIAL_ENCRYPTION_KEY=');
    expect(secrets).not.toContain('MCP_CREDENTIAL_ENCRYPTION_KEY=mcp-credential-encryption-key:');
    expect(secrets.includes('MCP_CREDENTIAL_ENCRYPTION_KEY=mcp-credential-encryption-key-preview:1')).toBe(enabled);
  });
});
