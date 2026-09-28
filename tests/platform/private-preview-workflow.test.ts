import { spawnSync } from 'node:child_process';
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
  jobs: Record<string, Job>;
};
const step = (job: string, name: string): Step => {
  const found = workflow.jobs[job]!.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing step ${job}/${name}`);
  return found;
};

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
printf '%s' '{"head":{"sha":"${headSha}","ref":"feature","repo":{"full_name":"HamedMP/matrix-os"}},"user":{"login":"octo-dev"}}'
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
  });

  async function reap(states: string) {
    const directory = await scratch();
    const deletes = join(directory, 'deletes');
    await writeFile(deletes, '');
    await writeFile(join(directory, 'curl'), `#!/usr/bin/env bash
url=""
for arg in "$@"; do case "$arg" in http*) url="$arg" ;; esac; done
case "$url" in
  */vps/fleet) printf '%s' "$FAKE_FLEET" ;;
  */vps/private-previews*) echo "$url" >> "$FAKE_DELETES"; printf '200' ;;
  *) exit 22 ;;
esac
`);
    await writeFile(join(directory, 'gh'), `#!/usr/bin/env bash
pr="\${2##*/}"
state="$(tr ',' '\\n' <<< "$FAKE_PR_STATES" | sed -n "s/^\${pr}=//p")"
if [ -z "$state" ] || [ "$state" = "unknown" ]; then exit 1; fi
echo "$state"
`);
    await chmod(join(directory, 'curl'), 0o755);
    await chmod(join(directory, 'gh'), 0o755);
    const machine = (handle: string, status = 'running') => ({ handle, status, deletedAt: null, machineId: handle });
    const result = spawnSync('bash', ['-c', step('reaper', 'Delete Private Previews for closed PRs').run!], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'HamedMP/matrix-os',
        PLATFORM_PUBLIC_URL: 'https://platform.test',
        PLATFORM_SECRET: 'platform-secret',
        FAKE_DELETES: deletes,
        FAKE_PR_STATES: states,
        FAKE_FLEET: JSON.stringify({
          machines: [
            machine('pv-1907-3fa91c2e'),
            machine('pv-1907-0badf00d'),
            machine('pv-1908-3fa91c2e'),
            machine('pv-1909-3fa91c2e'),
            machine('pv-1911-3fa91c2e', 'deleted'),
            machine('pr-1910'),
            machine('alice'),
          ],
        }),
      },
    });
    return { status: result.status, deletes: (await readFile(deletes, 'utf8')).split('\n').filter(Boolean) };
  }

  it('reaps Private Previews of closed PRs once per PR as a daily backstop', async () => {
    const { status, deletes } = await reap('1907=closed,1908=open,1909=open,1910=closed,1911=closed');
    expect(status).toBe(0);
    expect(deletes).toEqual(['https://platform.test/vps/private-previews?pr=1907']);
  });

  it('keeps Private Previews whose PR state is unknown, and fails so the skip is visible', async () => {
    const { status, deletes } = await reap('1907=closed,1908=open,1909=unknown');
    expect(status).toBe(1);
    expect(deletes).toEqual(['https://platform.test/vps/private-previews?pr=1907']);
  });
});
