import { describe, it, expect } from 'vitest';
import { ProviderWorkflowSchema, ProviderWorkflowStartSchema, ProviderWorkflowKeySchema, ProviderWorkflowConnectionOptionSchema, ProviderWorkflowStartV2Schema, ProviderWorkflowKeyV2Schema, ProviderWorkflowV2Schema } from '@matrix-os/contracts';
const operation = { id: 'workflow_test', harnessInstanceId: 'harness_codex', kind: 'login', state: 'running', expiresAt: '2026-10-01T00:10:00Z', terminalSessionId: null, deviceCode: 'ABCD-EFGH', authorizationUrl: 'https://auth.openai.com/codex/device', safeFailure: null };
describe('additive provider workflow contracts', () => {
  it('keeps commands, URLs and credentials out of generic operation payloads', () => {
    expect(ProviderWorkflowStartSchema.safeParse({ harnessInstanceId: 'harness_codex', kind: 'login', method: 'device_code', idempotencyKey: 'request', command: 'malicious' }).success).toBe(false);
    expect(ProviderWorkflowSchema.safeParse({ ...operation, apiKey: 'sk-synthetic' }).success).toBe(false);
    expect(ProviderWorkflowKeySchema.safeParse({ harnessInstanceId: 'harness_codex', providerId: 'openai', apiKey: 'sk-synthetic\nAuthorization:bad' }).success).toBe(false);
  });
  it('accepts only trusted authorization origins without embedded credentials', () => {
    expect(ProviderWorkflowSchema.safeParse(operation).success).toBe(true);
    for (const authorizationUrl of ['https://auth.openai.com:444/codex/device', 'https://evil.example/codex/device', 'http://auth.openai.com/codex/device', 'https://user:password@auth.openai.com/codex/device']) expect(ProviderWorkflowSchema.safeParse({ ...operation, authorizationUrl }).success).toBe(false);
  });
});

describe('provider-qualified V2 workflow contracts', () => {
  const option = { id: 'anthropic_key', providerId: 'anthropic', authKind: 'api_key', billingKind: 'api_key', executionKind: 'native', availability: 'available' };
  it('requires exact server-issued option references without accepting provider overrides', () => {
    const start = { harnessInstanceId: 'pi', optionId: 'openai_device', idempotencyKey: 'attempt' };
    expect(ProviderWorkflowStartV2Schema.safeParse(start).success).toBe(true);
    expect(ProviderWorkflowStartV2Schema.safeParse({ ...start, providerId: 'anthropic' }).success).toBe(false);
    expect(ProviderWorkflowStartSchema.safeParse(start).success).toBe(false);
    expect(ProviderWorkflowKeyV2Schema.safeParse({ harnessInstanceId: 'pi', optionId: option.id, apiKey: 'sk-synthetic' }).success).toBe(true);
    expect(ProviderWorkflowKeyV2Schema.safeParse({ harnessInstanceId: 'pi', optionId: option.id, apiKey: 'sk-synthetic\nspoof' }).success).toBe(false);
  });
  it('validates semantic method, billing and availability combinations', () => {
    expect(ProviderWorkflowConnectionOptionSchema.safeParse(option).success).toBe(true);
    for (const invalid of [{ ...option, method: 'browser' }, { ...option, billingKind: 'subscription' }, { ...option, providerId: 'arbitrary' }, { ...option, availability: 'unavailable' }, { ...option, unavailableReason: 'unsupported_runtime' }]) {
      expect(ProviderWorkflowConnectionOptionSchema.safeParse(invalid).success).toBe(false);
    }
    expect(ProviderWorkflowConnectionOptionSchema.safeParse({ ...option, availability: 'unavailable', unavailableReason: 'unsupported_runtime' }).success).toBe(true);
    expect(ProviderWorkflowConnectionOptionSchema.safeParse({ ...option, authKind: 'subscription', billingKind: 'subscription', method: 'device_code' }).success).toBe(true);
  });
  it('adds nonsecret exact connection identity only in V2 receipts', () => {
    const receipt = { ...operation, connectionOption: option };
    expect(ProviderWorkflowV2Schema.safeParse(receipt).success).toBe(true);
    expect(ProviderWorkflowSchema.safeParse(receipt).success).toBe(false);
    expect(ProviderWorkflowV2Schema.safeParse({ ...receipt, connectionOption: { ...option, apiKey: 'secret' } }).success).toBe(false);
    expect(ProviderWorkflowV2Schema.safeParse({ ...operation, connectionOption: null }).success).toBe(true);
  });
});
