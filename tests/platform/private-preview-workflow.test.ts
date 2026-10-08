import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Spec 537: the Preview workflow builds Private Preview bundles with PR
// provenance and destroys a PR's Private Previews when it closes.

interface Step { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string> }
interface Job { if?: string; needs?: string[]; steps: Step[]; env?: Record<string, string> }

const workflow = YAML.parse(readFileSync(join(process.cwd(), '.github/workflows/preview-vps.yml'), 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: boolean }> } };
  jobs: Record<string, Job>;
  concurrency: { group: string; 'cancel-in-progress': string };
};
const step = (job: string, name: string): Step => {
  const found = workflow.jobs[job]!.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing step ${job}/${name}`);
  return found;
};

// These workflow guards use the JavaScript-compatible subset of GitHub expressions.
// Evaluate their actual boolean behavior rather than matching a reassuring substring.
function evaluateExpression(expression: string, context: Record<string, unknown>): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    always: () => true,
    cancelled: () => false,
    ...context,
  }, { timeout: 100 });
}

function concurrencyGroup(eventName: string, bundleOnly = false, action = '', pr: number | string = 1907): string {
  const context = {
    github: { event_name: eventName, event: { action, pull_request: { number: eventName === 'pull_request' ? pr : undefined }, label: { name: 'preview-vps' } }, run_id: 42 },
    inputs: { pr: String(pr), bundle_only: bundleOnly },
  };
  return workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g,
    (_match, expression: string) => String(evaluateExpression(expression, context)));
}

const headSha = '0123456789abcdef0123456789abcdef01234567';
const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-private-preview-workflow-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function decide(overrides: Record<string, string>): Promise<{ status: number | null; outputs: Record<string, string> }> {
  const directory = await scratch();
  const output = join(directory, 'output');
  await writeFile(output, '');
  await writeFile(join(directory, 'gh'), `#!/usr/bin/env bash
case "$*" in
  */comments*) printf '%s' "\${FAKE_BUNDLE_COMMENT_IDS:-}" ;;
  *) printf '%s' "$FAKE_PR_JSON" ;;
