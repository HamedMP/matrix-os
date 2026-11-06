import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotRunCommand } from '@matrix-os/contracts';
import { requestPlanResponseStream } from '../../desktop/src/main/chatgpt-plan/responses.js';
import { runBotTurn } from '../../packages/bot-runtime/src/loop.js';
import type { BotBrokerClient } from '../../packages/bot-runtime/src/broker-client.js';
import { createBridgeModel } from '../../packages/bot-runtime/src/providers.js';
import { forwardChatGptPlanInference } from '../../packages/gateway/src/bots/chatgpt-plan-inference.js';
import type { ChatGptPlanAuthority } from '../../packages/gateway/src/bots/chatgpt-plan.js';
import type { BotRuntimeBinding } from '../../packages/gateway/src/bots/runtime-registry.js';
import { createScopeRuntimeBrokerServer } from '../../packages/gateway/src/collaboration/scope-runtime-broker.js';
import { ScopeRuntimeBotInferenceRequestSchema } from '../../packages/scope-runtime/src/broker-protocol.js';
import { inferenceActionForPath, startInferenceBridge } from '../../packages/scope-runtime/src/inference-bridge.js';
import { createUnixSocketTempDir } from '../helpers/unix-socket-temp.js';

const model = 'chunked-subscription-fixture';
const route: BotRunCommand['route'] = { api: 'openai-responses', modelId: model, input: ['text'], contextWindow: 128000, maxOutputTokens: 4096 };
const binding: BotRuntimeBinding = {
  runtimeHandle: `runtime_${'d'.repeat(32)}`, executionGeneration: '3', ownerId: 'owner_fixture',
  botId: 'bot_12345678', chatId: 'chat_fixture', taskId: 'task_fixture', runId: 'run_chunked',
  rootFingerprint: 'a'.repeat(64), route, accessSourceId: 'matrix_chatgpt_plan',
  subscription: { peerId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2', accountId: 'account_fixture', computerId: 'computer_fixture', grantRevision: 4 },
  capabilities: ['artifact.write'], requestClass: 'interactive',
};
const command: BotRunCommand = { version: 1, kind: 'bot.run', runId: 'run_chunked', route,
  systemPrompt: 'Offline chunked transport fixture.', capabilities: ['artifact.write'],
  limits: { maxToolActions: 2, maxInferenceCalls: 2 }, turn: { kind: 'prompt', text: 'Use the offline fixture.' } };
const encoder = new TextEncoder();
const event = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const message = (text: string) => ({ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const textPrefix = event('response.created', { response: { id: 'resp_fixture' } })
  + event('response.output_item.added', { output_index: 0, item: { ...message(''), status: 'in_progress', content: [] } })
  + event('response.output_text.delta', { output_index: 0, content_index: 0, item_id: 'msg_fixture', delta: 'LIVE_BEFORE_EOF' });
const completion = (output: unknown[]) => event('response.completed', { response: { id: 'resp_fixture', model, status: 'completed', output,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const textDone = event('response.output_item.done', { output_index: 0, item: message('LIVE_BEFORE_EOF') });
const fallback = event('response.output_item.done', { output_index: 0, item: message('FINAL_FIXTURE') }) + completion([message('FINAL_FIXTURE')]);
const args = JSON.stringify({ path: 'fixture.txt', content: 'IN_MEMORY_ONLY', mimeType: 'text/plain' });
const tool = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'write_artifact', arguments: args, status: 'completed' };
const toolPrefix = event('response.created', { response: { id: 'resp_fixture' } })
  + event('response.output_item.added', { output_index: 0, item: { ...tool, status: 'in_progress', arguments: '' } })
  + event('response.function_call_arguments.delta', { output_index: 0, item_id: tool.id, delta: args })
  + event('response.function_call_arguments.done', { output_index: 0, item_id: tool.id, arguments: args })
  + event('response.output_item.done', { output_index: 0, item: tool });
const cleanups: Array<() => Promise<void>> = [];
type EndFault = 'missing-end' | 'wrong-sequence' | 'disconnect';

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external fetch is allowed')); });
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) { try { await close(); } catch (error: unknown) { failures.push(error); } }
  expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, 'Chunked fixture cleanup failed');
});

function upstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false, eofSent = false, cancelled = false, version = 0, readAfterVersion = -1;
  let bytes = 0, largestEvent = 0;
  // No prefetch: pull after the last supplied chunk proves the native parser
  // has consumed it and requested the next read, rather than merely queuing it.
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { readAfterVersion = version; },
    cancel() { cancelled = true; closed = true; },
  }, { highWaterMark: 0 });
  return {
    body,
    push(text: string) {
      if (closed) throw new Error('Fixture source already closed');
      version++; bytes += Buffer.byteLength(text);
      for (const frame of text.split('\n\n').filter(Boolean)) largestEvent = Math.max(largestEvent, Buffer.byteLength(frame + '\n\n'));
      controller.enqueue(encoder.encode(text));
    },
    close() { if (!closed) { closed = true; eofSent = true; controller.close(); } },
    terminate() { if (!closed) { closed = true; controller.error(new Error('Fixture shutdown')); } },
    async waitingForMore() { const target = version; await expect.poll(() => readAfterVersion, { timeout: 3000 }).toBe(target); },
    get cancelled() { return cancelled; }, get eofSent() { return eofSent; },
    get bytes() { return bytes; }, get largestEvent() { return largestEvent; },
  };
}

