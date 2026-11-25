import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MetalHost } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import {
  createMetalHostDirectory,
  createMetalSubstrate,
  type MetalMachineSnapshot,
  type MetalSubstrateDeps,
} from '../../packages/platform/src/substrates/metal-substrate.js';
import type { RuntimeRef } from '../../packages/platform/src/substrates/types.js';
import { json, startFakeHostd, type FakeHostd } from './fake-hostd-server.js';

const API_TOKEN = 'api-token-'.padEnd(40, 'x');
const INGRESS_TOKEN = 'ingress-token-'.padEnd(40, 'y');
const VM_ID = 'vm_0123456789abcdef01234567';

function metalHost(overrides: Partial<MetalHost> = {}): MetalHost {
  return {
    id: 'metal-1',
    name: 'metal-1',
    apiUrl: 'https://hostd.metal.example.test:8443',
    ingressHost: 'metal.example.test:9443',
    status: 'active',
    memoryCapacityMib: 131072,
    admissionCeilingMib: 114688,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
}

function machine(overrides: Partial<MetalMachineSnapshot> = {}): MetalMachineSnapshot {
  return {
    machineId: 'machine-alice',
    handle: 'alice',
    status: 'running',
    substrate: 'metal',
    publicIPv4: '203.0.113.99',
    metalHostId: 'metal-1',
    metalVmId: VM_ID,
    generation: 3,
    deletedAt: null,
    ...overrides,
  };
}

const REF: RuntimeRef = { machineId: 'machine-alice', handle: 'alice', runtimeSlot: 'primary', generation: 3 };

function vmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: VM_ID,
    machineId: 'machine-alice',
    generation: 3,
    handle: 'alice',
    tier: 'free',
    state: 'suspended',
    privateIPv4: '10.77.0.5',
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: 'v48.0',
    snapshot: null,
    updatedAt: '2026-11-21T10:00:00.000Z',
    ...overrides,
  };
}

function directoryOf(...hosts: MetalHost[]) {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return createMetalHostDirectory({
    get: async (id) => byId.get(id) ?? null,
    listActive: async () => hosts.filter((h) => h.status === 'active'),
  });
}

describe('metal substrate routing', () => {
  async function primed(...hosts: MetalHost[]) {
    const hostsDir = directoryOf(...hosts);
    await hostsDir.prime();
    return createMetalSubstrate({
      loadMachine: async () => machine(),
      hosts: hostsDir,
      apiToken: API_TOKEN,
      ingressToken: INGRESS_TOKEN,
    });
  }

  it('is an on-demand metal substrate', async () => {
    const substrate = await primed(metalHost());
    expect(substrate.kind).toBe('metal');
    expect(substrate.startsOnDemand).toBe(true);
  });

  it('resolveUpstream uses the host ingress, never the VM address', async () => {
    const substrate = await primed(metalHost());

    const upstream = substrate.resolveUpstream(machine(), { path: '/api/projects', queryString: '?view=list' });

    expect(upstream).toMatchObject({
      url: 'https://metal.example.test:9443/api/projects?view=list',
      hostHeader: 'app.matrix-os.com',
      tlsServerName: 'metal.example.test',
    });
    expect(upstream!.url).not.toContain('203.0.113.99');
    expect(upstream!.url).not.toContain('10.77.');
  });

  it('defaults the ingress port to 443', async () => {
    const substrate = await primed(metalHost({ ingressHost: 'metal.example.test' }));

    expect(substrate.resolveUpstream(machine(), { path: '/' })?.url).toBe('https://metal.example.test:443/');
  });

  it('upstream headers carry the selected VM id and generation with host authentication', async () => {
    const substrate = await primed(metalHost());

    expect(substrate.resolveUpstream(machine(), { path: '/' })?.headers).toEqual({
      'x-matrix-host-auth': INGRESS_TOKEN,
      'x-matrix-vm-target': `${VM_ID}:3`,
    });
  });

  it.each([
    ['the machine is not running', machine({ status: 'suspended' })],
    ['the machine has no host', machine({ metalHostId: null })],
    ['the selected machine has no VM id', machine({ metalVmId: null })],
    ['the selected machine generation is invalid', machine({ generation: -1 })],
    ['the host is unknown', machine({ metalHostId: 'metal-404' })],
  ])('resolveUpstream is null when %s', async (_name, m) => {
    const substrate = await primed(metalHost());
    expect(substrate.resolveUpstream(m, { path: '/' })).toBeNull();
  });

  it('a cold host cache fills in the background', async () => {
    const hostsDir = directoryOf(metalHost({ status: 'draining' }));
    const substrate = createMetalSubstrate({
      loadMachine: async () => machine(),
      hosts: hostsDir,
      apiToken: API_TOKEN,
      ingressToken: INGRESS_TOKEN,
    });

    expect(substrate.resolveUpstream(machine(), { path: '/' })).toBeNull();
    await vi.waitFor(() => expect(substrate.resolveUpstream(machine(), { path: '/' })).not.toBeNull());
  });

  it('passes the extra CA to the upstream so ingress TLS stays verified', async () => {
    const hostsDir = directoryOf(metalHost());
    await hostsDir.prime();
    const substrate = createMetalSubstrate({
      loadMachine: async () => machine(),
      hosts: hostsDir,
      apiToken: API_TOKEN,
      ingressToken: INGRESS_TOKEN,
      caPem: '-----BEGIN CERTIFICATE-----\nstaging\n-----END CERTIFICATE-----\n',
    });

    expect(substrate.resolveUpstream(machine(), { path: '/' })?.extraCaPem).toContain('BEGIN CERTIFICATE');
  });
});

