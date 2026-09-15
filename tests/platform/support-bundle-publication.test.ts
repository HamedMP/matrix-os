import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareHostBundleVersions, parseUpdateVersion } from '../../packages/gateway/src/system-update.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/host-bundle-release.yml', 'utf8'));
const condition = workflow.jobs.deploy.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace('needs.dev-bundle-gate', "needs['dev-bundle-gate']");
const permitsDeploy = new Function('inputs', 'github', 'needs', `return (${condition})`);

describe('support bundle publication', () => {
  it.each(['main', 'v2026.09.15-support'])('never deploys register-only bundles from %s', (ref) => {
    expect(permitsDeploy(
      { channel: 'none', deploy_after_publish: true },
      { event_name: 'workflow_dispatch', ref_type: ref === 'main' ? 'branch' : 'tag', ref_name: ref },
      { 'dev-bundle-gate': { outputs: { should_build: 'true' } } },
    )).toBe(false);
  });

  it('preserves an explicitly authorized normal-channel deployment from main', () => {
    expect(permitsDeploy(
      { channel: 'dev', deploy_after_publish: true },
      { event_name: 'workflow_dispatch', ref_type: 'branch', ref_name: 'main' },
      { 'dev-bundle-gate': { outputs: { should_build: 'true' } } },
    )).toBe(true);
  });
});


it('does not offer an older high-numbered stable release after a support install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-support-version-'));
  try {
    const output = join(dir, 'output');
    const step = workflow.jobs.build.steps.find((step: { name?: string }) => step.name === 'Generate version');
    const script = step.run.replaceAll('${{ github.run_number }}', '1276')
      .replaceAll('$(date -u +%Y.%m.%d)', '2026.09.15');
    execFileSync('bash', ['-c', script], {
      env: { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'codex/support', GITHUB_OUTPUT: output, PUBLISH_CHANNEL: 'none' },
    });
    const version = readFileSync(output, 'utf8').trim().replace('version=', '');
    expect(parseUpdateVersion(version)).toBe(version);
    const installed = { version, gitCommit: 'candidate', buildTime: '2026-09-15T17:00:00Z' };
    expect(compareHostBundleVersions(
      { version: 'v2026.09.15-1664', gitCommit: 'baseline', buildTime: '2026-09-15T13:00:00Z' }, installed,
    )).toBe(false);
    expect(compareHostBundleVersions(
      { version: 'v2026.09.16-1277', gitCommit: 'future', buildTime: '2026-09-16T13:00:00Z' }, installed,
    )).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
