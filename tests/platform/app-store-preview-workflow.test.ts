import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { appStorePreviewBindings } from '../../scripts/ci/platform-app-store-preview-env.mjs';
describe('isolated App Store preview opt-in', () => {
  it('stays disabled by default and binds no primary storage/signing secrets', () => {
    expect(appStorePreviewBindings({})).toEqual({ environment: '|MATRIX_APP_STORE_ENABLED=false', secrets: '', secretNames: [] });
  });
  it('requires explicit enablement and validated reviewer/key metadata', () => {
    expect(() => appStorePreviewBindings({ APP_STORE_PREVIEW_ENABLED: 'yes' })).toThrow();
    expect(() => appStorePreviewBindings({ APP_STORE_PREVIEW_ENABLED: 'true' })).toThrow();
    expect(() => appStorePreviewBindings({ APP_STORE_PREVIEW_ENABLED: 'true', PREVIEW_APP_STORE_REVIEWER_CLERK_IDS: 'user_a|ATTACK=true' })).toThrow();
    expect(() => appStorePreviewBindings({ APP_STORE_PREVIEW_ENABLED: 'true', PREVIEW_APP_STORE_REVIEWER_CLERK_IDS: 'user_a', PREVIEW_APP_STORE_SIGNING_KEY_ID: 'production-v1' })).toThrow();
  });
  it('uses only new preview secret names and leaves bundle storage alone', () => {
    const value = appStorePreviewBindings({ APP_STORE_PREVIEW_ENABLED: 'true', PREVIEW_APP_STORE_REVIEWER_CLERK_IDS: ' user_author, user_reviewer,user_author ' });
    expect(value.environment).toContain('|MATRIX_APP_STORE_ENABLED=true');
    expect(value.environment).toContain('MATRIX_APP_STORE_REVIEWER_CLERK_IDS=user_author,user_reviewer');
    expect(value.environment).toContain('MATRIX_APP_STORE_SIGNING_KEY_ID=preview-app-store-v1');
    expect(value.secretNames).toHaveLength(6); expect(value.secretNames.every(name => name.startsWith('app-store-preview-'))).toBe(true);
    expect(value.secrets).toContain('R2_ACCESS_KEY_ID=app-store-preview-r2-access-key-id:latest');
    expect(value.secrets).not.toContain('R2_BUNDLES_'); expect(value.secrets).not.toContain('=r2-access-key-id:');
  });
  it('resolves a current open same-repository PR head and rejects forks or closed PRs', () => {
    const workflow = parse(readFileSync('.github/workflows/preview-platform.yml', 'utf8'));
    const run = workflow.jobs.preview.steps.find(step => step.id === 'source').run;
    for (const [state, repository, accepted] of [['open', 'Example/matrix-os', true], ['closed', 'Example/matrix-os', false], ['open', 'attacker/fork', false]] as const) {
      const directory = mkdtempSync(join(tmpdir(), 'app-store-source-'));
      try {
        const output = join(directory, 'output');
        const result = spawnSync('bash', ['-c', 'gh() { printf \"%s\" \"$APP_STORE_FAKE_PR\"; }; export -f gh;\n' + run], { encoding: 'utf8', env: { ...process.env,
          PR_NUMBER: '123', GITHUB_REPOSITORY: 'Example/matrix-os', GITHUB_OUTPUT: output,
          APP_STORE_FAKE_PR: JSON.stringify({ state, head: { sha: 'a'.repeat(40), repo: { full_name: repository } } }),
        } });
        expect(result.status === 0, result.stderr).toBe(accepted);
        expect(existsSync(output) ? readFileSync(output, 'utf8') : '').toBe(accepted ? `head_sha=${'a'.repeat(40)}\n` : '');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
  it('deploys the selected same-repository PR head with no traffic and an explicit optional input', () => {
    const workflow = parse(readFileSync('.github/workflows/preview-platform.yml', 'utf8'));
    expect(workflow.on.workflow_dispatch.inputs.app_store).toMatchObject({ type: 'boolean', default: false });
    const steps = workflow.jobs.preview.steps;
    const resolve = steps.find(step => step.id === 'source'); expect(resolve.run).toContain('.head.repo.full_name'); expect(resolve.run).toContain('head_sha=');
    const checkout = steps.find(step => String(step.uses).startsWith('actions/checkout@')); expect(checkout.with.ref).toContain('steps.source.outputs.head_sha');
    const deploy = steps.find(step => step.name === 'Deploy zero-traffic tagged revision to preview service');
    expect(deploy.run).toContain('--no-traffic'); expect(deploy.env.APP_STORE_PREVIEW_ENV_BINDINGS).toContain('steps.app_store.outputs.environment'); expect(deploy.env.APP_STORE_PREVIEW_SECRET_BINDINGS).toContain('steps.app_store.outputs.secrets');
    expect(workflow.jobs.preview.env.APP_STORE_PREVIEW_ENABLED).toContain("github.event_name == 'workflow_dispatch'");
  });
});
