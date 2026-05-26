import { describe, expect, it } from 'vitest';
import { shouldVerifyCustomerVpsTls } from '../../packages/platform/src/customer-vps-tls.js';

describe('customer VPS TLS policy', () => {
  it('verifies customer VPS certificates by default', () => {
    expect(shouldVerifyCustomerVpsTls({})).toBe(true);
  });

  it('allows an explicit local override for self-signed development VPSes', () => {
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: 'false' })).toBe(false);
  });

  it('does not disable verification for unset or true-like values', () => {
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: 'true' })).toBe(true);
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: '' })).toBe(true);
  });

  it('only exact lowercase false disables verification', () => {
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: 'False' })).toBe(true);
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: 'FALSE' })).toBe(true);
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: '0' })).toBe(true);
    expect(shouldVerifyCustomerVpsTls({ CUSTOMER_VPS_TLS_VERIFY: 'no' })).toBe(true);
  });
});
