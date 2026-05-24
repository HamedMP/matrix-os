import { describe, expect, it } from 'vitest';
import {
  buildCustomerVpsProxyUrl,
  deriveEntitlementAccess,
} from '../../packages/platform/src/profile-routing.js';

describe('platform launch entitlement gates', () => {
  it('allows runtime access for active paid-beta entitlement', () => {
    expect(deriveEntitlementAccess({ status: 'active' })).toMatchObject({
      runtimeProxyAllowed: true,
      ownerDataPreserved: true,
      ownerDataExportable: true,
    });
  });

  it('blocks new paid access without deleting or hiding owner data', () => {
    const access = deriveEntitlementAccess({
      status: 'expired',
      effectiveAt: '2026-05-23T00:00:00.000Z',
    });

    expect(access).toMatchObject({
      runtimeProxyAllowed: false,
      ownerDataPreserved: true,
      ownerDataExportable: true,
      remediation: 'Renew paid beta access or ask an operator to grant access.',
    });
  });

  it('keeps changed entitlement in a restricted state until an operator reconciles it', () => {
    expect(deriveEntitlementAccess({ status: 'changed' })).toMatchObject({
      runtimeProxyAllowed: false,
      ownerDataPreserved: true,
      ownerDataExportable: true,
      remediation: 'Review entitlement change before granting paid-only access.',
    });
  });

  it('still builds the proxy URL for active entitlement without mutating machine data', () => {
    const machine = { status: 'running', publicIPv4: '203.0.113.10' };
    const url = buildCustomerVpsProxyUrl(
      machine,
      '/api/ping',
      '?x=1',
    );

    expect(url).toBe('https://203.0.113.10:443/api/ping?x=1');
    expect(machine).toEqual({ status: 'running', publicIPv4: '203.0.113.10' });
  });
});
