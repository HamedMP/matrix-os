import { describe, expect, it } from 'vitest';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';

describe('customer VPS bootstrap configuration', () => {
  it('keeps registration tokens at the bounded clean-bootstrap lifetime', () => {
    expect(loadCustomerVpsConfig({}).registrationTokenTtlMs).toBe(60 * 60 * 1000);
    expect(loadCustomerVpsConfig({
      CUSTOMER_VPS_REGISTRATION_TOKEN_TTL_MS: '1800000',
    }).registrationTokenTtlMs).toBe(60 * 60 * 1000);
    expect(loadCustomerVpsConfig({
      CUSTOMER_VPS_REGISTRATION_TOKEN_TTL_MS: '7200000',
    }).registrationTokenTtlMs).toBe(60 * 60 * 1000);
  });
});