esac
`);
  await chmod(join(directory, 'gh'), 0o755);
  const result = spawnSync('bash', ['-c', step('gate', 'Decide action').run!], {
    encoding: 'utf8',
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'HamedMP/matrix-os',
      GITHUB_REF: 'refs/pull/1907/merge',
      EVENT_NAME: 'pull_request',
      EVENT_ACTION: 'synchronize',
      PR_NUMBER: '1907',
      LABELED_NAME: '',
      HAS_LABEL: 'false',
      HAS_BUNDLE_LABEL: 'false',
      HAS_COLLABORATION_LABEL: 'false',
      EVENT_HEAD_SHA: headSha,
      EVENT_HEAD_REF: 'feature',
      EVENT_HEAD_REPO: 'HamedMP/matrix-os',
      EVENT_AUTHOR: 'octo-dev',
      REQUESTED_VERSION: '',
      VERIFY_INVENTORY: 'false',
      TEARDOWN_PREVIEW: 'false',
      BUNDLE_ONLY: 'false',
      FAKE_PR_JSON: JSON.stringify({ head: { sha: headSha, ref: 'feature', repo: { full_name: 'HamedMP/matrix-os' } }, user: { login: 'octo-dev' } }),
      ...overrides,
    },
  });
  const outputs = Object.fromEntries((await readFile(output, 'utf8')).split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  return { status: result.status, outputs };
}

describe('Private Preview bundles in the Preview workflow', () => {
  it.each([
    ['the preview-bundle label is added', { EVENT_ACTION: 'labeled', LABELED_NAME: 'preview-bundle' }, 'bundle'],
    ['a bundle-labelled PR gets a push', { HAS_BUNDLE_LABEL: 'true' }, 'bundle'],
    ['a PR has both labels', { HAS_BUNDLE_LABEL: 'true', HAS_LABEL: 'true' }, 'deploy'],
    ['an unlabelled PR gets a push', {}, 'skip'],
    ['a fork PR has the bundle label', { HAS_BUNDLE_LABEL: 'true', EVENT_HEAD_REPO: 'someone/matrix-os' }, 'skip'],
  ])('decides %s', async (_case, overrides, action) => {
    const { status, outputs } = await decide(overrides);
    expect(status).toBe(0);
    expect(outputs.action).toBe(action);
  });

  it('exposes an opt-in manual bundle action using live PR head and author without deployment', async () => {
    expect(workflow.on.workflow_dispatch.inputs.bundle_only).toMatchObject({ type: 'boolean', default: false });
    const liveSha = 'a'.repeat(40);
    const { status, outputs } = await decide({
      EVENT_NAME: 'workflow_dispatch', BUNDLE_ONLY: 'true',
      FAKE_PR_JSON: JSON.stringify({ head: { sha: liveSha, ref: 'fresh-feature', repo: { full_name: 'HamedMP/matrix-os' } }, user: { login: 'fresh-author' } }),
    });
    expect(status).toBe(0);
    expect(outputs).toMatchObject({ action: 'bundle', head_sha: liveSha, head_ref: 'fresh-feature', author: 'fresh-author', requested_version: '', teardown_private: 'false' });
    expect(workflow.jobs.build!.steps.find((candidate) => candidate.uses === 'actions/checkout@v6')?.with?.ref).toBe('${{ needs.gate.outputs.head_sha }}');
    expect((await decide({ EVENT_NAME: 'workflow_dispatch' })).outputs.action).toBe('deploy');
  });

  it('isolates bundle-only publication from the PR deployment concurrency group', () => {
    const deployment = concurrencyGroup('workflow_dispatch');
    const publication = concurrencyGroup('workflow_dispatch', true);
    expect(publication).not.toBe(deployment);
    expect(concurrencyGroup('pull_request', false, 'synchronize')).toBe(deployment);
    expect(concurrencyGroup('workflow_dispatch', true)).toBe(publication);
    expect(concurrencyGroup('workflow_dispatch', true, '', 1908)).not.toBe(publication);
    expect(evaluateExpression(workflow.concurrency['cancel-in-progress'], {
      github: { event_name: 'workflow_dispatch', event: { action: '' } },
    })).toBe(true);
    for (const [eventName, action] of [['pull_request', 'closed'], ['schedule', '']]) {
      expect(evaluateExpression(workflow.concurrency['cancel-in-progress'], {
        github: { event_name: eventName, event: { action } },
      })).toBe(false);
    }
  });

  it('keeps malformed dispatch PR text out of the other operation concurrency namespace', () => {
    const publication = concurrencyGroup('workflow_dispatch', true, '', 123);
    expect(concurrencyGroup('workflow_dispatch', false, '', '123-bundle')).not.toBe(publication);
    const deployment = concurrencyGroup('workflow_dispatch', false, '', 123);
    expect(concurrencyGroup('workflow_dispatch', true, '', '123-bundle')).not.toBe(deployment);
    expect(concurrencyGroup('schedule', false, '', '')).toBe('preview-vps-reaper-active');
  });

  it.each(['bundle', 'deploy', 'deploy_existing', 'verify', 'teardown', 'skip', 'unknown'])
    ('runs only the intended jobs for action %s, including failed/skipped builds', (action) => {
      for (const buildResult of ['success', 'failure', 'skipped']) {
        const context = { needs: { gate: { outputs: { action } }, build: { result: buildResult } } };
        const expected: Record<string, boolean> = {
          build: action === 'deploy' || action === 'bundle',
          publish_bundle: action === 'bundle' && buildResult === 'success',
          deploy: (action === 'deploy' && buildResult === 'success') || action === 'deploy_existing',
          verify_inventory: action === 'verify',
          teardown: action === 'teardown',
        };
        for (const [job, shouldRun] of Object.entries(expected)) {
          expect(Boolean(evaluateExpression(workflow.jobs[job]!.if!, context)), `${job}/${action}/${buildResult}`).toBe(shouldRun);
        }
      }
    });

  it.each<Record<string, string>>([
    { REQUESTED_VERSION: 'v2026.10.03-pr1907-1-1-0123456' },
    { VERIFY_INVENTORY: 'true' },
    { TEARDOWN_PREVIEW: 'true' },
  ])('rejects bundle-only dispatch combined with another action: %j', async (otherAction) => {
    const result = await decide({ EVENT_NAME: 'workflow_dispatch', BUNDLE_ONLY: 'true', ...otherAction });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
  });

  it('does not publish a fork or invalid SHA through manual bundle-only dispatch', async () => {
    for (const head of [
      { sha: headSha, ref: 'feature', repo: { full_name: 'someone/matrix-os' } },
      { sha: 'invalid', ref: 'feature', repo: { full_name: 'HamedMP/matrix-os' } },
    ]) {
      const result = await decide({ EVENT_NAME: 'workflow_dispatch', BUNDLE_ONLY: 'true', FAKE_PR_JSON: JSON.stringify({ head, user: { login: 'octo-dev' } }) });
      if (head.sha === 'invalid') expect(result.status).toBe(1);
      else expect(result.outputs.action).toBe('skip');
    }
  });

  it('passes the PR author as provenance, and drops a login the platform would reject', async () => {
    expect((await decide({ HAS_BUNDLE_LABEL: 'true' })).outputs.author).toBe('octo-dev');
    expect((await decide({ HAS_BUNDLE_LABEL: 'true', EVENT_AUTHOR: 'dependabot[bot]' })).outputs.author).toBe('');
  });

  it('builds the bundle, then publishes it with provenance from trusted scripts without provisioning anything', () => {
    expect(workflow.jobs.build!.if).toContain("needs.gate.outputs.action == 'bundle'");
    const job = workflow.jobs.publish_bundle!;
    expect(job.needs).toEqual(['gate', 'build']);
    expect(job.if).toContain("needs.gate.outputs.action == 'bundle'");
    expect(job.if).toContain("needs.build.result == 'success'");
    expect(step('publish_bundle', 'Checkout trusted release scripts').with).toMatchObject({ ref: 'main' });
    const publish = step('publish_bundle', 'Publish release with PR provenance (register-only, no channel)').run!;
    expect(publish).toContain('--channel none');
    expect(publish).toContain('--source-pr "$PR"');
    expect(publish).toContain('--source-author "$PR_AUTHOR"');
    const everything = job.steps.map((candidate) => candidate.run ?? '').join('\n');
    expect(everything).not.toMatch(/\/vps\/(provision|deploy)/);
  });

  it('adds provenance to shared preview bundles when the PR branch supports it', () => {
    const publish = step('deploy', 'Publish release (register-only, no channel)').run!;
    expect(publish).toContain("grep -q -- '--source-pr' scripts/publish-release.sh");
    expect(publish).toContain('--source-pr "$PR"');
  });
});

describe('Private Preview teardown in the Preview workflow', () => {
  it.each([
    ['a bundle-labelled PR closes', { EVENT_ACTION: 'closed', HAS_BUNDLE_LABEL: 'true' }, 'teardown', 'true'],
    ['a preview-labelled PR closes', { EVENT_ACTION: 'closed', HAS_LABEL: 'true' }, 'teardown', 'true'],
    ['an unlabelled PR closes', { EVENT_ACTION: 'closed' }, 'skip', 'false'],
    ['a PR whose labels were removed after a bundle closes', { EVENT_ACTION: 'closed', FAKE_BUNDLE_COMMENT_IDS: '4126949577' }, 'teardown', 'true'],
    ['a maintainer tears down the shared preview', { EVENT_NAME: 'workflow_dispatch', TEARDOWN_PREVIEW: 'true' }, 'teardown', 'false'],
  ])('decides %s', async (_case, overrides, action, teardownPrivate) => {
    const { status, outputs } = await decide(overrides);
    expect(status).toBe(0);
    expect(outputs.action).toBe(action);
    expect(outputs.teardown_private).toBe(teardownPrivate);
  });

  it('destroys the PR\'s Private Previews only on PR close, even if the shared teardown fails', () => {
    const destroy = step('teardown', 'Delete Private Previews for this PR');
    expect(destroy.if).toContain('!cancelled()');
    expect(destroy.if).toContain("needs.gate.outputs.teardown_private == 'true'");
    expect(destroy.run).toContain('-X DELETE "${PLATFORM_PUBLIC_URL}/vps/private-previews?pr=${PR}"');
    expect(destroy.run).toContain('trap \'rm -f "$response"\' EXIT');
  });

  async function reap(closedPrs: string, deleteCodes = '', ghFails = false) {
    const directory = await scratch();
    const deletes = join(directory, 'deletes');
    const ghArgs = join(directory, 'gh-args');
    await writeFile(deletes, '');
    await writeFile(join(directory, 'curl'), `#!/usr/bin/env bash
