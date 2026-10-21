import { describe, expect, it, vi } from 'vitest';
import { ProviderWorkflowCodeNotAcceptedError, ProviderWorkflowNotStartedError, createProviderWorkflowService, type ProviderWorkflowAdapter } from '../../packages/gateway/src/ai-providers/provider-workflows.js';
const request = { harnessInstanceId: 'codex', kind: 'login' as const, method: 'device_code' as const, idempotencyKey: 'first' };
const adapter = (harness: 'codex' | 'claude', start: ProviderWorkflowAdapter['start']): ProviderWorkflowAdapter => ({ harnessInstanceId: harness, harness, displayName: harness, installState: 'installed', loginMethods: ['device_code'], apiKeyProviders: ['openai'], install: false, uninstall: false, start, verifyKey: vi.fn(async () => {}) });

describe('workflow uncertainty and recovery', () => {
  it('permits recovery only when the adapter proves failure before native side effects', async () => {
    const launch = vi.fn<ProviderWorkflowAdapter['start']>()
      .mockRejectedValueOnce(new ProviderWorkflowNotStartedError())
      .mockResolvedValue({ cancel: async () => {} });
    const native = adapter('codex', launch);
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [native] });
    const failed = await service.start('owner', request);
    expect(failed).toMatchObject({ state: 'failed', safeFailure: 'unavailable' });
    expect((await service.capabilities('owner'))[0].activeOperationId).toBeUndefined();
    expect((await service.start('owner', request)).id).toBe(failed.id);
    await expect(service.cancel('owner', failed.id)).resolves.toMatchObject({ state: 'failed' });
    await expect(service.verifyKey('owner', { harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'fixture-key' })).resolves.toEqual({ verified: true });
    expect((await service.start('owner', { ...request, idempotencyKey: 'recovered' })).state).toBe('running');
    expect(launch).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('still requires registered cleanup to drain even if launch is reported not started', async () => {
    const cleanup = vi.fn().mockRejectedValueOnce(new Error('lease still held')).mockResolvedValue(undefined);
    const native = adapter('codex', async ({ registerCleanup }) => {
      registerCleanup(cleanup);
      throw new ProviderWorkflowNotStartedError();
    });
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [native] });
    const failed = await service.start('owner', request);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(service.start('owner', { ...request, idempotencyKey: 'blocked' })).rejects.toThrow('conflict');
    await service.cancel('owner', failed.id);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect((await service.capabilities('owner'))[0].activeOperationId).toBeUndefined();
    await service.close();
  });

  it('retains same-profile admission after a launch throws without proving cleanup', async () => {
    const native = adapter('codex', async () => { throw new Error('uncertain native launch'); });
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [native] });
    const failed = await service.start('owner', request);
    expect(failed.state).toBe('failed');
    await expect(service.start('owner', { ...request, idempotencyKey: 'second' })).rejects.toThrow('conflict');
    await expect(service.verifyKey('owner', { harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'fixture-key' })).rejects.toThrow('conflict');
    await expect(service.cancel('owner', failed.id)).rejects.toThrow('unavailable');
    expect(native.verifyKey).not.toHaveBeenCalled();
    await service.close();
  });

  it('isolates failed expiry cleanup from other harness status, start and key work', async () => {
    let clock = new Date('2026-10-01T00:00:00Z');
    const failedCleanup = vi.fn(async () => { throw new Error('still running'); });
    const claude = adapter('claude', async () => ({ cancel: async () => {} }));
    const service = createProviderWorkflowService({ ownerId: 'owner', now: () => clock, adapters: [adapter('codex', async () => ({ cancel: failedCleanup })), claude] });
    const codex = await service.start('owner', request);
    clock = new Date('2026-10-01T00:10:01Z');
    expect(await service.status('owner', codex.id)).toMatchObject({ state: 'expired', safeFailure: 'unavailable' });
    const other = await service.start('owner', { ...request, harnessInstanceId: 'claude', idempotencyKey: 'other' });
    expect((await service.status('owner', other.id)).state).toBe('running');
    await service.cancel('owner', other.id);
    await expect(service.verifyKey('owner', { harnessInstanceId: 'claude', providerId: 'openai', apiKey: 'fixture-key' })).resolves.toEqual({ verified: true });
    await expect(service.start('owner', { ...request, idempotencyKey: 'blocked' })).rejects.toThrow('conflict');
    await service.close();
  });

  it('keeps uncertain terminal receipts within the existing cap without evicting protection', async () => {
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [adapter('codex', async () => { throw new Error('uncertain'); }), adapter('claude', async () => ({ cancel: async () => {} }))] });
    const first = await service.start('owner', request);
    for (let i = 0; i < 70; i++) {
      const other = await service.start('owner', { ...request, harnessInstanceId: 'claude', idempotencyKey: `other-${i}` });
      await service.cancel('owner', other.id);
    }
    await expect(service.start('owner', { ...request, idempotencyKey: 'retry' })).rejects.toThrow('conflict');
    expect((await service.status('owner', first.id)).state).toBe('failed');
    await service.close();
  });
});

