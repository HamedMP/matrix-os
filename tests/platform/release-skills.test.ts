import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('release skills', () => {
  it.each([
    ['release-platform', 'platform-cloud-run.yml'],
    ['release-matrix-stable', 'host-bundle-release.yml'],
  ])('%s is mirrored for Claude and only dispatches real %s inputs', (name, workflowFile) => {
    const skill = read(`.agents/skills/${name}/SKILL.md`);
    expect(read(`.claude/skills/${name}/SKILL.md`)).toBe(skill);
    expect(skill.split('\n')[1]).toBe(`name: ${name}`);
    expect(skill).toContain(`gh workflow run ${workflowFile} --ref main`);

    const inputs = Object.keys(parse(read(`.github/workflows/${workflowFile}`)).on.workflow_dispatch.inputs);
    const usedInputs = [...skill.matchAll(/-f ([a-z_]+)=/g)].map((match) => match[1]);
    expect(usedInputs.length).toBeGreaterThan(0);
    for (const input of usedInputs) expect(inputs).toContain(input);
  });

  // `--ref main` runs whatever main is when the dispatch lands. Without a pin a
  // commit nobody approved can reach canary or production traffic.
  describe('approved-commit pin', () => {
    const approved = 'a'.repeat(40);
    const guard = (env: Record<string, string>) =>
      spawnSync('bash', ['scripts/ci/assert-expected-sha.sh'], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
      });

    it('stops a run whose commit is not the approved one', () => {
      const result = guard({ EXPECTED_SHA: approved, GITHUB_SHA: 'b'.repeat(40) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(approved);
      expect(result.stderr).toContain('b'.repeat(40));
    });

    it('lets the approved commit through, in any letter case', () => {
      expect(guard({ EXPECTED_SHA: approved, GITHUB_SHA: approved }).status).toBe(0);
      expect(guard({ EXPECTED_SHA: approved.toUpperCase(), GITHUB_SHA: approved }).status).toBe(0);
    });

    it('rejects a short or malformed pin instead of treating it as no pin', () => {
      expect(guard({ EXPECTED_SHA: 'aaaaaaa', GITHUB_SHA: approved }).status).toBe(1);
      expect(guard({ EXPECTED_SHA: 'main', GITHUB_SHA: approved }).status).toBe(1);
    });

    it('does not block push-triggered runs, which carry no pin', () => {
      expect(guard({ EXPECTED_SHA: '', GITHUB_SHA: approved }).status).toBe(0);
    });

    it.each([
      ['host-bundle-release.yml', 'dev-bundle-gate'],
      ['platform-cloud-run.yml', 'deploy'],
    ])('%s checks the pin before anything is built or published', (workflowFile, firstJob) => {
      const workflow = parse(read(`.github/workflows/${workflowFile}`));
      expect(workflow.on.workflow_dispatch.inputs.expected_sha).toMatchObject({
        required: false,
        default: '',
        type: 'string',
      });
      // Every other job depends on this one, so a failed pin stops the whole run.
      const jobs: Record<string, { needs?: string | string[] }> = workflow.jobs;
      const waitsFor = (name: string): boolean =>
        [jobs[name].needs ?? []].flat().some((need) => need === firstJob || waitsFor(need));
      for (const name of Object.keys(jobs)) {
        if (name !== firstJob) expect(waitsFor(name), `${name} must wait for ${firstJob}`).toBe(true);
      }
      const steps: Array<{ uses?: string; run?: string; env?: Record<string, string> }> =
        workflow.jobs[firstJob].steps;
      const guardIndex = steps.findIndex((step) => step.run?.includes('scripts/ci/assert-expected-sha.sh'));
      expect(guardIndex).toBeGreaterThan(-1);
      expect(steps[guardIndex].env?.EXPECTED_SHA).toBe('${{ inputs.expected_sha }}');
      // Only the checkout that provides the script may run first.
      expect(steps.slice(0, guardIndex).every((step) => step.uses?.startsWith('actions/checkout@'))).toBe(true);
    });

    it.each(['release-platform', 'release-matrix-stable'])('%s pins every dispatch', (name) => {
      const skill = read(`.agents/skills/${name}/SKILL.md`);
      const dispatches = skill.split('\n').flatMap((line, index, lines) => {
        if (!line.includes('gh workflow run ') || !line.includes('--ref main')) return [];
        let command = line;
        for (let next = index; lines[next].trimEnd().endsWith('\\'); next += 1) command += lines[next + 1];
        return [command];
      });
      expect(dispatches.length).toBeGreaterThan(0);
      for (const command of dispatches) expect(command).toContain('-f expected_sha="$SHA"');
    });
  });

  it('retires the old release command instead of pushing to main', () => {
    const command = read('.claude/commands/release.md');
    expect(command).toContain('release-platform');
    expect(command).toContain('release-matrix-stable');
    expect(command).not.toContain('git push origin main');
  });
});
