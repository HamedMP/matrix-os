import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const path = join(process.cwd(), '.github/workflows/ci-pr-supersede.yml');
const workflow = existsSync(path) ? parse(readFileSync(path, 'utf8')) : {};
const script = workflow.jobs?.supersede?.steps?.[0]?.with?.script ?? 'throw new Error("Missing PR supersession workflow")';
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const currentSha = 'a'.repeat(40);
const previousSha = 'b'.repeat(40);
const context = { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 17, head: { sha: currentSha } } } };
const run = (id: number, sha: string, number = 17, event = 'pull_request', status = 'in_progress') => ({ id, head_sha: sha, event, status, pull_requests: [{ number, head: { sha }, base: { repo: { id: 123 } } }] });
async function execute(runs: unknown[], heads = [currentSha]) {
  let call = 0;
  const cancel = vi.fn().mockResolvedValue({ status: 202 });
  const get = vi.fn().mockImplementation(async () => ({ data: { head: { sha: heads[Math.min(call++, heads.length - 1)] }, state: 'open', base: { repo: { id: 123 } }, merge_commit_sha: 'c'.repeat(40) } }));
  const list = vi.fn().mockResolvedValue({ data: { workflow_runs: runs } });
  const github = { rest: { pulls: { get }, actions: { listWorkflowRuns: list, cancelWorkflowRun: cancel } } };
  const core = { info: vi.fn(), warning: vi.fn() };
  await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
  return { cancel, get, list };
}

describe('trusted PR CI supersession', () => {
  it('never checks out or evaluates PR code with cancellation credentials', () => {
    expect(workflow.on.pull_request_target.types).toContain('synchronize');
    expect(workflow.permissions).toEqual({ actions: 'write', contents: 'read', 'pull-requests': 'read' });
    expect(workflow.jobs.supersede.steps).toHaveLength(1);
    expect(workflow.jobs.supersede.steps[0].uses).toMatch(/^actions\/github-script@[a-f0-9]{40}$/);
    expect(script).not.toContain('${{');
    expect(script).not.toContain('exec');
  });

  it('cancels only outdated active CI runs belonging to the same PR', async () => {
    const { cancel, list } = await execute([
      run(1, previousSha), run(2, currentSha), run(3, previousSha, 99),
      run(4, previousSha, 17, 'push'), run(5, previousSha, 17, 'pull_request', 'completed'),
      { ...run(6, previousSha), pull_requests: [] }, run(7, 'invalid'),
    ]);
    expect(cancel.mock.calls.map(([arg]) => arg.run_id)).toEqual([1]);
    expect(list.mock.calls[0][0].workflow_id).toBe('ci.yml');
    expect(list.mock.calls[0][0].per_page).toBe(100);
  });

  it('does nothing when this event was overtaken by a newer PR head', async () => {
    const { cancel, list } = await execute([run(1, previousSha)], [previousSha]);
    expect(cancel).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('rechecks the live PR head before cancellation to avoid out-of-order events', async () => {
    const { cancel } = await execute([run(1, previousSha), run(2, previousSha)], [currentSha, previousSha]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('bounds pagination and accepts completion races only', async () => {
    const { list } = await execute(Array.from({ length: 100 }, (_, i) => run(i + 1, currentSha)));
    expect(list).toHaveBeenCalledTimes(3);
  });
});
