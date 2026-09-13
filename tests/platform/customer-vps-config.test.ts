import { describe, expect, it } from 'vitest';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';

describe('customer VPS bootstrap configuration', () => {
  it('keeps speech disabled by default and requires a dedicated safe origin when enabled', () => {
    expect(loadCustomerVpsConfig({})).toMatchObject({
      platformSpeechEnabled: false,
      platformSpeechOrigin: '',
    });
    expect(loadCustomerVpsConfig({
      MATRIX_PLATFORM_SPEECH_ENABLED: 'true',
      MATRIX_PLATFORM_SPEECH_ORIGIN: 'https://speech.matrix-os.com',
    })).toMatchObject({
      platformSpeechEnabled: true,
      platformSpeechOrigin: 'https://speech.matrix-os.com',
    });
    expect(() => loadCustomerVpsConfig({
      MATRIX_PLATFORM_SPEECH_ENABLED: 'true',
      MATRIX_PLATFORM_SPEECH_ORIGIN: 'http://speech.example',
    })).toThrow('Platform speech runtime is misconfigured');
    expect(() => loadCustomerVpsConfig({
      MATRIX_PLATFORM_SPEECH_ENABLED: 'true',
    })).toThrow('Platform speech runtime is misconfigured');
  });

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
