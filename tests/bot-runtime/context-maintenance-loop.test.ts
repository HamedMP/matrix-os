import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import type { BotEvent, BotRunCommand } from '@matrix-os/contracts';
import { expect, it } from 'vitest';
import { runBotTurn } from '../../packages/bot-runtime/src/loop.js';
import type { BotBrokerClient } from '../../packages/bot-runtime/src/broker-client.js';

const command = (window = 16_384): BotRunCommand => ({
  version: 1, kind: 'bot.run', runId: 'run_context_1', systemPrompt: 'You are the synthetic context QA assistant.',
  route: { api: 'anthropic-messages', modelId: 'faux-context', input: ['text', 'image'], contextWindow: window, maxOutputTokens: 1_024 },
  capabilities: ['artifact.read'], limits: { maxToolActions: 6, maxInferenceCalls: 9 },
  turn: { kind: 'prompt', text: 'Keep the current task: produce READY.' },
});
const history = () => Array.from({ length: 5 }, (_, i) => [
  { role: 'user', content: `Earlier synthetic question ${i}`, timestamp: i * 2 },
  { ...fauxAssistantMessage(fauxText('r'.repeat(85_000))), timestamp: i * 2 + 1 },
]).flat() as unknown as Record<string, unknown>[];
function broker(messages: Record<string, unknown>[] = []) {
  const events: BotEvent[] = [], saves: unknown[] = [];
  const client: BotBrokerClient = {
    loadSession: async () => ({ revision: 1, needsRecompaction: false, messages }),
    saveSession: async input => { saves.push(input); return { revision: 2 }; },
    tool: async () => ({ ok: true, content: [{ type: 'text', text: 't'.repeat(32 * 1024) }] }),
    event: async event => { events.push(event); },
  };
  return { client, events, saves };
}

it('compacts pressure before ordinary inference and makes no summary call after final text', async () => {
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 16_384, maxTokens: 1_024 }] });
  const calls: Array<{ summary: boolean; bytes: number; goal: boolean }> = [];
  const response = (context: TranscriptContext) => {
    const text = JSON.stringify(context), summary = text.includes('Summarize the conversation');
    calls.push({ summary, bytes: Buffer.byteLength(text), goal: text.includes('Keep the current task: produce READY.') });
    return fauxAssistantMessage(fauxText(summary ? 'Prior decisions are summarized safely.' : 'READY'));
  };
  provider.setResponses(Array.from({ length: 9 }, () => response));
  const b = broker(history());
  const result = await runBotTurn({ command: command(), broker: b.client, route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000', now: () => Date.now() });
  expect(result.status).toBe('completed');
  expect(calls[0]!.summary).toBe(true);
  expect(calls.at(-1)!.summary).toBe(false);
  expect(calls.filter(call => !call.summary).every(call => call.bytes < 64 * 1024 && call.goal)).toBe(true);
  expect(b.events.flatMap(event => event.event.type === 'assistant_delta' ? [event.event.text] : []).join('')).toBe('READY');
});

it('bounds an active single-turn context at complete tool boundaries without orphaning tool calls', async () => {
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 16_384, maxTokens: 1_024 }] });
  const contexts: Array<{ messages: Array<Record<string, unknown>> }> = [];
  let reads = 0;
  provider.setResponses(Array.from({ length: 9 }, () => context => {
    contexts.push(structuredClone(context) as never);
    if (reads < 6) return fauxAssistantMessage(fauxToolCall('read_artifact', { path: `case-${++reads}.md` }, { id: `call_${reads}` }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(fauxText('READY'));
  }));
  const b = broker();
  expect((await runBotTurn({ command: command(), broker: b.client, route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000' })).status).toBe('completed');
  expect(contexts).toHaveLength(7);
  for (const context of contexts) {
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(64 * 1024);
    const callIds = context.messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.flatMap(part => part.type === 'toolCall' ? [part.id] : []) : []);
    for (const message of context.messages) if (message.role === 'toolResult') expect(callIds).toContain(message.toolCallId);
  }
  expect(reads).toBe(6);
});

it('cancels during maintenance without an ordinary model call or losing person messages', async () => {
  const controller = new AbortController();
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 16_384, maxTokens: 1_024 }] });
  let ordinary = 0;
  provider.setResponses(Array.from({ length: 9 }, () => context => {
    if (JSON.stringify(context).includes('Summarize the conversation')) controller.abort();
    else ordinary += 1;
    return fauxAssistantMessage(fauxText('A summary that must not replace history after cancellation.'));
  }));
  const b = broker(history());
  const result = await runBotTurn({ command: command(), broker: b.client, signal: controller.signal,
    route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000' });
  expect(result.status).toBe('cancelled');
  expect(ordinary).toBe(0);
  for (let i = 0; i < 5; i++) expect(JSON.stringify(b.saves)).toContain(`Earlier synthetic question ${i}`);
  expect(JSON.stringify(b.saves)).toContain('Keep the current task: produce READY.');
});

it('retains a correction accepted while maintenance runs and saves it only once', async () => {
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 16_384, maxTokens: 1_024 }] });
  let steer: ((text: string) => boolean) | undefined, accepted: boolean | undefined;
  provider.setResponses(Array.from({ length: 9 }, () => context => {
    const text = JSON.stringify(context);
    if (text.includes('Summarize the conversation')) {
      accepted = steer?.('NEWGOAL-SAFE-CORRECTION');
      return fauxAssistantMessage(fauxText('Earlier notes summarized.'));
    }
    return fauxAssistantMessage(fauxText(text.includes('NEWGOAL-SAFE-CORRECTION') ? 'APPLIED' : 'READY'));
  }));
  const b = broker(history());
  const result = await runBotTurn({ command: command(), broker: b.client,
    onControl: control => { steer = control.steer; }, route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000' });
  expect(result.status).toBe('completed');
  expect(accepted).toBe(true);
  expect(b.events.flatMap(event => event.event.type === 'assistant_delta' ? [event.event.text] : []).join('')).toContain('APPLIED');
  const saved = b.saves[0] as { messages: Array<{ role: string; content: unknown }> };
  expect(saved.messages.filter(message => message.role === 'user' && message.content === 'NEWGOAL-SAFE-CORRECTION')).toHaveLength(1);
});

