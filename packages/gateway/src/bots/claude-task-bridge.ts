import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { z } from 'zod/v4';
import { BotToolRequestSchema, type BotToolCapability, type BotToolRequest, type BotToolResult } from '@matrix-os/contracts';
/** Fresh loopback listener and ephemeral bearer bind this child to one admitted Bot run. */
export async function openClaudeBotBridge(input: { capabilities: readonly BotToolCapability[]; signal: AbortSignal;
  authorize(): Promise<void>; call(request: BotToolRequest): Promise<BotToolResult> }) {
  const token = randomBytes(32).toString('hex'); const expected = Buffer.from(`Bearer ${token}`);
  const capabilities: readonly BotToolCapability[] = input.capabilities.filter(capability => capability !== 'agent.task');
  const app = new Hono(); let calls = 0;
  app.use('*', bodyLimit({ maxSize: 240 * 1024, onError: c => c.json({ error: 'unavailable' }, 413) }));
  app.post('/', async c => {
    const actual = Buffer.from(c.req.header('authorization') ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || input.signal.aborted) return c.json({ error: 'unavailable' }, 403);
    try {
      await input.authorize();
      const request = z.discriminatedUnion('action', [z.object({ action: z.literal('list') }).strict(),
        z.object({ action: z.literal('call'), tool: z.object({ capability: z.string(), args: z.unknown() }).strict() }).strict()]).parse(await c.req.json());
      if (request.action === 'list') return c.json({ tools: [{ name: 'call', description: 'Call one tool granted to this Bot. Owner approvals are enforced by Matrix.',
        inputSchema: { type: 'object', properties: { capability: { type: 'string', enum: capabilities }, args: { type: 'object' } }, required: ['capability', 'args'], additionalProperties: false } }] });
      const tool = BotToolRequestSchema.parse({ ...request.tool, toolCallId: `native_${randomUUID()}` });
      if (!capabilities.includes(tool.capability) || ++calls > 20) return c.json({ error: 'unavailable' }, 403);
      const result = await input.call(tool);
      return c.json(result.ok ? { content: result.content } : { isError: true, content: [{ type: 'text', text: 'This task action is unavailable or requires owner approval.' }] });
    } catch (error) { console.warn('[bot-task-bridge] Action refused:', error instanceof Error ? error.name : 'UnknownError'); return c.json({ error: 'unavailable' }, 403); }
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => { clearTimeout(timeout); resolve(listener as Server); });
    const timeout = setTimeout(() => { listener.close(); reject(new Error('Task bridge unavailable')); }, 5000);
    listener.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Task bridge unavailable'); }
  return { url: `http://127.0.0.1:${address.port}`, token,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
