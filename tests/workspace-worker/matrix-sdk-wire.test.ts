import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDB, ensureHome, spawnKernel } from '../../packages/kernel/src/index.js';
import { resolveRequestedBetas, serializeFundedRequest } from '../../packages/proxy/src/funded-relay-request.js';

// These are the existing reviewed preview relay values, not a wildcard or a
// production policy change. A pinned SDK update must keep this contract valid.
const allowedBetas = new Set(['claude-code-20250219', 'structured-outputs-2025-11-13', 'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14', 'thinking-token-count-2026-05-13', 'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05', 'mid-conversation-system-2026-04-07', 'advisor-tool-2026-03-01', 'effort-2025-11-24']);
const lease = `sk-matrix-funded-wire_test.${'A'.repeat(43)}`;

it('the real Matrix kernel/SDK produces a funded-relay-compatible Messages request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'matrix-sdk-wire-'));
  const { homePath } = ensureHome(directory);
  const db = createDB();
  const receipts: Array<{ accepted: boolean; authenticated: boolean; model: unknown; toolCount: number; betas: string | null }> = [];
  const server = http.createServer(async (request, response) => {
    if (!request.url?.startsWith('/v1/messages')) { response.writeHead(404).end(); return; }
    if (receipts.length >= 8) { response.writeHead(429).end(); return; }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) { response.writeHead(413).end(); return; }
    }
    let accepted = false; let model: unknown; let toolCount = 0; let betas: string | null = null;
    try {
      const parsed = serializeFundedRequest(JSON.parse(body));
      model = parsed.request.model; toolCount = parsed.request.tools?.length ?? 0;
      betas = resolveRequestedBetas(request.headers['anthropic-beta'] as string | undefined, allowedBetas);
      accepted = true;
    } catch (error: unknown) { if (!(error instanceof Error)) throw error; }
    receipts.push({ accepted, authenticated: request.headers['x-api-key'] === lease, model, toolCount, betas });
    // Synthetic SSE tests only wire compatibility. It is not real inference,
    // paid settlement, restored agent execution, or deployed UI evidence.
    const message = { id: 'msg_wire', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5',
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const data of [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 25_000);
  try {
    const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    Object.assign(env, { PATH: process.env.PATH, HOME: homePath, CLAUDE_CONFIG_DIR: join(homePath, '.claude'),
      ANTHROPIC_API_KEY: lease, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' });
    const events = [];
    for await (const event of spawnKernel('Say ok', { db, homePath, model: 'claude-sonnet-5', maxTurns: 1, env }, abortController)) {
      events.push(event);
      if (events.length > 64) throw new Error('Unexpected kernel event count');
    }
    expect(events.some(event => event.type === 'result')).toBe(true);
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.every(receipt => receipt.accepted && receipt.authenticated && receipt.model === 'claude-sonnet-5')).toBe(true);
    expect(receipts.some(receipt => receipt.toolCount > 0)).toBe(true);
  } finally {
    clearTimeout(timer); abortController.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