it('preserves the current image and does not mistake its encoded bytes for text-context pressure', async () => {
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 16_384, maxTokens: 1_024, input: ['text', 'image'] }] });
  const data = 'A'.repeat(600_000);
  let ordinary = 0, summaries = 0, imageSeen = false;
  provider.setResponses(Array.from({ length: 9 }, () => context => {
    const summary = JSON.stringify(context).includes('Summarize the conversation');
    if (summary) summaries += 1;
    else {
      ordinary += 1;
      imageSeen = context.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image' && part.data === data));
    }
    return fauxAssistantMessage(fauxText(summary ? 'Earlier small notes.' : 'READY'));
  }));
  const b = broker([{ role: 'user', content: 'Earlier small question', timestamp: 1 }, { ...fauxAssistantMessage(fauxText('Small note')), timestamp: 2 }]);
  const c = command();
  c.turn = { kind: 'prompt', text: 'Inspect the current synthetic image.', images: [{ mimeType: 'image/png', data }] };
  expect((await runBotTurn({ command: c, broker: b.client, route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000' })).status).toBe('completed');
  expect(ordinary).toBe(1);
  expect(summaries).toBe(0);
  expect(imageSeen).toBe(true);
  expect(JSON.stringify(b.saves)).not.toContain(data);
});

it('stops before inference when person text cannot fit, without silently truncating the answer', async () => {
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 4_096, maxTokens: 1_024 }] });
  let requests = 0;
  provider.setResponses(Array.from({ length: 9 }, () => () => {
    requests += 1;
    return fauxAssistantMessage(fauxText('READY'));
  }));
  const c = command(4_096), text = `PERSON-START-${'p'.repeat(24_000)}-PERSON-END`;
  c.turn = { kind: 'prompt', text };
  const b = broker();
  const result = await runBotTurn({ command: c, broker: b.client,
    route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000' });
  expect(result).toMatchObject({ status: 'blocked', blockedReason: 'budget_exhausted' });
  expect(requests).toBe(0);
  expect(JSON.stringify(b.saves)).toContain(text);
});

it('keeps the active prompt image across a pressured tool boundary and accepted correction', async () => {
  const provider = fauxProvider({ models: [{ id: 'faux-context', contextWindow: 8_192, maxTokens: 1_024, input: ['text', 'image'] }] });
  const data = 'A'.repeat(600_000), c = command(8_192), b = broker();
  c.turn = { kind: 'prompt', text: 'ACTIVE-IMAGE-TASK: inspect this image.', images: [{ mimeType: 'image/png', data }] };
  let steer: ((text: string) => boolean) | undefined, ordinary = 0;
  const imageSeen: boolean[] = [];
  provider.setResponses(Array.from({ length: 9 }, () => context => {
    const serialized = JSON.stringify(context);
    if (serialized.includes('Summarize the conversation')) return fauxAssistantMessage(fauxText('Earlier image task summarized.'));
    imageSeen.push(context.messages.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'image' && part.data === data)));
    if (++ordinary === 1) {
      expect(steer?.('CORRECTION: focus on the original image.')).toBe(true);
      return fauxAssistantMessage(fauxToolCall('read_artifact', { path: 'pressure.md' }, { id: 'active_image_tool' }), { stopReason: 'toolUse' });
    }
    expect(serialized).toContain('ACTIVE-IMAGE-TASK');
    expect(serialized).toContain('CORRECTION: focus on the original image.');
    return fauxAssistantMessage(fauxText('READY'));
  }));
  const result = await runBotTurn({ command: c, broker: b.client,
    onControl: control => { steer = control.steer; }, route: { provider: provider.provider, model: provider.getModel() }, bridgeOrigin: 'http://127.0.0.1:41000' });
  expect(result.status).toBe('completed');
  expect(imageSeen).toEqual([true, true]);
});
