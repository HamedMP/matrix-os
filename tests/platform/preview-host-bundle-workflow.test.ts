import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Outcome: staging tests can publish a branch host bundle to the preview
// platform. Faults detected: the workflow (or its URL guard) sending a bundle
// or the preview operator secret to the production platform, running branch
// code with publish credentials, unpinned actions, or a build that drifts from
// the release build.

const root = process.cwd();
const workflowPath = join(root, '.github/workflows/preview-host-bundle.yml');
const releasePath = join(root, '.github/workflows/host-bundle-release.yml');
const guardScript = join(root, 'scripts/ci/resolve-preview-platform-url.sh');

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = {
  environment?: string | { name: string };
  permissions?: Record<string, string>;
  'timeout-minutes'?: number;
  env?: Record<string, string>;
  needs?: string | string[];
  steps: Step[];
};
type Workflow = {
  on: Record<string, { inputs?: Record<string, Record<string, unknown>> }>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress'?: boolean | string };
  jobs: Record<string, Job>;
};

function load(path: string): { text: string; doc: Workflow } {
  const text = readFileSync(path, 'utf8');
  return { text, doc: YAML.parse(text) as Workflow };
}

function runGuard(url: string | undefined) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  if (url !== undefined) env.PREVIEW_PUBLIC_URL = url;
  return spawnSync('bash', [guardScript], { env, encoding: 'utf8' });
}

