import { describe, expect, it, vi } from 'vitest';
import type { Agent } from 'undici';
import { probeCustomerVpsStartupReadiness } from '../../packages/platform/src/customer-vps-startup-readiness.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('customer VPS startup readiness', () => {
  it('requires health, the expected release, and the terminal websocket path', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      if (url.endsWith('/api/system/info')) {
        return jsonResponse({ release: { version: 'v-ready' } });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const probeTerminalWebSocket = vi.fn().mockResolvedValue(true);

    await expect(probeCustomerVpsStartupReadiness({
      machineId: '00000000-0000-4000-8000-000000000001',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      expectedVersion: 'v-ready',
      platformSecret: 'platform-secret',
    }, {
      dispatcher: {} as Agent,
      fetch: fetchImpl as typeof fetch,
      probeTerminalWebSocket,
    })).resolves.toEqual({ ready: true, failing: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(probeTerminalWebSocket).toHaveBeenCalledWith(expect.objectContaining({
      url: 'wss://203.0.113.10:443/ws/terminal/readiness',
      timeoutMs: expect.any(Number),
    }));
  });

  it('reports only coarse failing checks and rejects a mismatched release', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse({ release: { version: 'v-stale' } });
    });

    await expect(probeCustomerVpsStartupReadiness({
      machineId: '00000000-0000-4000-8000-000000000001',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      expectedVersion: 'v-ready',
      platformSecret: 'platform-secret',
    }, {
      dispatcher: {} as Agent,
      fetch: fetchImpl as typeof fetch,
      probeTerminalWebSocket: vi.fn().mockResolvedValue(false),
    })).resolves.toEqual({
      ready: false,
      failing: ['system_info', 'terminal_websocket'],
    });
  });
});
