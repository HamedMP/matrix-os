import type { Duplex } from 'node:stream';
import { describeError } from './platform-route-utils.js';

const UPGRADE_REJECTION_STATUS_TEXT = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
} as const;
export type WebSocketUpgradeRejectionStatus = keyof typeof UPGRADE_REJECTION_STATUS_TEXT;

/** Sockets whose refusal response is in flight; weakly held, so it needs no cap or sweep. */
const rejecting = new WeakSet<Duplex>();

/**
 * Refuses an upgrade with a bodyless HTTP status, then closes once the response has flushed.
 * Cloud Run treats an upgrade whose connection closes without any response as an instance
 * failure and stops routing new requests to that instance, so a bare `destroy()` -- or a
 * `destroy()` that discards the response before it is written -- lets any client take a
 * platform instance out of service. Use it for every refusal made before an upstream has
 * answered. A second refusal of the same socket is ignored, so it cannot cut the first short.
 */
export function rejectWebSocketUpgrade(socket: Duplex, status: WebSocketUpgradeRejectionStatus): void {
  if (socket.destroyed || rejecting.has(socket)) return;
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  rejecting.add(socket);
  socket.once('error', (err: unknown) => {
    console.warn('[platform] websocket upgrade rejection write failed:', describeError(err));
    socket.destroy();
  });
  socket.end(
    `HTTP/1.1 ${status} ${UPGRADE_REJECTION_STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/** True while a refusal response is being flushed; callers must not destroy the socket then. */
export function isRejectingWebSocketUpgrade(socket: Duplex): boolean {
  return rejecting.has(socket);
}
