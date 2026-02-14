import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { insertUsage, checkQuota, setQuota, getUserUsage, getUsageSummary } from './db.js';
import { calculateCost } from './cost.js';

const ANTHROPIC_API = process.env.ANTHROPIC_API_URL ?? 'https://api.anthropic.com';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const PORT = Number(process.env.PROXY_PORT ?? 8080);

const app = new Hono();

// Instance registry (in-memory -- instances register on startup)
interface Instance {
  handle: string;
  gatewayUrl: string;
  shellPort: number;
  registeredAt: string;
  lastSeen: string;
}
const instances = new Map<string, Instance>();

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// Instance management
app.post('/instances/register', async (c) => {
  const body = await c.req.json<{ handle: string; gatewayUrl: string; shellPort: number }>();
  instances.set(body.handle, {
    handle: body.handle,
    gatewayUrl: body.gatewayUrl,
    shellPort: body.shellPort,
    registeredAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  });
  return c.json({ ok: true, instances: instances.size });
});

app.get('/instances', (c) => {
  return c.json([...instances.values()]);
});

app.delete('/instances/:handle', (c) => {
  instances.delete(c.req.param('handle'));
  return c.json({ ok: true });
});

// Cross-instance messaging: proxy routes message to target instance's gateway
app.post('/send/:targetHandle', async (c) => {
  const target = instances.get(c.req.param('targetHandle'));
  if (!target) return c.json({ error: 'Instance not found' }, 404);

  const body = await c.req.json<{ text: string; from: { handle: string; displayName?: string } }>();

  const resp = await fetch(`${target.gatewayUrl}/api/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: body.text, from: body.from }),
  });

  return c.json(await resp.json(), resp.status as any);
});

// Usage endpoints
app.get('/usage/:userId', (c) => {
  const usage = getUserUsage(c.req.param('userId'));
  return c.json(usage);
});

app.get('/usage/summary', (c) => {
  return c.json(getUsageSummary());
});

app.post('/quotas/:userId', async (c) => {
  const body = await c.req.json<{ dailyLimitUsd?: number | null; monthlyLimitUsd?: number | null }>();
  setQuota(c.req.param('userId'), body.dailyLimitUsd ?? null, body.monthlyLimitUsd ?? null);
  return c.json({ ok: true });
});

// Proxy all /v1/* requests to Anthropic
app.all('/v1/*', async (c) => {
  const userId = c.req.header('x-matrix-user') ?? 'anonymous';
  const sessionId = c.req.header('x-matrix-session') ?? undefined;

  // Check quota
  const quota = checkQuota(userId);
  if (!quota.allowed) {
    return c.json({
      type: 'error',
      error: { type: 'quota_exceeded', message: 'Usage quota exceeded' },
      quota: { dailyUsed: quota.dailyUsed, dailyLimit: quota.dailyLimit, monthlyUsed: quota.monthlyUsed, monthlyLimit: quota.monthlyLimit },
    }, 429);
  }

  // Use user's key if provided, otherwise use shared key
  const apiKey = c.req.header('x-api-key') ?? ANTHROPIC_KEY;
  if (!apiKey) {
    return c.json({ type: 'error', error: { type: 'auth_error', message: 'No API key configured' } }, 401);
  }

  const targetUrl = `${ANTHROPIC_API}${c.req.path}`;

  // Forward headers (strip proxy-specific ones)
  const headers = new Headers();
  headers.set('x-api-key', apiKey);
  headers.set('anthropic-version', c.req.header('anthropic-version') ?? '2023-06-01');
  const contentType = c.req.header('content-type');
  if (contentType) headers.set('content-type', contentType);
  const anthropicBeta = c.req.header('anthropic-beta');
  if (anthropicBeta) headers.set('anthropic-beta', anthropicBeta);

  const isStreaming = c.req.header('accept')?.includes('text/event-stream') ||
    (c.req.method === 'POST' && c.req.header('content-type')?.includes('json'));

  let requestBody: string | undefined;
  if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
    requestBody = await c.req.text();
  }

  // Check if streaming is requested in the body
  let bodyStreamFlag = false;
  if (requestBody) {
    try {
      const parsed = JSON.parse(requestBody);
      bodyStreamFlag = parsed.stream === true;
    } catch {}
  }

  const upstream = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: requestBody,
  });

  if (bodyStreamFlag && upstream.body) {
    // Streaming: pipe SSE through, collect usage from final event
    const [passthrough, collector] = upstream.body.tee();

    // Collect usage from stream in background
    collectStreamUsage(collector, userId, sessionId, upstream.status).catch(() => {});

    return new Response(passthrough, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  }

  // Non-streaming: read full response, log usage, return
  const responseText = await upstream.text();
  let model = 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  try {
    const data = JSON.parse(responseText);
    model = data.model ?? 'unknown';
    if (data.usage) {
      inputTokens = data.usage.input_tokens ?? 0;
      outputTokens = data.usage.output_tokens ?? 0;
      cacheReadTokens = data.usage.cache_read_input_tokens ?? 0;
      cacheWriteTokens = data.usage.cache_creation_input_tokens ?? 0;
    }
  } catch {}

  const costUsd = calculateCost({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

  insertUsage({
    userId, model, inputTokens, outputTokens,
    cacheReadTokens, cacheWriteTokens, costUsd,
    sessionId, status: upstream.status,
  });

  return new Response(responseText, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
});

async function collectStreamUsage(
  stream: ReadableStream<Uint8Array>,
  userId: string,
  sessionId: string | undefined,
  status: number
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let model = 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events for usage data
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.model) model = event.model;
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? outputTokens;
          }
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0;
            cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
            cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }

  const costUsd = calculateCost({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  insertUsage({
    userId, model, inputTokens, outputTokens,
    cacheReadTokens, cacheWriteTokens, costUsd,
    sessionId, status,
  });
}

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Proxy listening on :${PORT} -> ${ANTHROPIC_API}`);
});