describe('metal substrate wake and sleep through hostd', () => {
  let hostd: FakeHostd;

  beforeAll(async () => {
    hostd = await startFakeHostd();
  });

  afterAll(async () => {
    await hostd.close();
  });

  afterEach(() => {
    hostd.requests.length = 0;
  });

  function substrate(overrides: Partial<MetalSubstrateDeps> = {}) {
    const hostsDir = directoryOf(metalHost({ apiUrl: hostd.origin }));
    return createMetalSubstrate({
      loadMachine: async () => machine(),
      hosts: hostsDir,
      apiToken: API_TOKEN,
      ingressToken: INGRESS_TOKEN,
      caPem: hostd.caPem,
      ...overrides,
    });
  }

  function hostdAnswers(resume: (res: Parameters<Parameters<FakeHostd['handle']>[0]>[1]) => void, vm = vmRecord()) {
    hostd.handle((req, res) => {
      if (req.method === 'GET') return json(res, 200, vm);
      return resume(res);
    });
  }

  const signal = () => AbortSignal.timeout(10_000);

  it('ensureRunning resumes with an 8000 ms budget fenced to the generation and maps running', async () => {
    hostdAnswers((res) => json(res, 200, { state: 'running' }));

    await expect(substrate().ensureRunning(REF, signal())).resolves.toEqual({ state: 'running' });

    const resume = hostd.requests.find((r) => r.path.endsWith('/resume'));
    expect(resume?.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(JSON.parse(resume!.body)).toEqual({ budgetMs: 8000, expectedGeneration: REF.generation });
  });

  it('ensureRunning maps starting', async () => {
    hostdAnswers((res) => json(res, 200, { state: 'starting' }));
    await expect(substrate().ensureRunning(REF, signal())).resolves.toEqual({ state: 'starting' });
  });

  it('a busy host maps to busy', async () => {
    hostdAnswers((res) => json(res, 503, { error: 'busy' }));
    await expect(substrate().ensureRunning(REF, signal())).resolves.toEqual({ state: 'busy' });
  });

  it.each(['conflict', 'not_found'] as const)('a hostd %s maps to failed needs_recovery', async (code) => {
    hostdAnswers((res) => json(res, code === 'conflict' ? 409 : 404, { error: code }));
    await expect(substrate().ensureRunning(REF, signal())).resolves.toEqual({ state: 'failed', code: 'needs_recovery' });
  });

  it('hostd timeout maps to failed provider_unavailable', async () => {
    hostd.handle(() => undefined);

    await expect(substrate({ clientOptions: { timeoutMs: 100, resumeGraceMs: 100 } }).ensureRunning(REF, signal()))
      .resolves.toEqual({ state: 'failed', code: 'provider_unavailable' });
  });

  it('an unreachable hostd maps to failed provider_unavailable', async () => {
    const unreachable = directoryOf(metalHost({ apiUrl: 'https://127.0.0.1:1' }));
    await expect(substrate({ hosts: unreachable }).ensureRunning(REF, signal()))
      .resolves.toEqual({ state: 'failed', code: 'provider_unavailable' });
  });

  it('a stale generation from hostd maps to failed needs_recovery', async () => {
    hostdAnswers((res) => json(res, 200, { state: 'running' }), vmRecord({ generation: 2 }));

    await expect(substrate().ensureRunning(REF, signal())).resolves.toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(hostd.requests.some((r) => r.path.endsWith('/resume'))).toBe(false);
  });

  it('a hostd VM owned by another machine maps to failed needs_recovery', async () => {
    hostdAnswers((res) => json(res, 200, { state: 'running' }), vmRecord({ machineId: 'machine-bob' }));
    await expect(substrate().ensureRunning(REF, signal())).resolves.toEqual({ state: 'failed', code: 'needs_recovery' });
  });

  it('a platform record at another generation maps to failed needs_recovery without calling hostd', async () => {
    const result = await substrate({ loadMachine: async () => machine({ generation: 4 }) }).ensureRunning(REF, signal());

    expect(result).toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(hostd.requests).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['deleted', machine({ deletedAt: '2026-11-20T00:00:00.000Z' })],
    ['without a VM', machine({ metalVmId: null })],
    ['on another substrate', machine({ substrate: 'vps' })],
  ])('a %s machine maps to failed needs_recovery', async (_name, m) => {
    await expect(substrate({ loadMachine: async () => m }).ensureRunning(REF, signal()))
      .resolves.toEqual({ state: 'failed', code: 'needs_recovery' });
  });

  it('a down host maps to failed provider_unavailable without calling hostd', async () => {
    const down = directoryOf(metalHost({ apiUrl: hostd.origin, status: 'down' }));
    await expect(substrate({ hosts: down }).ensureRunning(REF, signal()))
      .resolves.toEqual({ state: 'failed', code: 'provider_unavailable' });
    expect(hostd.requests).toHaveLength(0);
  });

  it('a host registry failure maps to failed provider_unavailable', async () => {
    const broken = createMetalHostDirectory({
      get: async () => { throw new Error('db down'); },
      listActive: async () => [],
    });
    await expect(substrate({ hosts: broken }).ensureRunning(REF, signal()))
      .resolves.toEqual({ state: 'failed', code: 'provider_unavailable' });
  });

  it('a caller abort is rethrown', async () => {
    hostd.handle(() => undefined);
    const controller = new AbortController();
    const pending = substrate().ensureRunning(REF, controller.signal);
    setTimeout(() => controller.abort(new Error('client gone')), 30);
    await expect(pending).rejects.toThrow('client gone');
  });

  it('stop suspends the VM after the generation check', async () => {
    hostd.handle((req, res) => (req.method === 'GET' ? json(res, 200, vmRecord({ state: 'running' })) : json(res, 202, { state: 'suspending' })));

    await expect(substrate().stop(REF, signal())).resolves.toEqual({ state: 'stopping' });
    expect(hostd.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /v1/vms/${VM_ID}`,
      `POST /v1/vms/${VM_ID}/suspend`,
    ]);
    const suspend = hostd.requests.find((r) => r.path.endsWith('/suspend'));
    expect(JSON.parse(suspend!.body)).toEqual({ expectedGeneration: REF.generation });
  });

  it('stop maps a hostd generation conflict (409) to needs_recovery', async () => {
    hostd.handle((req, res) => (req.method === 'GET' ? json(res, 200, vmRecord({ state: 'running' })) : json(res, 409, { error: 'conflict' })));

    await expect(substrate().stop(REF, signal())).resolves.toEqual({ state: 'failed', code: 'needs_recovery' });
  });

  it('stop refuses a stale generation', async () => {
    hostd.handle((req, res) => (req.method === 'GET' ? json(res, 200, vmRecord({ generation: 9 })) : json(res, 202, { state: 'suspending' })));

    await expect(substrate().stop(REF, signal())).resolves.toEqual({ state: 'failed', code: 'needs_recovery' });
    expect(hostd.requests.some((r) => r.path.endsWith('/suspend'))).toBe(false);
  });
});
