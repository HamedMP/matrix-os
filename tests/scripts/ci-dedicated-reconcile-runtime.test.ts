import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const nodeRequire = createRequire(import.meta.url);
const controller = 'a'.repeat(40);
const workflow = () => parse(readFileSync('.github/workflows/ci-dedicated.yml', 'utf8'));

async function execute(token = 'fake-gate-app-token', helperError?: Error, configurationToken = 'fake-configuration-token') {
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
  const context = { repo: { owner: 'HamedMP', repo: 'matrix-os' }, ref: 'refs/heads/main', runId: 123, payload: {} };
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
