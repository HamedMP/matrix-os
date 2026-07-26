import { createConnection, type Socket } from 'node:net';
import {
  ProtocolRequestSchema,
  ProtocolResponseSchema,
  type ProtocolRequest,
  type ProtocolResponse,
} from './contracts.js';
import { decodeFrame, encodeFrame, MAX_FRAME_BYTES } from './framing.js';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FRAME_CHUNKS = 1_024;
export type SupervisorClient = {
  request(request: ProtocolRequest): Promise<ProtocolResponse>;
};
export function createSupervisorClient(options: {
  socketPath?: string;
  timeoutMs?: number;
  connect?: (path: string) => Socket;
} = {}): SupervisorClient {
  const socketPath = options.socketPath ?? '/run/matrix-terminal-runtime/supervisor.sock';
  if (!socketPath.startsWith('/') || socketPath.length > 107) {
    throw new Error('invalid_socket_configuration');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('invalid_timeout_configuration');
  }
  const connect = options.connect ?? ((path: string) => createConnection(path));
  return {
    async request(request: ProtocolRequest): Promise<ProtocolResponse> {
      const parsedRequest = ProtocolRequestSchema.parse(request);
      const outbound = encodeFrame(parsedRequest);
      return await new Promise<ProtocolResponse>((resolve, reject) => {
        const socket = connect(socketPath);
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = (
          error: Error | null,
          response?: ProtocolResponse,
        ): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error);
          else if (response) resolve(response);
          else reject(new Error('supervisor_unavailable'));
        };
        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => finish(new Error('supervisor_timeout')));
        socket.once('error', (error: Error) => {
          finish(new Error('supervisor_unavailable', { cause: error }));
        });
        socket.once('close', () => {
          finish(new Error('supervisor_unavailable'));
        });
        socket.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > MAX_FRAME_BYTES + 4) {
            finish(new Error('frame_too_large'));
            return;
          }
          if (chunks.length >= MAX_FRAME_CHUNKS) {
            finish(new Error('frame_too_fragmented'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        socket.once('end', () => {
          try {
            const response = ProtocolResponseSchema.parse(
              decodeFrame(Buffer.concat(chunks, total)),
            );
            finish(null, response);
          } catch (error: unknown) {
            finish(
              error instanceof Error
                ? error
                : new Error('supervisor_invalid_response'),
            );
          }
        });
        socket.once('connect', () => {
          socket.end(outbound);
        });
      });
    },
  };
}
