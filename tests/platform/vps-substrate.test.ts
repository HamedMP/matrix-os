import { describe, expect, it, vi } from 'vitest';
import {
  buildCustomerVpsProxyUrl,
  isCustomerVpsProxyMachineRoutable,
} from '../../packages/platform/src/profile-routing.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import type { RoutableMachine } from '../../packages/platform/src/substrates/types.js';

interface Case {
  name: string;
  machine: Omit<RoutableMachine, 'handle' | 'substrate'>;
  path: string;
  queryString?: string;
  expected: string | null;
}

const CASES: Case[] = [
  {
    name: 'running machine with a public IPv4',
    machine: { status: 'running', publicIPv4: '203.0.113.10' },
    path: '/api/ping', queryString: '?x=1',
    expected: 'https://203.0.113.10:443/api/ping?x=1',
  },
  {
    name: 'running machine without a public IPv4',
    machine: { status: 'running', publicIPv4: null },
    path: '/api/ping',
    expected: null,
  },
  {
    name: 'recovering machine keeps traffic on the predecessor',
    machine: { status: 'recovering', publicIPv4: '203.0.113.11', recoveryOldServerId: 123456, recoveryOldPublicIPv4: '203.0.113.10' },
    path: '/api/ping',
    expected: 'https://203.0.113.10:443/api/ping',
  },
  {
    name: 'recovering machine whose predecessor has no address',
    machine: { status: 'recovering', publicIPv4: '203.0.113.11', recoveryOldServerId: 123456, recoveryOldPublicIPv4: null },
    path: '/api/ping',
    expected: null,
  },
  {
    name: 'recovering machine without a predecessor server',
    machine: { status: 'recovering', publicIPv4: '203.0.113.11', recoveryOldServerId: null, recoveryOldPublicIPv4: '203.0.113.10' },
    path: '/api/ping',
    expected: null,
  },
  ...['provisioning', 'failed', 'resizing', 'deleted', 'suspended'].map((status) => ({
    name: `${status} machine with a public IPv4`,
    machine: { status, publicIPv4: '203.0.113.10', recoveryOldServerId: 1, recoveryOldPublicIPv4: '203.0.113.9' },
    path: '/api/ping',
    expected: null,
  })),
  {
    name: 'path without a leading slash',
    machine: { status: 'running', publicIPv4: '203.0.113.10' },
    path: 'api/ping',
    expected: 'https://203.0.113.10:443/api/ping',
  },
  {
    name: 'query string is appended verbatim',
    machine: { status: 'running', publicIPv4: '203.0.113.10' },
    path: '/files/a%20b', queryString: '?q=a%26b&next=%2Fhome',
    expected: 'https://203.0.113.10:443/files/a%20b?q=a%26b&next=%2Fhome',
  },
];

describe('customer VPS proxy routing (characterization)', () => {
  it.each(CASES)('$name', ({ machine, path, queryString, expected }) => {
    expect(buildCustomerVpsProxyUrl(machine, path, queryString)).toBe(expected);
    expect(isCustomerVpsProxyMachineRoutable(machine)).toBe(expected !== null);
  });
});

describe('vps substrate', () => {
  const substrate = createVpsSubstrate({ loadMachine: async () => undefined });

  it('is the vps kind and never starts on demand', () => {
    expect(substrate.kind).toBe('vps');
    expect(substrate.startsOnDemand).toBe(false);
  });

  it.each(CASES)('resolves the same upstream as today: $name', ({ machine, path, queryString, expected }) => {
    const upstream = substrate.resolveUpstream(
      { ...machine, handle: 'alice', substrate: 'vps' },
      { path, queryString },
    );
    expect(upstream).toEqual(expected === null ? null : { url: expected, hostHeader: 'alice.matrix-os.com' });
  });

  describe('ensureRunning', () => {
    const ref = { machineId: 'm1', handle: 'alice', runtimeSlot: 'primary', generation: 1 };

    function substrateWith(machine: Partial<RoutableMachine & { deletedAt: string | null }> | undefined) {
      const loadMachine = vi.fn(async () => machine && {
        handle: 'alice', substrate: 'vps' as const, publicIPv4: null, deletedAt: null, status: 'running', ...machine,
      });
      return { loadMachine, substrate: createVpsSubstrate({ loadMachine }) };
    }

    it.each([
      [{ status: 'running', publicIPv4: '203.0.113.10' }, { state: 'running' }],
      [{ status: 'recovering', publicIPv4: '203.0.113.11', recoveryOldServerId: 1, recoveryOldPublicIPv4: '203.0.113.10' }, { state: 'running' }],
      [{ status: 'provisioning' }, { state: 'starting' }],
      [{ status: 'recovering', recoveryOldServerId: null }, { state: 'starting' }],
      [{ status: 'resizing', publicIPv4: '203.0.113.10' }, { state: 'starting' }],
      [{ status: 'running', publicIPv4: null }, { state: 'failed', code: 'needs_recovery' }],
      [{ status: 'failed' }, { state: 'failed', code: 'needs_recovery' }],
      [{ status: 'running', publicIPv4: '203.0.113.10', deletedAt: '2026-11-01T00:00:00.000Z' }, { state: 'failed', code: 'needs_recovery' }],
      [undefined, { state: 'failed', code: 'needs_recovery' }],
    ])('reports %j as %j', async (machine, expected) => {
      const { loadMachine, substrate: vps } = substrateWith(machine);
      await expect(vps.ensureRunning(ref, AbortSignal.timeout(1000))).resolves.toEqual(expected);
      expect(loadMachine).toHaveBeenCalledWith('m1');
    });

    it('does not read the machine once the caller has given up', async () => {
      const { loadMachine, substrate: vps } = substrateWith({ status: 'running', publicIPv4: '203.0.113.10' });
      const controller = new AbortController();
      controller.abort(new Error('caller gave up'));
      await expect(vps.ensureRunning(ref, controller.signal)).rejects.toThrow('caller gave up');
      expect(loadMachine).not.toHaveBeenCalled();
    });
  });
});
