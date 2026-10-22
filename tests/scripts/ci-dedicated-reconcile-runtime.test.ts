import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const nodeRequire = createRequire(import.meta.url);
const controller = 'a'.repeat(40);
const workflow = () => parse(readFileSync('.github/workflows/ci-dedicated.yml', 'utf8'));

async function execute(token = 'fake-gate-app-token', helperError?: Error, configurationToken = 'fake-configuration-token', event: { eventName?: string; payload?: Record<string, unknown> } = {}) {
  vi.stubEnv('GATE_TOKEN', token);
  vi.stubEnv('CONFIGURATION_TOKEN', configurationToken);
  vi.stubEnv('GATE_APP_ID', '777');
  vi.stubEnv('CONTROLLER_SHA', controller);
  vi.stubEnv('CONTROLLER_ATTEMPT', '2');
  vi.stubEnv('CONTROLLER_WORKFLOW_REF', 'HamedMP/matrix-os/.github/workflows/ci-dedicated.yml@refs/heads/main');
  vi.stubEnv('GITHUB_WORKSPACE', process.cwd());
  const clients: Client[] = [];
  class Client {
    request = { endpoint: { DEFAULTS: { baseUrl: 'https://api.github.com' } } };
    rest = { actions: { listRepoVariables: vi.fn() }, checks: { create: vi.fn(), update: vi.fn() } };
    constructor(readonly options: { auth: string; baseUrl?: string; request?: { timeout: number } }) {
      clients.push(this);
    }
  }
  const github = new Client({ auth: 'fake-actions-token' });
  const context = { repo: { owner: 'HamedMP', repo: 'matrix-os' }, ref: 'refs/heads/main', runId: 123, eventName: event.eventName ?? 'schedule', payload: event.payload ?? {} };
  const core = { info: vi.fn() };
  const reconcile = vi.fn(async () => {
    if (helperError) throw helperError;
    return { examined: 1, dispatched: 0 };
  });
  const loadHelper = async (url: string) => {
    if(url.endsWith('/dedicated-config-token.mjs'))return import('../../scripts/ci/dedicated-config-token.mjs');
    expect(url).toBe(pathToFileURL(resolve(process.cwd(), 'scripts/ci/dedicated-admission.mjs')).href);
    return { reconcileSourceQualification: reconcile };
  };
  // GitHub Script bundles its own client but does not install external modules.
  const actionRequire = (name: string) => {
    if (!name.startsWith('node:')) throw Object.assign(new Error(`Cannot find module '${name}'`), { code: 'MODULE_NOT_FOUND' });
    return nodeRequire(name);
  };
  const source = workflow().jobs.reconcile.steps.find((step: { name: string }) => step.name === 'Reconcile completed child source checks').with.script;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction('github', 'context', 'core', 'require', 'loadHelper', source.replaceAll('await import(', 'await loadHelper('));
  await run(github, context, core, actionRequire, loadHelper);
  return { github, clients, reconcile, core };
}

afterEach(() => vi.unstubAllEnvs());

it('executes the reconciliation workflow without installed action packages and isolates App credentials', async () => {
  const { github, clients, reconcile, core } = await execute();
  expect(clients).toHaveLength(3);
  const configurationGithub = clients[1];
  const gateGithub = clients[2];
  expect(gateGithub).not.toBe(github);
  expect(github.options.auth).toBe('fake-actions-token');
  expect(gateGithub.options).toEqual({ auth: 'fake-gate-app-token', baseUrl: 'https://api.github.com', request: { timeout: 10000 } });
  expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({rest:expect.objectContaining({checks:github.rest.checks})}), { owner: 'HamedMP', repo: 'matrix-os' },
    { sha: controller, ref: 'refs/heads/main', workflowRef: process.env.CONTROLLER_WORKFLOW_REF },
    { gateGithub, gateAppId: 777, runId: 123, runAttempt: 2 });
  const sourceGithub=reconcile.mock.calls[0][0];
  await sourceGithub.rest.actions.listRepoVariables({});
  expect(configurationGithub.rest.actions.listRepoVariables).toHaveBeenCalledOnce();
  expect(github.rest.actions.listRepoVariables).not.toHaveBeenCalled();
  expect(core.info).toHaveBeenCalledWith('Examined 1 source gates; refreshed 0 exact-source requests.');
});

it('rejects a missing protected App token before reconciliation', async () => {
  await expect(execute('')).rejects.toThrow('Protected gate App token is required');
});

it('propagates reconciliation failures instead of reporting success', async () => {
  await expect(execute('fake-gate-app-token', new Error('API denied'))).rejects.toThrow('API denied');
});

it('rejects a missing configuration token before reconciliation',async()=>{await expect(execute('fake-gate-app-token',undefined,'')).rejects.toThrow('Configuration read token is required');});

const scopeOf = async (eventName: string, payload: Record<string, unknown>) => {
  const { reconcile } = await execute('fake-gate-app-token', undefined, 'fake-configuration-token', { eventName, payload });
  const options = reconcile.mock.calls[0][3] as Record<string, unknown>;
  return { prNumber: options.prNumber, childrenOf: options.childrenOf };
};
const ownPr = (number: number) => ({ number, base: { repo: { url: 'https://api.github.com/repos/HamedMP/matrix-os' } }, head: { repo: { url: 'https://api.github.com/repos/HamedMP/matrix-os' } } });

