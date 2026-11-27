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

  it('reuses the exact green-main dev bundle instead of cutting a VPS canary', () => {
    const skill = read('.agents/skills/release-matrix-stable/SKILL.md');
    const full = read('.agents/skills/release-full-stable/SKILL.md');

    expect(read('.claude/skills/release-matrix-stable/SKILL.md')).toBe(skill);
    expect(skill).toContain('channels/dev.json');
    expect(skill).toMatch(/exact green-main dev (?:artifact|bundle)/i);
    expect(skill).toContain('gitCommit');
    expect(skill).not.toContain('channel=canary');
    expect(skill).not.toContain('channels/canary.json');
    expect(skill).not.toMatch(/cut(?:ting)? the canary/i);

    const host = full.slice(
      full.indexOf('## 5. Release the host bundle'),
      full.indexOf('## 6. Roll out and verify the fleet'),
    );
    expect(host).toMatch(/exact green-main dev (?:artifact|bundle)/i);
    expect(host).not.toMatch(/host-bundle canary|cut(?:ting)? the canary|deploying the canary/i);
  });

  it('keeps automatic Desktop prereleases out of the release-modal history', () => {
    const skill = read('.agents/skills/release-notes/SKILL.md');

    expect(read('.claude/skills/release-notes/SKILL.md')).toBe(skill);
    expect(skill).toMatch(/stable release history/i);
    expect(skill).toContain('desktop-stable');
    expect(skill).not.toMatch(/default(?:s|ed)? to (?:the )?`?canary/i);
    expect(skill).not.toContain('"version": "0.1.24-canary"');
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

    it.each(['release-platform'])('%s pins every dispatch', (name) => {
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

  // The Matrix.page Worker sends the edge secret it was deployed with. Rolling
  // back only Cloud Run after a rotation takes every hosted site down while
  // the platform health checks still pass.
  it('rolls the Matrix.page Worker back together with the platform', () => {
    const skill = read('.agents/skills/release-platform/SKILL.md');
    const workflow = read('.github/workflows/platform-cloud-run.yml');
    const rollback = skill.slice(skill.indexOf('## 6. Rollback'), skill.indexOf('## Database migrations'));

    // The runbook uses the same Worker commands the deploy workflow relies on.
    for (const command of ['wrangler deployments status', 'wrangler rollback', '--config wrangler.sites.toml']) {
      expect(workflow).toContain(command);
      expect(rollback).toContain(command);
    }
    expect(workflow).toContain("'https://matrix.page/_edge-health'");
    expect(rollback).toContain('https://matrix.page/_edge-health');
    expect(rollback).toContain('must be 200');
    expect(skill).toContain('Matrix.page Worker version');
  });

  it('retires the old release command instead of pushing to main', () => {
    const command = read('.claude/commands/release.md');
    expect(command).toContain('release-full-stable');
    expect(command).toContain('release-platform');
    expect(command).toContain('release-matrix-stable');
    expect(command).not.toContain('git push origin main');
  });

  it('coordinates a full stable release around an approved release-modal story', () => {
    const skill = read('.agents/skills/release-full-stable/SKILL.md');

    expect(read('.claude/skills/release-full-stable/SKILL.md')).toBe(skill);
    expect(skill.split('\n')[1]).toBe('name: release-full-stable');
    expect(skill).toContain('release-notes/<version>.json');
    expect(skill).toContain('release-notes');
    expect(skill).toContain('release-matrix-stable');
    expect(skill).toContain('release-platform');

    const modal = skill.indexOf('## 2. Collaborate on the release modal');
    const release = skill.indexOf('## 5. Release the host bundle');
    expect(modal).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(modal);
    expect(skill).toContain('complete recommended draft');
    expect(skill).toContain('recommended default');
    expect(skill).toContain('Do not ask the user to write the copy');
    expect(skill).toMatch(/explicit\s+approval before committing/i);

    expect(skill).toContain('exact approved version');
    expect(skill).toContain('inventory-derived denominator');
    expect(skill).toContain('A triggered rollout is not a completed rollout');
    expect(skill).toContain('Europe/Berlin');
    expect(skill).toContain('Golden snapshot');
    expect(skill).toContain('Desktop stable');
  });

  it('locks the release content before notes without blocking host lanes on the notes PR', () => {
    const skill = read('.agents/skills/release-full-stable/SKILL.md');
    const locking = skill.slice(
      skill.indexOf('## 1. Establish the release range and versions'),
      skill.indexOf('## 4. Qualify the platform lane'),
    );
    const desktop = skill.slice(
      skill.indexOf('## 7. Publish and verify Desktop stable'),
      skill.indexOf('## 8. Golden snapshot and final verification'),
    );

    expect(locking).toContain('RELEASE_CONTENT_SHA');
    expect(locking).toMatch(/notes cover changes through that SHA only/i);
    expect(locking).toMatch(/exclude(?:s|d)? (?:the )?release-notes PR itself/i);
    expect(locking).toMatch(/merge (?:the )?release-notes PR ASAP/i);
    expect(locking).toMatch(/Platform, Host, and Fleet lanes may proceed/i);
    expect(locking).not.toContain('Do not start any release build until the approved notes PR is merged');
    expect(desktop).toMatch(/must wait for the approved release-notes PR to merge/i);
    expect(desktop).toContain('DESKTOP_SHA');
    expect(skill).toMatch(/report both `RELEASE_CONTENT_SHA`\s+and `DESKTOP_SHA`/i);
  });

  it('fails the full-release platform gate closed against the actual serving source', () => {
    const skill = read('.agents/skills/release-full-stable/SKILL.md');
    const platform = skill.slice(
      skill.indexOf('## 4. Qualify the platform lane'),
      skill.indexOf('## 5. Release the host bundle'),
    );

    expect(platform).toContain('authoritative serving source SHA');
    expect(platform).toContain('git merge-base --is-ancestor');
    expect(platform).toMatch(/serving SHA\s+through\s+`RELEASE_CONTENT_SHA`/);
    expect(platform).toContain('dependency ledger');
    expect(platform).toContain('Do not mark Platform `not needed`');
    expect(platform).not.toContain(
      'If no platform-relevant inputs changed, record `not needed` with the serving platform SHA.',
    );
  });

  it('binds fleet approval and dispatch to the exact approved target set', () => {
    const skill = read('.agents/skills/release-full-stable/SKILL.md');
    const fleet = skill.slice(
      skill.indexOf('## 6. Roll out and verify the fleet'),
      skill.indexOf('## 7. Publish and verify Desktop stable'),
    );

    expect(fleet).toContain('approval manifest');
    expect(fleet).toContain('machine ID and handle');
    expect(fleet).toContain('must exactly match the approved target set');
    expect(fleet).toContain('{"handle":"<approved-handle>","version":"<exact-version>"}');
    expect(fleet).toMatch(/Do\s+not use `deploy_after_publish=true`/);
    expect(fleet).toContain('body that omits `handle`');
    expect(fleet).toContain('Never add a newly eligible machine without new approval');
  });
});
