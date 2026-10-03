import { describe, it, expect } from 'vitest';
import { ProviderWorkflowSchema, ProviderWorkflowStartSchema, ProviderWorkflowKeySchema } from '@matrix-os/contracts';
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
