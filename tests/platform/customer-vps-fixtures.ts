import { vi } from 'vitest';
import type { HetznerClient, HetznerServer } from '../../packages/platform/src/customer-vps-hetzner.js';
import type { CustomerVpsSystemStore, VpsMeta } from '../../packages/platform/src/customer-vps-r2.js';

export function createMockHetznerClient(overrides: Partial<HetznerClient> = {}): HetznerClient {
  const defaultServer: HetznerServer = {
    id: 123456,
    status: 'running',
    serverType: 'cpx22',
    publicIPv4: '203.0.113.10',
    publicIPv6: '2001:db8::/64',
  };
  return {
    createServer: vi.fn().mockResolvedValue(defaultServer),
    getServer: vi.fn().mockResolvedValue(defaultServer),
    shutdownServer: vi.fn().mockResolvedValue(undefined),
    powerOffServer: vi.fn().mockResolvedValue(undefined),
    powerOnServer: vi.fn().mockResolvedValue(undefined),
    resizeServer: vi.fn().mockResolvedValue(undefined),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    listServersByLabel: vi.fn().mockResolvedValue([]),
    createSnapshot: vi.fn().mockResolvedValue({
      image: {
        id: 234567,
        status: 'available',
        type: 'snapshot',
        architecture: 'x86',
        diskGb: 40,
        labels: {},
        deleteProtected: false,
      },
      action: { id: 345678, status: 'success', command: 'create_image' },
    }),
    getImage: vi.fn().mockResolvedValue(null),
    listImagesByLabel: vi.fn().mockResolvedValue([]),
    deleteImage: vi.fn().mockResolvedValue(undefined),
    getAction: vi.fn().mockResolvedValue(null),
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