url=""
for arg in "$@"; do case "$arg" in http*) url="$arg" ;; esac; done
case "$url" in
  */vps/private-previews*)
    echo "$url" >> "$FAKE_DELETES"
    pr="\${url##*pr=}"
    code="$(tr ',' '\\n' <<< "$FAKE_DELETE_CODES" | sed -n "s/^\${pr}=//p")"
    printf '%s' "\${code:-200}" ;;
  *) exit 22 ;;
esac
`);
    await writeFile(join(directory, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_ARGS"
if [ "$FAKE_GH_FAILS" = "true" ]; then exit 1; fi
printf '%s\\n' $FAKE_CLOSED_PRS
`);
    await chmod(join(directory, 'curl'), 0o755);
    await chmod(join(directory, 'gh'), 0o755);
    const result = spawnSync('bash', ['-c', step('reaper', 'Delete Private Previews for closed PRs').run!], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'HamedMP/matrix-os',
        PLATFORM_PUBLIC_URL: 'https://platform.test',
        PLATFORM_SECRET: 'platform-secret',
        PREVIEW_TTL_HOURS: '72',
        FAKE_DELETES: deletes,
        FAKE_GH_ARGS: ghArgs,
        FAKE_CLOSED_PRS: closedPrs,
        FAKE_DELETE_CODES: deleteCodes,
        FAKE_GH_FAILS: String(ghFails),
      },
    });
    const read = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { status: result.status, deletes: await read(deletes), ghArgs: await read(ghArgs) };
  }

  it('walks PRs closed within the preview lifetime, not the capped fleet listing', async () => {
    const { status, deletes, ghArgs } = await reap('1907 1908');
    expect(status).toBe(0);
    expect(deletes).toEqual([
      'https://platform.test/vps/private-previews?pr=1907',
      'https://platform.test/vps/private-previews?pr=1908',
    ]);
    expect(ghArgs[0]).toContain('pr list --repo HamedMP/matrix-os --state closed');
    expect(ghArgs[0]).toMatch(/closed:>=\d{4}-\d{2}-\d{2}/);
  });

  it('keeps going after a failed delete and fails so it is visible', async () => {
    const { status, deletes } = await reap('1907 1908', '1907=502');
    expect(status).toBe(1);
    expect(deletes).toHaveLength(2);
  });

  it('deletes nothing and fails when closed PRs cannot be listed', async () => {
    const { status, deletes } = await reap('1907', '', true);
    expect(status).not.toBe(0);
    expect(deletes).toEqual([]);
  });
});
