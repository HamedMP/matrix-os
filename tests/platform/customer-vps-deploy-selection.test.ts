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

  it('deploys untargeted fleet versions only to customer machines', () => {
    const privatePreview = { handle: 'pv-1907-3fa91c2e', provisioningClass: 'private-preview' as const };
    expect(selectCustomerVpsDeployMachines([customer, preview, privatePreview], { channel: 'stable' }))
      .toEqual([customer]);
  });

  it('never lets an operator deploy replace a Private Preview bundle', () => {
    const privatePreview = { handle: 'pv-1907-3fa91c2e', provisioningClass: 'private-preview' as const };
    expect(selectCustomerVpsDeployMachines([customer, preview, privatePreview], {
      version: 'v2026.09.28-pr1907-1-1-abcdef0',
      handle: 'pv-1907-3fa91c2e',
    })).toEqual([]);
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