/** Faults only the last UDS hop, after the real gateway/native stream completed. */
async function terminalFaultProxy(path: string, destination: string, mode: EndFault) {
  const sockets = new Set<Socket>(); // Two bounded request pairs, explicitly drained below.
  const releaseFrames: Array<() => void> = [];
  let heldEnd = false, released = false;
  const server = createServer({ allowHalfOpen: true }, client => {
    if (sockets.size >= 4) { client.destroy(); return; }
    const upstream = connect({ path: destination });
    sockets.add(client); sockets.add(upstream);
    for (const socket of [client, upstream]) {
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.once('close', () => sockets.delete(socket));
    }
    client.once('close', () => upstream.destroy());
    client.pipe(upstream);
    let pending = '', endFrame = '', finalized = false;
    const release = () => {
      if (!endFrame || finalized) return;
      finalized = true;
      if (mode === 'wrong-sequence') {
        const frame = JSON.parse(endFrame); frame.sequence++;
        client.end(JSON.stringify(frame) + '\n');
      } else if (mode === 'missing-end') client.end();
      else client.destroy();
    };
    releaseFrames.push(release);
    upstream.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (Buffer.byteLength(pending) > 512 * 1024) { client.destroy(); upstream.destroy(); return; }
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline + 1); pending = pending.slice(newline + 1);
        if (JSON.parse(line).stream === 'end') {
          endFrame = line; heldEnd = true; if (released) release();
        } else client.write(line);
      }
    });
    // The proxy deliberately withholds both the valid end frame and source EOF.
    // Tests release the exact fault only after that barrier has been reached.
    upstream.on('end', () => { if (released) release(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return {
    get heldEnd() { return heldEnd; },
    release() { released = true; for (const send of releaseFrames) send(); },
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([...sockets].map(socket => new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.destroy(); })));
      await closed; expect(sockets.size).toBe(0);
    },
  };
}

