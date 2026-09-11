import { describe, expect, it } from 'vitest';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';

describe('customer VPS bootstrap configuration', () => {
  it('keeps funded AI disabled unless a valid relay is explicitly configured', () => {
    expect(loadCustomerVpsConfig({})).toMatchObject({
      fundedAiEnabled: false,
      fundedAiRelayUrl: '',
    });
    expect(loadCustomerVpsConfig({
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
      MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.matrix-os.com',
    })).toMatchObject({
      fundedAiEnabled: true,
      fundedAiRelayUrl: 'https://relay.matrix-os.com',
    });
    expect(() => loadCustomerVpsConfig({
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
      MATRIX_FUNDED_AI_RELAY_URL: 'http://public-relay.example',
    })).toThrow('Funded AI runtime is misconfigured');
    expect(() => loadCustomerVpsConfig({
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
      MATRIX_FUNDED_AI_RELAY_URL: 'https://relay.example/path;touch-pwned',
    })).toThrow('Funded AI runtime is misconfigured');
    expect(() => loadCustomerVpsConfig({
      MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
    })).toThrow('Funded AI runtime is misconfigured');
  });

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
