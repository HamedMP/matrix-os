import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerChatgptPlanIpc } from '../../desktop/src/main/ipc/chatgpt-plan';
import { PlanStatusPhaseFailure, type PlanStatusObservation } from '../../desktop/src/main/chatgpt-plan/status-diagnostics';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { ChatgptPlanStatusResponseSchema } from '../../desktop/src/shared/chatgpt-plan-ipc';

const session = { runtimeSlot: 'primary', authGeneration: 1 };
const status = { state: 'disconnected', scope: 'this_device', models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: 'none' };
function fixture() {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
  const service = Object.fromEntries(['status', 'connect', 'rebind', 'cancel', 'disconnect', 'refreshModels', 'setGrant']
    .map(method => [method, vi.fn().mockResolvedValue(status)]));
  registerChatgptPlanIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, service as never, event => event === 'main');
  return { service, invoke: (event: unknown = 'main', input: unknown = session) => handlers.get('chatgpt-plan:status')!(event, input) };
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('safe main-process status failure warning', () => {
  it.each(['status', 'vault_protection', 'vault_cleanup', 'vault_open', 'vault_read', 'vault_decrypt'] as const)('warns once for thrown %s without raw details or extra work', async phase => {
    const f = fixture();
    const raw = new Error('secret-token owner-id https://private.test /private/path', { cause: { token: 'secret-token' } });
    f.service.status!.mockRejectedValue(phase === 'status' ? raw : new PlanStatusPhaseFailure(phase, 'unavailable', raw, { ownerMatches: false }));
    const value = ChatgptPlanStatusResponseSchema.parse(await f.invoke());
    if (!('kind' in value) || value.kind !== 'status_failure') throw new Error('missing failure envelope');
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[chatgpt-plan] Status operation failed', {
      phase, category: phase === 'status' ? 'unknown' : 'unavailable', correlationId: value.diagnostic.correlationId,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/secret-token|owner-id|private|token|ownerMatches|cause|stack|message|https/);
    expect(f.service.status).toHaveBeenCalledOnce();
    for (const [method, fn] of Object.entries(f.service)) if (method !== 'status') expect(fn).not.toHaveBeenCalled();
  });

  it('warns for invalid response schema with its own validated correlation', async () => {
    const f = fixture(); f.service.status!.mockResolvedValue({ ...status, accessToken: 'private-token' });
    const value = ChatgptPlanStatusResponseSchema.parse(await f.invoke());
    if (!('kind' in value)) throw new Error('missing failure envelope');
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('[chatgpt-plan] Status operation failed', {
      phase: 'response_schema', category: 'invalid_response', correlationId: value.diagnostic.correlationId,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-token');
  });

  it('keeps concurrent correlations distinct and rejects arbitrary typed error metadata', async () => {
    const f = fixture(); f.service.status!.mockRejectedValue(new PlanFailure('raw-owner-url', 'raw-secret-category', 599));
    const values = await Promise.all([f.invoke(), f.invoke()]);
    const ids = values.map(value => {
      const result = ChatgptPlanStatusResponseSchema.parse(value);
      if (!('kind' in result)) throw new Error('missing failure envelope');
      return result.diagnostic.correlationId;
    });
    expect(new Set(ids).size).toBe(2);
    expect(console.warn).toHaveBeenCalledTimes(2);
    for (const id of ids) expect(console.warn).toHaveBeenCalledWith('[chatgpt-plan] Status operation failed', { phase: 'status', category: 'unknown', correlationId: id });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/raw|599|httpStatus/);
  });

  it('preserves success and partial status_result without duplicate warnings or operations', async () => {
    const f = fixture();
    expect(await f.invoke()).toEqual(status);
    f.service.status!.mockImplementationOnce(async (_input: unknown, observation: PlanStatusObservation) => {
      observation.fail(new PlanFailure('models', 'http_error', 503), 'catalog');
      return status;
    });
    expect(await f.invoke()).toMatchObject({ kind: 'status_result', status, diagnostic: { phase: 'catalog', category: 'unavailable' } });
    expect(console.warn).not.toHaveBeenCalled(); expect(f.service.status).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted and malformed requests before service or warning', async () => {
    const f = fixture();
    await expect(f.invoke('embed')).rejects.toThrow('invalid request');
    await expect(f.invoke('main', { ...session, token: 'private' })).rejects.toThrow('invalid request');
    expect(f.service.status).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled();
  });
});
