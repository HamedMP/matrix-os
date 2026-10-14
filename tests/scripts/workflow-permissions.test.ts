import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Workflow = { permissions?: unknown; jobs?: Record<string, { permissions?: unknown; uses?: string }> };
const dir = join(process.cwd(), '.github/workflows');
const workflows = readdirSync(dir)
  .filter(file => /\.ya?ml$/.test(file))
  .map(file => ({ file, workflow: parse(readFileSync(join(dir, file), 'utf8')) as Workflow }));

describe('workflow token permissions', () => {
  it('declares explicit GITHUB_TOKEN permissions for every job', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const { file, workflow } of workflows) {
      if (workflow.permissions !== undefined) continue;
      // Reusable-workflow callers need explicit permissions too; the default token is not least privilege.
      const undeclared = Object.entries(workflow.jobs ?? {})
        .filter(([, job]) => job.permissions === undefined)
        .map(([id]) => id);
      expect(undeclared, file).toEqual([]);
    }
  });

  it('keeps scheduled and smoke workflows read-only', () => {
    for (const file of ['agent-install-smoke.yml', 'docker-test.yml', 'macos-086.yml']) {
      const entry = workflows.find(w => w.file === file);
      expect(entry?.workflow.permissions, file).toEqual({ contents: 'read' });
      // A job-level override would silently widen the token for that job.
      for (const [id, job] of Object.entries(entry?.workflow.jobs ?? {})) {
        if (job.permissions === undefined) continue;
        const scopes = typeof job.permissions === 'string' ? { all: job.permissions } : (job.permissions as Record<string, string>);
        expect(Object.values(scopes).every(level => level === 'read' || level === 'none'), `${file}#${id}`).toBe(true);
      }
    }
  });
});
