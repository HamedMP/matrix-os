import { Hono } from 'hono';
import type { UpgradeWebSocket, WSEvents, WSContext } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import { registerTerminalReadinessRoute } from '../../packages/gateway/src/terminal-readiness-route.js';

function fakeUpgrade(captured: { events?: WSEvents }): UpgradeWebSocket {
  return ((createEvents: (c: never) => WSEvents | Promise<WSEvents>) => async (c: never) => {
    captured.events = await createEvents(c);
    return new Response(null, { status: 200 });
  }) as UpgradeWebSocket;
}

describe('terminal readiness websocket', () => {
  it('confirms the websocket route without creating a terminal session', async () => {
    const app = new Hono();
    const captured: { events?: WSEvents } = {};
    registerTerminalReadinessRoute(app, fakeUpgrade(captured));

    await app.request('/ws/terminal/readiness');
    const sent: string[] = [];
    const close = vi.fn();
    captured.events?.onOpen?.(new Event('open'), {
      send: (message: string) => sent.push(message),
      close,
    } as unknown as WSContext);

    expect(sent).toEqual([JSON.stringify({ type: 'ready', terminalWebSocket: 'ok' })]);
    expect(close).toHaveBeenCalledWith(1000, 'ready');
  });
});