describe('workflow cleanup and submission contracts', () => {
  it('keeps admission until early registered cleanup succeeds, then permits recovery', async () => {
    const cleanup = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
    const launch = vi.fn<ProviderWorkflowAdapter['start']>().mockImplementationOnce(async ({ registerCleanup }) => {
      registerCleanup(cleanup);
      throw new Error('launch uncertain');
    }).mockResolvedValue({ cancel: async () => {} });
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [adapter('codex', launch)] });
    const failed = await service.start('owner', request);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await service.capabilities('owner'))[0].activeOperationId).toBe(failed.id);
    await expect(service.start('owner', { ...request, idempotencyKey: 'blocked' })).rejects.toThrow('conflict');
    await service.cancel('owner', failed.id);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect((await service.start('owner', { ...request, idempotencyKey: 'recovered' })).state).toBe('running');
    await service.close();
  });

  it('retries only a definitely rejected code and serializes concurrent submissions', async () => {
    const submit = vi.fn().mockRejectedValueOnce(new ProviderWorkflowCodeNotAcceptedError()).mockResolvedValue(undefined);
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [adapter('codex', async () => ({ cancel: async () => {}, submitCode: submit }))] });
    const operation = await service.start('owner', request);
    await expect(service.submitCode('owner', operation.id, 'early')).rejects.toThrow('conflict');
    const results = await Promise.allSettled([service.submitCode('owner', operation.id, 'ready'), service.submitCode('owner', operation.id, 'duplicate')]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(submit.mock.calls).toEqual([['early'], ['ready']]);
    await service.close();
  });

  it('does not repeat a code after an ambiguous partial write failure', async () => {
    const submit = vi.fn(async () => { throw new Error('write callback failed'); });
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [adapter('codex', async () => ({ cancel: async () => {}, submitCode: submit }))] });
    const operation = await service.start('owner', request);
    await expect(service.submitCode('owner', operation.id, 'secret-code')).rejects.toThrow('write callback failed');
    await expect(service.submitCode('owner', operation.id, 'secret-code')).rejects.toThrow('conflict');
    expect(submit).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('attempts every independent shutdown cleanup even when one throws', async () => {
    const otherCleanup = vi.fn(async () => {});
    const service = createProviderWorkflowService({ ownerId: 'owner', adapters: [
      adapter('codex', async () => ({ cancel: async () => { throw new Error('busy'); } })),
      adapter('claude', async () => ({ cancel: otherCleanup })),
    ] });
    await service.start('owner', request);
    await service.start('owner', { ...request, harnessInstanceId: 'claude', idempotencyKey: 'other' });
    await service.close();
    expect(otherCleanup).toHaveBeenCalledTimes(1);
  });
});