async function fixture(fault?: EndFault) {
  const dir = await createUnixSocketTempDir();
  const socketPath = join(dir, 'inference.sock'), brokerSocket = join(dir, 'broker.sock');
  const source = upstream(), stop = new AbortController();
  const agentEvents: string[] = [], projected: string[] = [];
  const saved: Array<Array<Record<string, unknown>>> = [];
  let nativeChunks = 0, nativeBytes = 0, largestNativeChunk = 0, settled = false;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body)).model).toBe(model);
    if (fetchFn.mock.calls.length > 2) throw new Error('Fixture inference call budget exceeded');
    return new Response(fetchFn.mock.calls.length === 1 ? source.body : fallback, { headers: { 'content-type': 'text/event-stream' } });
  });
  const authority: ChatGptPlanAuthority = {
    observe: vi.fn(), resolve: vi.fn(), revalidate: vi.fn(async () => true),
    infer: vi.fn(async () => { throw new Error('Chunked request must not use aggregate inference'); }),
    inferStream: vi.fn(async (_candidate, body, signal) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: (async function* () {
      // Real native stream parser, at the fake native-upstream seam. Peer
      // enrollment/signing/OAuth are intentionally outside this test.
      for await (const chunk of requestPlanResponseStream({ fetchFn, body, model, signal,
        accessToken: async () => 'offline-fixture-token', validate: () => signal.throwIfAborted() })) {
        nativeChunks++; const size = Buffer.byteLength(chunk); nativeBytes += size; largestNativeChunk = Math.max(largestNativeChunk, size); yield chunk;
      }
    })() })),
  };
  const realBrokerSocket = fault ? join(dir, 'real-broker.sock') : brokerSocket;
  const server = createScopeRuntimeBrokerServer({ socketPath: realBrokerSocket, botImageFrames: true,
    broker: { handle: async () => { throw new Error('Expected registered Bot inference'); }, close: async () => undefined },
    routeFrame: (raw, signal) => {
      const frame = ScopeRuntimeBotInferenceRequestSchema.parse(raw);
      expect(frame).toMatchObject({ responseMode: 'stream', action: 'inference.responses', runtimeHandle: binding.runtimeHandle, executionGeneration: '3' });
      return forwardChatGptPlanInference(frame, binding, { authority,
        signal: AbortSignal.any([signal, stop.signal]), stillAuthorized: () => !stop.signal.aborted });
    },
  });
  await server.start();
  const proxy = fault ? await terminalFaultProxy(brokerSocket, realBrokerSocket, fault) : undefined;
  const bridge = await startInferenceBridge({ brokerSocket, socketPath, botImages: true,
    runtimeHandle: binding.runtimeHandle, executionGeneration: '3', brokerTimeoutMs: 5000,
    actionFor: request => inferenceActionForPath(request.url) });
  const broker: BotBrokerClient = {
    loadSession: vi.fn(async () => ({ revision: 0, needsRecompaction: false, messages: [] })),
    saveSession: vi.fn(async (value: Parameters<BotBrokerClient['saveSession']>[0]) => { saved.push(value.messages); return { revision: 1 }; }),
    event: vi.fn(async value => { if (projected.length >= 64) throw new Error('Fixture event budget exceeded'); projected.push(value.event.type); }),
    tool: vi.fn(async request => { expect(request.capability).toBe('artifact.write'); return { ok: true, content: [{ type: 'text', text: 'In-memory acknowledgment only.' }] }; }),
  };
  // createBridgeModel installs the real createBotBridgeFetch for this Unix path.
  const sdkRoute = createBridgeModel(command.route, 'http://127.0.0.1:1', socketPath);
  const result = runBotTurn({ command, broker, bridgeOrigin: 'http://127.0.0.1:1', bridgeSocket: socketPath, route: sdkRoute, signal: stop.signal,
    onAgent: agent => { agent.subscribe(value => { if (value.type === 'message_update') {
      if (agentEvents.length >= 64) throw new Error('Fixture SDK event budget exceeded'); agentEvents.push(value.assistantMessageEvent.type);
    } }); },
  }).finally(() => { settled = true; });
  cleanups.push(async () => {
    stop.abort(); source.terminate();
    await bridge.close(); await proxy?.close(); await server.close(); await result;
    expect(bridge.server.listening).toBe(false); await rm(dir, { recursive: true, force: true });
  });
  return { source, stop, broker, authority, result, agentEvents, projected, fetchFn, saved, proxy,
    get nativeChunks() { return nativeChunks; }, get nativeBytes() { return nativeBytes; },
    get largestNativeChunk() { return largestNativeChunk; }, get settled() { return settled; } };
}

