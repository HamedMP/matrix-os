import { afterEach, expect, it, vi } from 'vitest';
import { classifyEdgeRoute, handleEdgeRouterRequest } from '../../packages/edge-router/src/index.js';

const hostname = 'starter-preview.matrix-os.com';
const env = { PLATFORM_ORIGIN: 'https://pr-2758---matrix-platform-preview.example.run.app', EDGE_ROUTER_SECRET: 'preview-edge-secret' };
afterEach(() => vi.restoreAllMocks());

it('keeps a dedicated preview host closed unless explicitly configured', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  expect((await handleEdgeRouterRequest(new Request(`https://${hostname}/workspace`), env)).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
});

it('forwards the exact configured app hostname through the existing authenticated proxy', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  const response = await handleEdgeRouterRequest(new Request(`https://${hostname}/workspace`, {
    headers: { 'x-forwarded-host': 'app.matrix-os.com', 'x-matrix-edge-secret': 'forged' },
  }), { ...env, APP_HOSTNAME: hostname });
  expect(response.status).toBe(200);
  const [request, options] = fetcher.mock.calls[0]!;
  expect((request as Request).url).toBe(`${env.PLATFORM_ORIGIN}/workspace`);
  expect((request as Request).headers.get('x-forwarded-host')).toBe(hostname);
  expect((request as Request).headers.get('x-matrix-edge-secret')).toBe(env.EDGE_ROUTER_SECRET);
  expect(options?.signal).toBeDefined();
});

it.each(['evil.example', '*.matrix-os.com', 'https://starter-preview.matrix-os.com', 'starter-preview.matrix-os.com:443'])('rejects an invalid configured hostname: %s', (configured) => {
  expect(classifyEdgeRoute(configured, configured)).toBe('unknown');
});

it('does not enable sibling hosts or reclassify existing platform/code hosts', () => {
  expect(classifyEdgeRoute('another-preview.matrix-os.com', hostname)).toBe('unknown');
  expect(classifyEdgeRoute('api.matrix-os.com', 'api.matrix-os.com')).toBe('platform');
  expect(classifyEdgeRoute('code.matrix-os.com', 'code.matrix-os.com')).toBe('code');
});
