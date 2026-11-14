import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const bindingKeys = ['owner', 'runtime', 'worktree', 'handle', 'containerId', 'sourceIdentity'];
export const publisherError = () => new Error('DevStack publisher unavailable.');

export async function privateSocketDirectory(socketPath) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath
    || Buffer.byteLength(socketPath) > 100) throw publisherError();
  const parent = dirname(socketPath);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || await realpath(parent) !== parent) throw publisherError();
}

/** Bounded JSON lines. Never accumulate an unbounded partial frame or queue. */
export function readPublisherFrames(socket, maximum, consume) {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end > maximum) return socket.destroy(publisherError());
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try { consume(JSON.parse(line.toString('utf8'))); }
      catch (error) { socket.destroy(error instanceof Error ? error : publisherError()); return; }
      if (socket.destroyed) return;
    }
    if (pending.length > maximum) socket.destroy(publisherError());
  });
}

export function sendPublisherFrame(socket, message) {
  if (socket.destroyed || !socket.writable) throw publisherError();
  socket.write(JSON.stringify(message) + '\n');
}