describe('ChatGPT chunked native-to-Pi inference over real private Unix sockets', () => {
  it('shows the first delta before EOF and accepts over 1MiB aggregate with bounded events', async () => {
    const f = await fixture(); f.source.push(textPrefix);
    await expect.poll(() => f.agentEvents.includes('text_delta'), { timeout: 3000 }).toBe(true);
    await expect.poll(() => f.projected.includes('assistant_delta'), { timeout: 3000 }).toBe(true);
    expect(f.source.eofSent).toBe(false); expect(f.settled).toBe(false); expect(f.broker.saveSession).not.toHaveBeenCalled();
    // Comments add wire volume without increasing model output/session/token work.
    for (let index = 0; index < 18; index++) f.source.push(`: ${'x'.repeat(65500)}\n\n`);
    f.source.push(textDone + completion([message('LIVE_BEFORE_EOF')]));
    await f.source.waitingForMore(); expect(f.settled).toBe(false);
    f.source.close(); const result = await f.result;
    expect(result).toMatchObject({ status: 'completed', toolActions: 0 });
    expect(f.source.bytes).toBeGreaterThan(1_048_576); expect(f.source.largestEvent).toBeLessThan(1_048_576);
    expect(f.nativeBytes).toBeGreaterThan(1_048_576); expect(f.nativeChunks).toBeGreaterThan(18);
    expect(f.largestNativeChunk).toBeLessThanOrEqual(65536); expect(f.fetchFn).toHaveBeenCalledOnce();
    expect(f.authority.infer).not.toHaveBeenCalled(); expect(f.broker.tool).not.toHaveBeenCalled();
  });

  it('holds completed and DONE so no tool executes until valid upstream EOF', async () => {
    const f = await fixture(); f.source.push(toolPrefix + completion([tool]) + 'data: [DONE]\n\n');
    await expect.poll(() => f.agentEvents.includes('toolcall_end'), { timeout: 3000 }).toBe(true);
    await f.source.waitingForMore();
    expect(f.source.eofSent).toBe(false); expect(f.broker.tool).not.toHaveBeenCalled();
    expect(f.broker.saveSession).not.toHaveBeenCalled(); expect(f.settled).toBe(false);
    f.source.close(); const result = await f.result;
    expect(result).toMatchObject({ status: 'completed', toolActions: 1 });
    expect(f.broker.tool).toHaveBeenCalledOnce(); expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails a late error after DONE without executing the already parsed tool', async () => {
    const f = await fixture(); f.source.push(toolPrefix + completion([tool]) + 'data: [DONE]\n\n');
    await expect.poll(() => f.agentEvents.includes('toolcall_end'), { timeout: 3000 }).toBe(true);
    await f.source.waitingForMore(); expect(f.broker.tool).not.toHaveBeenCalled();
    f.source.push(event('error', { code: 'fixture_late_error', message: 'Offline fixture error' })); f.source.close();
    expect(await f.result).toMatchObject({ status: 'failed', toolActions: 0 });
    expect(f.broker.tool).not.toHaveBeenCalled(); expect(f.fetchFn).toHaveBeenCalledOnce();
  });

  it('propagates Stop to the stalled native source and releases its reader', async () => {
    const f = await fixture(); f.source.push(textPrefix);
    await expect.poll(() => f.agentEvents.includes('text_delta'), { timeout: 3000 }).toBe(true);
    f.stop.abort(); expect(await f.result).toMatchObject({ status: 'cancelled', toolActions: 0 });
    await expect.poll(() => f.source.cancelled, { timeout: 3000 }).toBe(true);
    await expect.poll(() => f.source.body.locked, { timeout: 3000 }).toBe(false);
    expect(f.source.eofSent).toBe(false); expect(f.broker.tool).not.toHaveBeenCalled();
  });

  it.each(['missing-end', 'wrong-sequence', 'disconnect'] as const)('never commits the parsed tool after last-hop UDS %s', async fault => {
    const f = await fixture(fault);
    f.source.push(toolPrefix + completion([tool]) + 'data: [DONE]\n\n'); f.source.close();
    await expect.poll(() => f.proxy!.heldEnd, { timeout: 3000 }).toBe(true);
    await expect.poll(() => f.agentEvents.includes('toolcall_end'), { timeout: 3000 }).toBe(true);
    // Let the real HTTP/SDK consumer process the already forwarded chunks.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.broker.tool).not.toHaveBeenCalled(); expect(f.broker.saveSession).not.toHaveBeenCalled();
    expect(f.settled).toBe(false);
    f.proxy!.release();
    expect(await f.result).toMatchObject({ status: 'failed', toolActions: 0 });
    expect(f.broker.tool).not.toHaveBeenCalled(); expect(f.fetchFn).toHaveBeenCalledOnce();
    // Failed history is intentionally retained; it must not be a success checkpoint.
    expect(f.broker.saveSession).toHaveBeenCalledOnce();
    const assistants = f.saved.flat().filter(message => message.role === 'assistant');
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.every(message => ['error', 'aborted'].includes(String(message.stopReason)))).toBe(true);
    expect(f.saved.flat().some(message => message.role === 'toolResult' && message.isError !== true)).toBe(false);
  });
});
