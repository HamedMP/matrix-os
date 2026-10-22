import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { createManagedPiRuntime } from '../../../packages/gateway/src/chat/managed-pi-runtime.js';
import { createManagedPiAdmission } from '../../../packages/gateway/src/chat/managed-pi-admission.js';
import { createScopeRuntimeClient } from '../../../packages/gateway/src/collaboration/scope-runtime-client.js';
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from '../../../packages/gateway/src/bots/runtime-registry.js';
import { resolveManagedPiRoute } from '../../../packages/gateway/src/bots/route-resolver.js';
import { makeAiProviderSnapshot } from '../../fixtures/ai-provider-snapshot.js';
import type { ScopeRuntimeHost } from '../../../packages/gateway/src/scope-runtime-host/index.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export async function fixture(options: Parameters<typeof createManagedPiRuntime>[0]['quiescence'] = {},
  ownerTools?: Parameters<typeof createManagedPiRuntime>[0]['ownerTools']) {
  const home = await mkdtemp(join(tmpdir(), 'pi-quiescence-'));
  const sockets = new Set<Socket>();
  const snapshot = makeAiProviderSnapshot();
  const selection = { instanceId: 'matrix_pi_default', model: 'claude-sonnet-5' };
  const binding: ManagedPiRuntimeBinding = { kind: 'managed_chat', ownerId: 'owner_one', chatId: 'chat_one', runId: 'run_one',
    runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '2', workspace: { kind: 'chat_workspace' },
    rootFingerprint: 'b'.repeat(64), ...resolveManagedPiRoute(snapshot, selection), capabilities: ['artifact.read'], requestClass: 'interactive' };
  let stopReply: (requestId: string) => unknown = requestId => ({ version: 1, type: 'runtime.result', requestId, ok: true,
    runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, state: 'stopped' });
  let gate: Promise<void> = Promise.resolve();
  const stopped = vi.fn();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setEncoding('utf8');
    let bytes = '';
    socket.on('data', chunk => { bytes += chunk; });
    socket.on('end', () => {
      const request = JSON.parse(bytes) as { requestId: string; type: string };
      stopped(request.type);
      void gate.then(() => socket.end(`${JSON.stringify(stopReply(request.requestId))}\n`));
    });
  });
  const socketPath = join(home, 'supervisor.sock');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const client = createScopeRuntimeClient({ socketPath, profileCatalog: {}, timeoutMs: 500 });
  const registry = new BotRuntimeRegistry(); registry.bind(binding);
  const host = { available: true, client } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db: {} as Parameters<typeof createManagedPiAdmission>[0]['db'],
    homePath: home, host, registry, roots: { resolve: async () => { throw new Error('unused'); } } });
  const worker = deferred<Awaited<ReturnType<ScopeRuntimeHost['client']['runBot']>>>();
  const runBot = vi.fn(async (input: Parameters<ScopeRuntimeHost['client']['runBot']>[0]) => input.command.kind === 'bot.run'
    ? worker.promise : { ok: true as const, reply: { accepted: true } });
  const cancelInference = vi.fn((value: ManagedPiRuntimeBinding) => registry.cancelInference(value));
  let admitGate: Promise<void> = Promise.resolve();
  const admitted = vi.fn(async () => { await admitGate; return binding; });
  const runtime = createManagedPiRuntime({ admission: { ...admission, admit: admitted },
    host: { ...host, client: { ...client, runBot } }, providers: { getSnapshot: async () => snapshot },
    lifetime: new AbortController().signal, forgetRun: vi.fn(), cancelInference, quiescence: options, ownerTools });
  const controller = new AbortController();
  const iterator = runtime.adapter.start({ owner: { type: 'personal', ownerId: binding.ownerId }, chatId: binding.chatId,
    turnId: 'cturn_one', runId: binding.runId, prompt: 'synthetic', parts: [{ type: 'text', text: 'synthetic' }], selection,
    permissionMode: 'supervised', interactionMode: 'default', signal: controller.signal });
  const identity = { ownerId: binding.ownerId, chatId: binding.chatId, runId: binding.runId, signal: new AbortController().signal };
  async function start() { await iterator.next(); await vi.waitFor(() => expectRun()); }
  function expectRun() { if (!runBot.mock.calls.some(([input]) => input.command.kind === 'bot.run')) throw new Error('not started'); }
  const complete = () => worker.resolve({ ok: true, reply: { runId: binding.runId, status: 'cancelled', toolActions: 0 } });
  return { runtime, admission, binding, identity, iterator, controller, registry, cancelInference, stopped, start, complete, admitted,
    admissionGate(value: Promise<void>) { admitGate = value; },
    stopReply(value: typeof stopReply) { stopReply = value; }, stopGate(value: Promise<void>) { gate = value; },
    async close() { complete(); await runtime.close().catch((error: unknown) => { if (!(error instanceof Error)) throw error; });
      client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true }); },
  };
}