it('scopes a completed PR CI run to its own pull request instead of scanning every open PR', async () => {
  expect(await scopeOf('workflow_run', { action: 'completed', workflow_run: { pull_requests: [ownPr(2535)] } })).toEqual({ prNumber: 2535, childrenOf: undefined });
});
it.each([
  ['main push or dispatched refresh CI', []],
  ['an ambiguous multi-PR CI run', [ownPr(1), ownPr(2)]],
  ['a fork PR CI run', [{ ...ownPr(7), head: { repo: { url: 'https://api.github.com/repos/fork/matrix-os' } } }]],
])('keeps the full scan for %s', async (_label, pullRequests) => {
  expect(await scopeOf('workflow_run', { action: 'completed', workflow_run: { pull_requests: pullRequests } })).toEqual({ prNumber: undefined, childrenOf: undefined });
});
it('scopes a pushed PR to itself and its direct stacked children', async () => {
  expect(await scopeOf('pull_request_target', { action: 'synchronize', pull_request: { number: 2422, head: { ref: 'stack/parent' } } })).toEqual({ prNumber: undefined, childrenOf: { number: 2422, headRef: 'stack/parent' } });
});
it('keeps single-PR scope for other pull request events and the full scan for schedules', async () => {
  expect(await scopeOf('pull_request_target', { action: 'labeled', pull_request: { number: 2422, head: { ref: 'x' } } })).toEqual({ prNumber: 2422, childrenOf: undefined });
  expect(await scopeOf('schedule', {})).toEqual({ prNumber: undefined, childrenOf: undefined });
});

// Minimal evaluator for the GitHub expression subset used by the reconcile concurrency group.
function evaluateGithubExpression(source: string, github: Record<string, unknown>): unknown {
  const tokens = source.match(/'[^']*'|&&|\|\||==|!=|[()!,]|[A-Za-z_][\w.-]*(?:\[\d+\][\w.]*)*|\d+/g) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const lookup = (path: string) => path.split(/\.|\[(\d+)\]/).filter((part) => part !== undefined && part !== '').reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), { github });
  const primary = (): unknown => {
    const token = next()!;
    if (token === '(') { const value = or(); next(); return value; }
    if (token === '!') return !primary();
    if (token.startsWith("'")) return token.slice(1, -1);
    if (/^\d+$/.test(token)) return Number(token);
    if (token === 'format') { next(); const args: unknown[] = [or()]; while (peek() === ',') { next(); args.push(or()); } next(); return String(args[0]).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i) + 1])); }
    return lookup(token) ?? null;
  };
  const equality = (): unknown => { let left = primary(); while (peek() === '==' || peek() === '!=') { const op = next(); const right = primary(); left = op === '==' ? left === right : left !== right; } return left; };
  const and = (): unknown => { let left = equality(); while (peek() === '&&') { next(); const right = equality(); left = left ? right : left; } return left; };
  const or = (): unknown => { let left = and(); while (peek() === '||') { next(); const right = and(); left = left ? left : right; } return left; };
  return or();
}

it('queues reconciliation per affected scope instead of one global line', () => {
  const concurrency = workflow().jobs.reconcile.concurrency as { group: string; queue: string; 'cancel-in-progress': boolean };
  expect(concurrency.group).not.toBe('matrix-ci-stack-reconciliation');
  // Queue (never cancel) within a scope so no reconcile result is dropped.
  expect(concurrency.queue).toBe('max');
  expect(concurrency['cancel-in-progress']).toBe(false);
});

it.each([
  ['a push to a PR', { event: { action: 'synchronize', pull_request: { number: 2422 } } }, 'push-2422'],
  ['another PR action', { event: { action: 'labeled', pull_request: { number: 2422 } } }, 'pr-2422'],
  ['a single same-repository CI completion', { event: { action: 'completed', repository: { id: 1 }, workflow_run: { pull_requests: [{ number: 2544, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } }] } } }, 'pr-2544'],
  ['a fork CI completion', { event: { action: 'completed', repository: { id: 1 }, workflow_run: { pull_requests: [{ number: 7, head: { repo: { id: 2 } }, base: { repo: { id: 1 } } }] } } }, 'full'],
  ['a multi-PR CI completion', { event: { action: 'completed', repository: { id: 1 }, workflow_run: { pull_requests: [{ number: 1, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } }, { number: 2, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } }] } } }, 'full'],
  ['a main or refresh CI completion', { event: { action: 'completed', repository: { id: 1 }, workflow_run: { pull_requests: [] } } }, 'full'],
  ['a schedule or main push', { event: {} }, 'full'],
])('queues %s in its own scope', (_label, github, scope) => {
  const group = (workflow().jobs.reconcile.concurrency as { group: string }).group;
  const expression = group.match(/^matrix-ci-reconcile-\$\{\{ (.*) \}\}$/)![1];
  expect(evaluateGithubExpression(expression, github)).toBe(scope);
});
