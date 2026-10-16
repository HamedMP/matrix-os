import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
const exact = { pr_number: '2493', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), source_sha: 'c'.repeat(40), execution_mode: 'hosted-only' };
const main = { event_name: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'd'.repeat(40) };

function group(github = main, inputs: Record<string, string> = exact): string {
  return workflow.concurrency.group.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_: string, expression: string) => {
    // Evaluate only the trusted workflow's string/boolean/format expression.
    const format = (template: string, ...values: string[]) => template.replace(/\{(\d+)\}/g, (_match, index) => values[Number(index)]);
    return String(new Function('github', 'inputs', 'format', `return (${expression})`)(github, inputs, format));
  });
}

describe('exact-source refresh concurrency', () => {
  it.each(['pr_number', 'head_sha', 'base_sha', 'source_sha'])(
    'lets different %s snapshots leave the shared main manual queue', (field) => {
      const changed = { ...exact, [field]: field === 'pr_number' ? '2494' : 'e'.repeat(40) };
      expect(group(main, changed)).not.toBe(group());
      expect(group(main, changed)).not.toBe(group(main, {}));
    },
  );

  it('queues duplicate requests for one exact source together across execution modes', () => {
    const groups = Array.from({ length: 100 }, () => group());
    expect(new Set(groups).size).toBe(1);
    expect(group(main, { ...exact, execution_mode: 'linux' })).toBe(group());
    expect(group()).not.toContain('undefined');
  });

  it.each([{}, { ...exact, pr_number: '' }, { ...exact, head_sha: '' }, { ...exact, base_sha: '' }, { ...exact, source_sha: '' }])(
    'keeps ordinary or incomplete manual inputs in the existing shared group', (inputs) => {
      expect(group(main, inputs)).toBe('ci-refs/heads/main-shared');
    },
  );

  it('preserves per-PR grouping when the head changes', () => {
    const first = { ...main, event_name: 'pull_request', ref: 'refs/pull/2493/merge' };
    expect(group(first)).toBe('ci-refs/pull/2493/merge-shared');
    expect(group({ ...first, sha: 'f'.repeat(40) })).toBe(group(first));
    expect(group({ ...first, ref: 'refs/pull/2494/merge' })).not.toBe(group(first));
  });

  it('preserves an independent group for every main push', () => {
    const push = { ...main, event_name: 'push' };
    expect(group(push)).toBe(`ci-refs/heads/main-${main.sha}`);
    expect(group({ ...push, sha: 'f'.repeat(40) })).not.toBe(group(push));
    expect(group(push)).not.toBe(group());
  });

  it('retains max queuing without cancelling admitted work', () => {
    expect(workflow.concurrency.queue).toBe('max');
    expect(workflow.concurrency['cancel-in-progress']).toBeUndefined();
    expect(workflow.concurrency.group).not.toMatch(/run_id|run_number|run_attempt/);
  });
});
