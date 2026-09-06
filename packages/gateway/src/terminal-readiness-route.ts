import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

const TERMINAL_READINESS_FRAME = JSON.stringify({
  type: 'ready',
  terminalWebSocket: 'ok',
});

export function registerTerminalReadinessRoute<TRawSocket>(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket<TRawSocket>,
): void {
  app.get('/ws/terminal/readiness', upgradeWebSocket(() => ({
    onOpen(_event, socket) {
      try {
        socket.send(TERMINAL_READINESS_FRAME);
        socket.close(1000, 'ready');
      } catch (err: unknown) {
        console.warn(
          '[gateway] terminal readiness WebSocket send failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  })));
}
