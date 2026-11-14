import { lstat, realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod/v4';
import type { DevstackCliBinding } from './devstack-cli-pairing.js';
import type { DevstackSourceDelta } from './devstack-source-delta.js';

const fingerprint = z.string().length(64).regex(/^[a-f0-9]+$/);
export const devstackSourceReceiptSchema = z.strictObject({
  revision: fingerprint,
  files: z.number().int().min(0).max(50_000), updated: z.number().int().min(0).max(50_000), removed: z.number().int().min(0).max(50_000),
  test: z.strictObject({ revision: fingerprint, exitCode: z.number().int().min(0).max(255),
    log: z.string().min(1).max(4096).refine(value => !/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(value)) }),
}).refine(value => value.revision === value.test.revision);
const unavailable = () => new Error('DevStack publisher unavailable.');

export function createDevstackPublisherClient({ socketPath, identity }: { socketPath: string; identity: string }) {
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100
    || !fingerprint.safeParse(identity).success) throw unavailable();
  return {
    identity,
    async apply(binding: DevstackCliBinding, delta: DevstackSourceDelta, assertCurrent: () => Promise<void>) {
      const parent = dirname(socketPath);
      const [directory, socketStat] = await Promise.all([lstat(parent), lstat(socketPath)]);
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)
        || await realpath(parent) !== parent || !socketStat.isSocket() || socketStat.uid !== process.getuid?.()
        || (socketStat.mode & 0o077)) throw unavailable();
      await assertCurrent();
      return new Promise<z.infer<typeof devstackSourceReceiptSchema>>((resolveReceipt, reject) => {
        const socket = connect(socketPath);
        const timer = setTimeout(() => socket.destroy(unavailable()), 120_000);
        let buffer = Buffer.alloc(0);
        let pending = false;
        let sequence = 0;
        let complete = false;
        socket.once('connect', () => {
          // Never send Clerk cookies, a bearer, paths or a command to the writer.
          const { owner, runtime, worktree, handle, containerId, sourceIdentity } = binding;
          socket.write(JSON.stringify({ type: 'apply', binding: { owner, runtime, worktree, handle, containerId, sourceIdentity }, delta }) + '\n');
        });
        socket.on('data', chunk => {
          buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
          if (buffer.length > 32 * 1024) return socket.destroy(unavailable());
          for (;;) {
            const end = buffer.indexOf(10);
            if (end < 0) break;
            const line = buffer.subarray(0, end);
            buffer = buffer.subarray(end + 1);
            let message;
            try { message = JSON.parse(line.toString('utf8')); }
            catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; return socket.destroy(unavailable()); }
            if (complete || pending) return socket.destroy(unavailable());
            if (message?.type === 'verify' && Object.keys(message).length === 2 && message.id === sequence + 1 && sequence < 16) {
              sequence++;
              pending = true;
              void assertCurrent().then(() => {
                pending = false;
                if (!socket.destroyed) socket.write(JSON.stringify({ type: 'verified', id: message.id }) + '\n');
              }).catch((error: unknown) => {
                console.error('[platform] DevStack publication authority check failed', error instanceof Error ? error.name : 'Unknown');
                // Preserve the local typed stale-binding error for the route's
                // 409 mapper. No error details are sent to the publisher.
                reject(error instanceof Error ? error : unavailable());
                socket.destroy();
              });
            } else if (message?.type === 'result' && Object.keys(message).length === 2) {
              const result = devstackSourceReceiptSchema.safeParse(message.receipt);
              if (!result.success) return socket.destroy(unavailable());
              complete = true;
              // resolve only after a final live authority check.
              void assertCurrent().then(() => resolveReceipt(result.data), reject).finally(() => socket.destroy());
            } else return socket.destroy(unavailable());
          }
        });
        socket.once('error', () => reject(unavailable()));
        socket.once('close', () => { clearTimeout(timer); if (!complete) reject(unavailable()); });
      });
    },
  };
}
