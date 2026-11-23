import { describe, expect, it, vi } from 'vitest';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import type {
  RoutableMachine,
  RuntimeSubstrate,
  RuntimeUpstream,
} from '../../packages/platform/src/substrates/types.js';

function fakeSubstrate(kind: RuntimeSubstrate['kind'], upstream: RuntimeUpstream | null): RuntimeSubstrate {
  return {
    kind,
    startsOnDemand: kind === 'container',
    resolveUpstream: vi.fn(() => upstream),
    ensureRunning: vi.fn(async () => ({ state: 'running' as const })),
  };
}

function machine(substrate: string, status = 'running'): RoutableMachine {
  return { handle: 'alice', status, substrate, publicIPv4: '203.0.113.10' } as RoutableMachine;
}

const target = { path: '/api/health', queryString: '?a=1' };

describe('substrate registry', () => {
  it('returns the registered substrate for its kind', () => {
    const vps = fakeSubstrate('vps', null);
    const registry = createSubstrateRegistry([vps]);
    expect(registry.get('vps')).toEqual({ ok: true, substrate: vps });
  });

  it('reports an unregistered or unknown kind as unavailable without throwing', () => {
    const registry = createSubstrateRegistry([fakeSubstrate('vps', null)]);
    for (const kind of ['container', 'lambda', '', '__proto__', 'toString', 'constructor']) {
      expect(registry.get(kind)).toEqual({ ok: false, reason: 'substrate_unavailable' });
    }
  });

  it('refuses to register the same kind twice', () => {
    expect(() => createSubstrateRegistry([fakeSubstrate('vps', null), fakeSubstrate('vps', null)]))
      .toThrow('Duplicate runtime substrate: vps');
  });

  it('resolves the upstream through the substrate named on the machine', () => {
    const vpsUpstream = { url: 'https://203.0.113.10:443/api/health?a=1', hostHeader: 'alice.matrix-os.com' };
    const containerUpstream = { url: 'https://10.0.0.5:8443/api/health?a=1', hostHeader: 'alice.matrix-os.com' };
    const vps = fakeSubstrate('vps', vpsUpstream);
    const container = fakeSubstrate('container', containerUpstream);
    const registry = createSubstrateRegistry([vps, container]);

    expect(registry.resolveUpstream(machine('vps'), target)).toEqual({ kind: 'upstream', upstream: vpsUpstream });
    expect(registry.resolveUpstream(machine('container'), target))
      .toEqual({ kind: 'upstream', upstream: containerUpstream });
    expect(vps.resolveUpstream).toHaveBeenCalledWith(machine('vps'), target);
  });

  it('separates a not-yet-routable runtime from a substrate this platform cannot serve', () => {
    const vps = fakeSubstrate('vps', null);
    const registry = createSubstrateRegistry([vps]);

    expect(registry.resolveUpstream(machine('vps', 'provisioning'), target)).toEqual({ kind: 'not_routable' });
    expect(registry.resolveUpstream(machine('container'), target)).toEqual({ kind: 'substrate_unavailable' });
    expect(vps.resolveUpstream).toHaveBeenCalledTimes(1);
  });
});