describe('preview platform URL guard', () => {
  it('defaults to the preview host and normalizes a trailing slash', () => {
    expect(runGuard(undefined).stdout.trim()).toBe('https://preview.matrix-os.com');
    const result = runGuard('https://preview.matrix-os.com/');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('https://preview.matrix-os.com');
  });

  it.each([
    ['https://PREVIEW.matrix-os.com', 'https://preview.matrix-os.com'],
    ['https://matrix-platform-preview-abc123def4-ey.a.run.app', 'https://matrix-platform-preview-abc123def4-ey.a.run.app'],
    ['https://pr-42---matrix-platform-preview-abc123def4-ey.a.run.app/', 'https://pr-42---matrix-platform-preview-abc123def4-ey.a.run.app'],
  ])('accepts the allowlisted preview origin %s', (url, expected) => {
    const result = runGuard(url);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it.each([
    'https://app.matrix-os.com',
    'https://app.matrix-os.com/',
    'https://APP.matrix-os.com',
    'https://api.matrix-os.com',
    'https://matrix-os.com',
    'https://www.matrix-os.com',
    'https://app.matrix-os.com.',
    'https://app.matrix-os.com..',
    'https://preview.matrix-os.com.',
    'https://matrix-platform-abc123def4-ey.a.run.app',
    'https://pr-42---matrix-platform-abc123def4-ey.a.run.app',
    'https://203.0.113.5',
    'https://[2001:db8::1]',
    'https://preview.matrix-os.com.evil.example',
    'https://evil-preview.matrix-os.com',
    'https://matrix-platform-preview-abc123def4-ey.a.run.app.evil.example',
    'https://pr-0---matrix-platform-preview-abc123def4-ey.a.run.app',
    'https://future-prod.matrix-os.com',
  ])('refuses the non-allowlisted host %s', (url) => {
    const result = runGuard(url);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    'http://preview.matrix-os.com',
    'https://preview.matrix-os.com/path',
    'https://user@preview.matrix-os.com',
    'https://preview.matrix-os.com:8443',
    'https://preview.matrix-os.com:443',
    'https://preview.matrix-os.com?x=1',
    'https://preview.matrix-os.com#x',
    'https://preview.matrix-os.com//',
    'preview.matrix-os.com',
    '',
  ])('refuses a non-origin or non-HTTPS URL %s', (url) => {
    const result = runGuard(url);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('preview host bundle workflow', () => {
  const { text, doc } = load(workflowPath);
  const release = load(releasePath).doc;
  const build = doc.jobs.build;
  const publish = doc.jobs.publish;

  it('runs on manual dispatch or e2e/** pushes only, with a required ref and register-only default channel', () => {
    expect(Object.keys(doc.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(doc.on).not.toHaveProperty('pull_request');
    expect(doc.on).not.toHaveProperty('pull_request_target');
    const push = doc.on.push as { branches?: string[]; tags?: unknown; 'branches-ignore'?: unknown };
    expect(push).toEqual({ branches: ['e2e/**'] });
    expect(build.steps[0].run).toMatch(/push\)[\s\S]*refs\/heads\/e2e\/\*[\s\S]*exit 1/);
    const inputs = doc.on.workflow_dispatch.inputs ?? {};
    expect(inputs.ref).toMatchObject({ required: true });
    expect(inputs.version).toMatchObject({ required: false });
    expect(inputs.channel).toMatchObject({ default: 'none', options: ['none', 'dev'] });
  });

  it('pins every action to a full commit SHA', () => {
    const uses = Object.values(doc.jobs).flatMap((job) => job.steps.map((step) => step.uses).filter(Boolean));
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it('keeps workflow permissions read-only and grants OIDC only to the publish job', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('serializes runs per ref and bounds every job', () => {
    expect(doc.concurrency.group).toBe('preview-host-bundle-${{ inputs.ref || github.ref }}');
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
    for (const job of Object.values(doc.jobs)) expect(job['timeout-minutes']).toBeGreaterThan(0);
  });

  it('builds the requested ref with the release build environment and no publish credentials', () => {
    const checkout = build.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ inputs.ref || github.sha }}');
    expect(build.env?.INPUT_REF).toBe('${{ inputs.ref || github.sha }}');
    expect(build.env?.INPUT_CHANNEL).toBe("${{ inputs.channel || 'none' }}");
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    expect(build.steps.some((step) => step.run?.includes('./scripts/build-host-bundle.sh'))).toBe(true);
    const releaseEnv = release.jobs.build.env ?? {};
    for (const [key, value] of Object.entries(releaseEnv)) {
      if (key.startsWith('NEXT_PUBLIC_')) expect(build.env?.[key], key).toBe(value);
    }
    const buildText = YAML.stringify(build);
    expect(buildText).not.toMatch(/R2_|AWS_|PLATFORM_SECRET|GCP_|platform-preview-secret/);
    expect(build.environment).toBeUndefined();
  });

  it('publishes from the trusted workflow revision in the Preview environment', () => {
    expect(publish.environment).toBe('Preview');
    expect(publish.needs).toEqual(['build']);
    const checkout = publish.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBeUndefined();
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const auth = publish.steps.find((step) => step.uses?.startsWith('google-github-actions/auth@'));
    expect(auth?.with).toMatchObject({
      workload_identity_provider: '${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}',
      service_account: '${{ secrets.GCP_SERVICE_ACCOUNT }}',
    });
  });

  it('targets only the preview platform with the preview operator secret, masked', () => {
    expect(text).not.toContain('secrets.PLATFORM_SECRET');
    expect(text).not.toContain('vars.PLATFORM_PUBLIC_URL');
    expect(text).not.toContain('app.matrix-os.com');
    expect(text).not.toContain('api.matrix-os.com');
    expect(text).toContain('vars.PREVIEW_PUBLIC_URL');
    const publishText = publish.steps.map((step) => step.run ?? '').join('\n');
    expect(publishText).toContain('scripts/ci/resolve-preview-platform-url.sh');
    // One publish job serves both triggers: the refusal guard must be unconditional.
    expect(Object.values(doc.jobs).every((job) => !(job as { if?: string }).if)).toBe(true);
    const guardSteps = publish.steps.filter((step) => step.run?.includes('resolve-preview-platform-url.sh'));
    expect(guardSteps.length).toBe(2);
    for (const step of guardSteps) expect((step as { if?: string }).if).toBeUndefined();
    expect(publishText).toMatch(/gcloud secrets versions access latest[\s\S]*--secret platform-preview-secret/);
    expect(publishText).toMatch(/::add-mask::\$\{?PLATFORM_SECRET/);
    expect(publishText).toMatch(/\.\/scripts\/publish-release\.sh "\$VERSION" --channel "\$CHANNEL"/);
    expect(publishText).not.toContain('GITHUB_ENV');
  });

  it('re-validates version and channel in the publish job instead of trusting build outputs', () => {
    const validate = publish.steps.find((step) => step.name === 'Validate build outputs');
    expect(validate).toBeDefined();
    expect((validate as { if?: string }).if).toBeUndefined();
    expect(validate?.run).toMatch(/\*-preview-\*/);
    expect(validate?.run).toMatch(/\*-collabpair-\*/);
    expect(validate?.run).toMatch(/none\|dev\)/);
    const index = publish.steps.indexOf(validate as Step);
    const secretIndex = publish.steps.findIndex((step) => step.run?.includes('platform-preview-secret'));
    expect(index).toBeLessThan(secretIndex);
  });

  it('verifies the registered sha256 and reports version and sha256 in the job summary', () => {
    const publishText = publish.steps.map((step) => step.run ?? '').join('\n');
    expect(publishText).toContain('/system-bundles/releases/');
    expect(publishText).toContain('GITHUB_STEP_SUMMARY');
    expect(publishText).toMatch(/sha256/);
  });

  it('never interpolates dispatch inputs directly into shell scripts', () => {
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps) expect(step.run ?? '').not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
    }
  });
});
