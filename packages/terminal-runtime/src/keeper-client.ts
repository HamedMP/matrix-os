import { createConnection, type Socket } from 'node:net';
import { z } from 'zod/v4';
import {
  DescriptorSchema,
  RuntimeIdSchema,
  type Descriptor,
} from './contracts.js';
import {
  decodeFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
} from './framing.js';

const KeeperResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), descriptor: DescriptorSchema }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.literal('claim_failed'),
  }).strict(),
]);

export async function claimKeeperDescriptor(options: {
  runtimeId: string;
  socketPath?: string;
  timeoutMs?: number;
  connect?: (path: string) => Socket;
}): Promise<Descriptor> {
  const runtimeId = RuntimeIdSchema.parse(options.runtimeId);
  const socketPath = options.socketPath ??
    '/run/matrix-terminal-runtime/keeper.sock';
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!socketPath.startsWith('/') || socketPath.length > 107) {
    throw new Error('keeper_socket_invalid');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('keeper_timeout_invalid');
  }
  const connect = options.connect ?? ((path: string) => createConnection(path));
  return await new Promise<Descriptor>((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: Error | null, descriptor?: Descriptor): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else if (descriptor) resolve(descriptor);
      else reject(new Error('keeper_claim_failed'));
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(new Error('keeper_claim_timeout')));
    socket.once('error', (error: Error) =>
      finish(new Error('keeper_claim_failed', { cause: error })));
    socket.once('close', () => finish(new Error('keeper_claim_failed')));
    socket.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_FRAME_BYTES + 4 || chunks.length >= 1_024) {
        finish(new Error('keeper_claim_invalid'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('end', () => {
      try {
        const response = KeeperResponseSchema.parse(
          decodeFrame(Buffer.concat(chunks, total)),
        );
        if (!response.ok) throw new Error('keeper_claim_failed');
        finish(null, response.descriptor);
      } catch (error: unknown) {
        finish(error instanceof Error ? error : new Error('keeper_claim_invalid'));
      }
    });
    socket.once('connect', () => {
      socket.end(encodeFrame({ version: 1, runtimeId }));
    });
  });
}
