import { afterEach, expect, it, vi } from 'vitest';
import { requestPlanResponseStream } from '../../desktop/src/main/chatgpt-plan/responses';
import { logPlanFailure, observePlanFailures, PlanFailure, safePlanFailureRecord } from '../../desktop/src/main/chatgpt-plan/diagnostics';

const secret = 'PRIVATE-fixture-token-body-account';
const model = 'fixture-model';
const body = JSON.stringify({ model, input: [{ role: 'user', content: secret }], store: false, stream: true });
const completed = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model } })}\n\n`;
const delta = 'data: {"type":"response.output_text.delta","delta":"PRIVATE-fixture-token-body-account"}\n\n';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function failureOf(response: Response) {
  const fetchFn = vi.fn(async () => response);
  let failure: unknown;
  try {
    for await (const _chunk of requestPlanResponseStream({ fetchFn, body, model,
      signal: new AbortController().signal, accessToken: async () => secret, validate: () => {} })) { /* consume real parser */ }
  } catch (error: unknown) { failure = error; }
  expect(failure).toBeInstanceOf(PlanFailure);
  expect(fetchFn).toHaveBeenCalledOnce();
  return failure as PlanFailure;
}

it.each([
  ['frame_fields', 'invalid_stream', 'PRIVATE-unframed\n\n'],
  ['event_json', 'invalid_stream', 'data: {PRIVATE-bad-json}\n\n'],
  ['event_schema', 'invalid_stream', 'data: {"PRIVATE":"value"}\n\n'],
  ['event_name', 'invalid_stream', 'event: response.failed\ndata: {"type":"response.created"}\n\n'],
  ['output_delta', 'invalid_stream', 'data: {"type":"response.output_text.delta","delta":1}\n\n'],
  ['terminal_identity', 'invalid_stream', 'data: {"type":"response.completed","response":{"status":"completed","model":"PRIVATE-wrong-model"}}\n\n'],
  ['done_order', 'incomplete_stream', 'data: [DONE]\n\n'],
  ['event_after_terminal', 'incomplete_stream', completed + delta],
  ['upstream_failed', 'incomplete_stream', 'data: {"type":"response.failed"}\n\n'],
  ['upstream_incomplete', 'incomplete_stream', 'data: {"type":"response.incomplete"}\n\n'],
  ['upstream_error', 'incomplete_stream', 'data: {"type":"error"}\n\n'],
  ['trailing_frame', 'incomplete_stream', completed.trimEnd()],
  ['missing_completion', 'incomplete_stream', delta],
] as const)('retains fixed parser branch %s through the disk recording seam without private content', async (reason, category, text) => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rows: unknown[] = [], dispose = observePlanFailures(row => rows.push(row));
  try {
    const failure = await failureOf(new Response(text));
    expect(failure).toMatchObject({ category, responseDiagnostic: { streamReason: reason } });
    logPlanFailure('responses', failure, { runId: 'run_0123456789abcdef0123456789abcdef' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category, responseDiagnostic: { streamReason: reason } });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE');
  } finally { dispose(); }
});

it('distinguishes a body-read connection failure after HTTP200 and records fixed Chromium metadata, without replay', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new TypeError('net::ERR_HTTP2_PROTOCOL_ERROR PRIVATE-secret-path')); },
  }));
  const failure = await failureOf(response);
  expect(failure).toMatchObject({ category: 'invalid_stream', httpStatus: 200,
    responseDiagnostic: { streamReason: 'body_read', bodyRead: 'failed' },
    networkDiagnostic: { phase: 'body_read', chromiumCode: 'ERR_HTTP2_PROTOCOL_ERROR' } });
  expect(JSON.stringify(failure)).not.toContain('PRIVATE');
});

it('distinguishes invalid UTF8 from an interrupted read and retains reader cleanup', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } });
  const failure = await failureOf(new Response(stream));
  expect(failure).toMatchObject({ category: 'invalid_stream', responseDiagnostic: { streamReason: 'utf8_decode' } });
  expect(failure.networkDiagnostic).toBeUndefined();
  expect(stream.locked).toBe(false);
});

it('distinguishes missing body without inventing a network failure', async () => {
  expect(await failureOf(new Response(null))).toMatchObject({ category: 'invalid_stream', responseDiagnostic: { streamReason: 'body_missing' } });
});

it('re-sanitizes all response metadata at the disk boundary and rejects arbitrary reason/model/body strings', () => {
  const base = { observedAt: '2026-10-22T00:00:00.000Z', stage: 'responses', category: 'invalid_stream' };
  expect(safePlanFailureRecord({ ...base, responseDiagnostic: { streamReason: 'terminal_identity', responseStatus: 'completed', model: secret, body: secret } }))
    .toEqual({ ...base, responseDiagnostic: { streamReason: 'terminal_identity', responseStatus: 'completed' } });
  expect(safePlanFailureRecord({ ...base, responseDiagnostic: { streamReason: secret, model: secret, errorCode: secret } })).toEqual(base);
});
