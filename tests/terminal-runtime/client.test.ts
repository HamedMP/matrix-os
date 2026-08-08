import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createSupervisorClient } from '../../packages/terminal-runtime/src/client.js';
import { decodeFrame, encodeFrame } from '../../packages/terminal-runtime/src/framing.js';
const OPERATION_ID = 'fedcba9876543210fedcba9876543210';
const REQUEST = {
  version: 1 as const, operation: 'List' as const,
  operationId: OPERATION_ID, input: {},
};
type FakeSocket = EventEmitter & {
  setTimeout(ms: number): void;
  end(bytes: Buffer): void;
  destroy(): void;
};
function fakeSocket(options: {
  onEnd?: (socket: FakeSocket, bytes: Buffer) => void;
  timeout?: boolean;
  timeoutValues?: number[];
}): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.setTimeout = (milliseconds) => {
    options.timeoutValues?.push(milliseconds);
    if (options.timeout) queueMicrotask(() => socket.emit('timeout'));
  };
  socket.end = (bytes) => options.onEnd?.(socket, bytes);
  socket.destroy = () => undefined;
  return socket;
}
function request(socket: FakeSocket) {
  return createSupervisorClient({
    socketPath: '/run/matrix-terminal-runtime/supervisor.sock',
    timeoutMs: 1_000,
    connect: () => {
      queueMicrotask(() => socket.emit('connect'));
      return socket as unknown as Socket;
    },
  }).request(REQUEST);
}
describe('terminal runtime supervisor client', () => {
  it('exchanges exactly one bounded request and response', async () => {
    const received: unknown[] = [];
    const socket = fakeSocket({ onEnd: (peer, bytes) => {
      received.push(decodeFrame(bytes));
      queueMicrotask(() => {
        peer.emit('data', encodeFrame({
          version: 1, ok: true, operationId: OPERATION_ID, result: [],
        }));
        peer.emit('end');
      });
    } });
    await expect(request(socket)).resolves.toMatchObject({ ok: true, result: [] });
    expect(received).toEqual([REQUEST]);
  });
  it('fails closed on timeout and invalid socket configuration', async () => {
    expect(() => createSupervisorClient({ socketPath: 'relative.sock' }))
      .toThrow('invalid_socket_configuration');
    expect(() => createSupervisorClient({
      socketPath: '/run/matrix-terminal-runtime/supervisor.sock', timeoutMs: 0,
    })).toThrow('invalid_timeout_configuration');
    await expect(request(fakeSocket({ timeout: true })))
      .rejects.toThrow('supervisor_timeout');
  });
  it('allows readiness-bound operations to outlive the systemd start deadline', async () => {
    const timeoutValues: number[] = [], socket = fakeSocket({ timeoutValues, onEnd: (peer) => queueMicrotask(() => {
      peer.emit('data', encodeFrame({
        version: 1, ok: true, operationId: OPERATION_ID,
        result: { runtimeId: '0123456789abcdef0123456789abcdef', lifecycleState: 'starting' },
      }));
      peer.emit('end');
    }) });
    await createSupervisorClient({ connect: () => {
      queueMicrotask(() => socket.emit('connect'));
      return socket as unknown as Socket;
    } }).request({
      version: 1, operation: 'CreateStart', operationId: OPERATION_ID,
      input: { displayName: 'accept-runtime', cwd: { kind: 'home-relative', path: '' }, launch: { kind: 'shell' } },
    });
    expect(timeoutValues).toEqual([40_000]);
  });
  it('rejects incomplete and pathologically fragmented responses', async () => {
    await expect(request(fakeSocket({ onEnd: (peer) => {
      queueMicrotask(() => peer.emit('close'));
    } }))).rejects.toThrow('supervisor_unavailable');
    await expect(request(fakeSocket({ onEnd: (peer) => {
      queueMicrotask(() => {
        for (let index = 0; index < 1_025; index += 1) peer.emit('data', Buffer.alloc(0));
      });
    } }))).rejects.toThrow('frame_too_fragmented');
  });
});
