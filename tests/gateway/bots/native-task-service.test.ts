import { describe, expect, it, vi } from 'vitest';
import { createNativeBotTasks } from '../../../packages/gateway/src/bots/native-task-service.js';
import type { BotRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
const binding: BotRuntimeBinding = { runtimeHandle: `runtime_${'f'.repeat(32)}`, executionGeneration: '1', runId: 'run_test', ownerId: 'owner', botId: 'bot_test', taskId: 'task_test', chatId: 'chat_test', rootFingerprint: 'f'.repeat(64), route: { api: 'anthropic-messages', modelId: 'coordinator', input: ['text'], contextWindow: 10000, maxOutputTokens: 1000 }, accessSourceId: 'matrix_included', requestClass: 'interactive', capabilities: ['agent.task', 'artifact.read'] };
function fixture() {
  let admitted = { model: 'observed', revision: 1, grantRevision: 1, sessionId: null as string | null };
  const release = vi.fn(async () => undefined); const acquire = vi.fn(async () => release);
  const saveSession = vi.fn(async () => undefined); const callTool = vi.fn(async () => ({ ok: true as const, content: [{ type: 'text' as const, text: 'artifact' }] }));
  const admit = vi.fn(async () => admitted);
  const lifetime = new AbortController();
  return { release, acquire, saveSession, callTool, admit, lifetime, switchGrant: () => { admitted = { ...admitted, grantRevision: 2 }; } };
}
describe('official Claude Bot task service', () => {
  it('runs the separate native child under the recipe Bot Matrix-funded coordinator and same scoped broker', async () => {
    const f = fixture();
    const runTask = vi.fn(async (input) => {
      expect(f.acquire).toHaveBeenCalledWith('claude', { kind: 'write', durable: true }); expect(f.release).not.toHaveBeenCalled();
      const headers = { authorization: `Bearer ${input.mcpToken}`, 'content-type': 'application/json' };
      const request = (body: unknown) => fetch(input.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      expect((await (await request({ action: 'list' })).json()).tools[0].inputSchema.properties.capability.enum).toEqual(['artifact.read']);
      expect((await request({ action: 'call', tool: { capability: 'artifact.read', args: { relPath: 'result.txt' } } })).status).toBe(200);
      expect(f.callTool).toHaveBeenCalledWith(binding, expect.objectContaining({ capability: 'artifact.read' }), expect.any(AbortSignal));
      expect((await request({ action: 'call', tool: { capability: 'agent.task', args: { prompt: 'recurse' } } })).status).toBe(403);
      f.switchGrant(); expect((await request({ action: 'list' })).status).toBe(403);
      return { text: 'finished', sessionId: 'native_session' };
    });
    const service = createNativeBotTasks({ homePath: '/owner', connections: { admit: f.admit, saveSession: f.saveSession }, registry: { lookupRun: () => binding }, profileGuard: { acquire: f.acquire }, lifetime: f.lifetime.signal, callTool: f.callTool, runTask });
    await expect(service.execute(binding, 'work', '/owner/bots/work', new AbortController().signal)).rejects.toThrow('Task authority changed');
    expect(f.saveSession).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce(); await service.close();
  });
  it('holds native profile and single-Bot admission until the actual child drains after Stop', async () => {
    const f = fixture(); let drain!: (value: { text: string; sessionId: string }) => void;
    const runTask = vi.fn(async () => new Promise<{ text: string; sessionId: string }>(resolve => { drain = resolve; }));
    const service = createNativeBotTasks({ homePath: '/owner', connections: { admit: f.admit, saveSession: f.saveSession }, registry: { lookupRun: () => binding }, profileGuard: { acquire: f.acquire }, lifetime: f.lifetime.signal, callTool: f.callTool, runTask });
    const stop = new AbortController(); const task = service.execute(binding, 'work', '/owner/bots/work', stop.signal).catch(error => error);
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce()); stop.abort();
    await expect(service.execute(binding, 'another', '/owner/bots/work', stop.signal)).rejects.toThrow('not_granted');
    let closed = false; const closing = service.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false); expect(f.release).not.toHaveBeenCalled(); drain({ text: 'finished', sessionId: 'native_session' });
    await task; await closing; expect(f.release).toHaveBeenCalledOnce(); expect(f.saveSession).not.toHaveBeenCalled();
  });
  it('saves native session provenance only after successful drain and rejects ordinary managed Chat grants', async () => {
    const f = fixture(); const runTask = vi.fn(async () => ({ text: 'finished', sessionId: 'native_session' }));
    const service = createNativeBotTasks({ homePath: '/owner', connections: { admit: f.admit, saveSession: f.saveSession }, registry: { lookupRun: () => binding }, profileGuard: { acquire: f.acquire }, lifetime: f.lifetime.signal, callTool: f.callTool, runTask });
    expect(await service.execute(binding, 'work', '/owner/bots/work', new AbortController().signal)).toMatchObject({ ok: true });
    expect(f.saveSession).toHaveBeenCalledWith('owner', 'bot_test', 1, 'native_session'); expect(f.release).toHaveBeenCalledOnce();
    await expect(service.prepare({ ...binding, kind: 'managed_chat', workspace: { kind: 'chat_workspace' } } as never)).rejects.toThrow('not_granted');
    await service.close();
  });

});
