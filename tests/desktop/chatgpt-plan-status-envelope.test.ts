import { expect, it, vi } from 'vitest';
import { registerChatgptPlanIpc } from '../../desktop/src/main/ipc/chatgpt-plan';
import { PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { ChatgptPlanDiagnosticSchema, ChatgptPlanStatusResponseSchema } from '../../desktop/src/shared/chatgpt-plan-ipc';
import { createDesktopChatgptPlanClient } from '../../desktop/src/renderer/src/features/settings/local-chatgpt-plan-client';
const session = { runtimeSlot: 'primary', authGeneration: 1 };
const status = { state: 'disconnected', scope: 'this_device', models: [], grant: { revision: 0, enabled: false, background: false }, bridgeConnected: false, revocation: 'none' };
const diagnostic = { phase: 'vault_open', category: 'unavailable', at: '2026-10-16T00:00:00.000Z', correlationId: '00000000-0000-4000-8000-000000000001' };
function fixture() {
  const handlers = new Map<string, (e: unknown, input: unknown) => Promise<unknown>>();
  const service = Object.fromEntries(['status', 'connect', 'rebind', 'cancel', 'disconnect', 'refreshModels', 'setGrant'].map(method => [method, vi.fn().mockResolvedValue(status)]));
  registerChatgptPlanIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, service as never, e => e === 'main');
  return { handler: handlers.get('chatgpt-plan:status')!, service };
}
it('isolates concurrent operation IDs and never reflects arbitrary typed error metadata', async () => {
  const x = fixture();
  x.service.status!.mockRejectedValue(new PlanFailure('private account URL/path', 'private token category', 599));
  const [a, b] = await Promise.all([x.handler('main', session), x.handler('main', session)]);
  expect(a).toMatchObject({ kind: 'status_failure', diagnostic: { phase: 'status', category: 'unknown' } });
  const first = ChatgptPlanStatusResponseSchema.parse(a), second = ChatgptPlanStatusResponseSchema.parse(b);
  if (!('kind' in first) || !('kind' in second)) throw new Error('missing failure envelope');
  expect(first.diagnostic.correlationId).not.toBe(second.diagnostic.correlationId);
  expect(Number.isFinite(Date.parse(first.diagnostic.at))).toBe(true);
  expect(first.diagnostic).not.toHaveProperty('httpStatus');
  expect(first.diagnostic).not.toHaveProperty('ownerMatches');
  expect(JSON.stringify([a, b])).not.toMatch(/private|path|URL|599|ownerId|token/);
  expect(x.service.status).toHaveBeenCalledTimes(2);
});
it('rejects unknown keys, phases, categories and HTTP codes at the shared boundary', () => {
  for (const value of [{ ...diagnostic, message: 'private' }, { ...diagnostic, phase: 'raw path' }, { ...diagnostic, category: 'provider detail' }, { ...diagnostic, httpStatus: 599 }, { ...diagnostic, correlationId: 'owner/account' }, { ...diagnostic, at: 'unknown' }]) {
    expect(ChatgptPlanDiagnosticSchema.safeParse(value).success).toBe(false);
  }
});
it.each(['status_failure', 'status_result'])('discards a late %s before retaining metadata after abort or owner change', async kind => {
  for (const mode of ['abort', 'identity']) {
    let current = true, resolve!: (value: unknown) => void;
    const call = vi.fn(() => new Promise(done => { resolve = done; }));
    const client = createDesktopChatgptPlanClient(session, () => current, call), controller = new AbortController();
    const pending = client.status(controller.signal);
    if (mode === 'abort') controller.abort(); else current = false;
    resolve({ kind, diagnostic, ...(kind === 'status_result' ? { status } : {}) });
    await expect(pending).rejects.toThrow('ChatGPT connection is unavailable');
    expect(client.getLastDiagnostic()).toBeNull(); expect(call).toHaveBeenCalledOnce();
  }
});
it.each([[401, 'rejected'], [403, 'rejected'], [429, 'unavailable'], [503, 'unavailable']] as const)('classifies natural HTTP %s without exposing provider detail', async (code, category) => {
  const x = fixture(); x.service.status!.mockRejectedValue(new PlanFailure('models', 'http_error', code));
  expect(await x.handler('main', session)).toMatchObject({ kind: 'status_failure', diagnostic: { category, httpStatus: code } });
});
