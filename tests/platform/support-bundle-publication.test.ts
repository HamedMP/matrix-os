import { readFileSync } from 'node:fs';
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
