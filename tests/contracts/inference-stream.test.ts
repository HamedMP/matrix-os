import { describe, expect, it } from 'vitest';
import { ChatGptPlanPeerReplySchema, ChatGptPlanPeerRequestSchema } from '@matrix-os/contracts';
import { ScopeRuntimeBotInferenceRequestSchema, ScopeRuntimeInferenceStreamFrameSchema } from '../../packages/scope-runtime/src/broker-protocol.js';

const id = '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1';
const sessionId = 'f18f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1';
describe('bounded inference stream contracts', () => {
  it('opts Bot and native peer inference into streaming without widening input authority', () => {
    const body = JSON.stringify({ model: 'test-model', stream: true, input: [] });
    expect(ScopeRuntimeBotInferenceRequestSchema.safeParse({ version: 1, action: 'inference.responses', requestId: id,
      runtimeHandle: 'runtime_22222222222222222222222222222222', executionGeneration: '7', method: 'POST', path: '/v1/responses', headers: {}, body,
      responseMode: 'stream' }).success).toBe(true);
    expect(ChatGptPlanPeerRequestSchema.safeParse({ version: 1, action: 'infer', id, sequence: 1, expiresAt: new Date().toISOString(),
      accountId: 'account', grantRevision: 1, computerId: 'computer', requestClass: 'interactive', runId: 'run_1', model: 'test-model', body,
      responseMode: 'stream' }).success).toBe(true);
  });
  it('bounds every peer chunk in UTF-8 bytes and validates ordered terminal envelopes', () => {
    const chunk = { version: 1, sessionId, id, ok: true, stream: 'chunk', sequence: 0, body: 'x'.repeat(64 * 1024) };
    expect(ChatGptPlanPeerReplySchema.safeParse(chunk).success).toBe(true);
    expect(ChatGptPlanPeerReplySchema.safeParse({ ...chunk, body: '😀'.repeat(16385) }).success).toBe(false);
    expect(ChatGptPlanPeerReplySchema.safeParse({ ...chunk, sequence: -1 }).success).toBe(false);
    expect(ChatGptPlanPeerReplySchema.safeParse({ ...chunk, stream: 'end', body: undefined }).success).toBe(false);
    expect(ChatGptPlanPeerReplySchema.safeParse({ version: 1, sessionId, id, ok: true, stream: 'end', sequence: 2 }).success).toBe(true);
  });
  it('separates start, chunk and end broker frames and refuses unknown headers', () => {
    expect(ScopeRuntimeInferenceStreamFrameSchema.safeParse({ version: 1, requestId: id, stream: 'start', status: 200,
      headers: { 'content-type': 'text/event-stream' } }).success).toBe(true);
    expect(ScopeRuntimeInferenceStreamFrameSchema.safeParse({ version: 1, requestId: id, stream: 'chunk', sequence: 0,
      body: 'x'.repeat(64 * 1024) }).success).toBe(true);
    expect(ScopeRuntimeInferenceStreamFrameSchema.safeParse({ version: 1, requestId: id, stream: 'end', sequence: 1 }).success).toBe(true);
    expect(ScopeRuntimeInferenceStreamFrameSchema.safeParse({ version: 1, requestId: id, stream: 'chunk', sequence: 0,
      body: 'x'.repeat(64 * 1024 + 1) }).success).toBe(false);
    expect(ScopeRuntimeInferenceStreamFrameSchema.safeParse({ version: 1, requestId: id, stream: 'start', status: 200,
      headers: { authorization: 'must-not-cross' } }).success).toBe(false);
  });
});
