import { vi } from 'vitest';
import type { HetznerClient, HetznerServer } from '../../packages/platform/src/customer-vps-hetzner.js';
import type { CustomerVpsSystemStore, VpsMeta } from '../../packages/platform/src/customer-vps-r2.js';

export function createMockHetznerClient(overrides: Partial<HetznerClient> = {}): HetznerClient {
  const defaultServer: HetznerServer = {
    id: 123456,
    status: 'running',
    publicIPv4: '203.0.113.10',
    publicIPv6: '2001:db8::10',
  };
  return {
    createServer: vi.fn().mockResolvedValue(defaultServer),
    getServer: vi.fn().mockResolvedValue(defaultServer),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createMockCustomerVpsSystemStore(
  overrides: Partial<CustomerVpsSystemStore> = {},
): CustomerVpsSystemStore & { writtenMeta: VpsMeta[] } {
  const writtenMeta: VpsMeta[] = [];
  return {
    writtenMeta,
    writeVpsMeta: vi.fn(async (meta: VpsMeta) => {
      writtenMeta.push(meta);
    }),
    hasDbLatest: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

