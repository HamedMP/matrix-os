import { describe, expect, it } from 'vitest';
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

  it('retires the old release command instead of pushing to main', () => {
    const command = read('.claude/commands/release.md');
    expect(command).toContain('release-platform');
    expect(command).toContain('release-matrix-stable');
    expect(command).not.toContain('git push origin main');
  });
});
