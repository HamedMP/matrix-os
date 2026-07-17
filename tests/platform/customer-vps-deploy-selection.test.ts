import { describe, expect, it } from 'vitest';

import { selectCustomerVpsDeployMachines } from '../../packages/platform/src/customer-vps-deploy-selection.js';

const customer = {
  handle: 'alice',
  provisioningClass: 'customer' as const,
};

const preview = {
  handle: 'pr-992',
  provisioningClass: 'preview' as const,
};

describe('customer VPS deploy selection', () => {
  it('excludes preview machines from untargeted fleet deploys', () => {
    expect(selectCustomerVpsDeployMachines([customer, preview], { version: 'v2026.07.16-765' }))
      .toEqual([customer]);
  });

  it('allows an explicitly targeted preview deploy', () => {
    expect(selectCustomerVpsDeployMachines([customer, preview], {
      version: 'v2026.07.14-pr992-db1ca31',
      handle: 'pr-992',
    })).toEqual([preview]);
  });

  it('returns no machines for an unknown explicit handle', () => {
    expect(selectCustomerVpsDeployMachines([customer, preview], {
      version: 'v2026.07.16-765',
      handle: 'missing',
    })).toEqual([]);
  });
});
