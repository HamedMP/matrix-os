import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseDevstackSourceDelta } from '../../packages/platform/src/devstack-source-delta.ts';
import { createStage3DeltaStage } from './stage3-delta-stage.mjs';
import { createStage3SourceSync } from './stage3-source.mjs';
import { bindingKeys, privateSocketDirectory, publisherError, readPublisherFrames, sendPublisherFrame } from './publisher-channel.mjs';

/** Sole writer. No uploaded module is imported or executed in this process. */
export function createStage3Publisher({ enrollment: input, stateDir, testRevision }) {
  // Enrollment comes from a private operator-owned file, never the request.
  const enrollment = structuredClone(input);
  if (!enrollment || bindingKeys.some(key => typeof enrollment[key] !== 'string')
    || enrollment.handle !== enrollment.target?.handle || enrollment.containerId !== enrollment.target?.containerId
    || !/^[a-f0-9]{64}$/.test(enrollment.sourceIdentity) || typeof testRevision !== 'function') throw publisherError();
  const stage = createStage3DeltaStage({ sourceRoot: enrollment.source.root, sourceIdentity: enrollment.source.identity,
    base: enrollment.base, stateDir: join(stateDir, 'staging') });
  const receiver = createStage3SourceSync({ stateDir: join(stateDir, 'projection'), bindings: [enrollment],
    authenticate: async assertion => { await assertion(); return enrollment.owner; },
    readBinding: async () => ({ generation: enrollment.generation,
      source: { owner: enrollment.owner, ...enrollment.source }, target: { owner: enrollment.owner, ...enrollment.target } }),
    testRevision,
  });
  let busy = false;
  return {
    async apply(binding, delta, assertCurrent, signal) {
      if (busy || !binding || !parseDevstackSourceDelta(delta) || Object.keys(binding).length !== bindingKeys.length
        || bindingKeys.some(key => binding[key] !== enrollment[key]) || Date.now() >= enrollment.expiresAt) throw publisherError();
      busy = true;
      const verify = async () => { signal?.throwIfAborted(); await assertCurrent(); signal?.throwIfAborted(); };
      try {
        await verify();
        return await stage(delta, () => receiver.syncAndTest(verify, {
          runtime: enrollment.runtime, worktree: enrollment.worktree, generation: enrollment.generation,
        }, { signal }), { beforeWrite: verify });
      } finally { busy = false; }
    },
  };
}

/** Private local IPC: only the trusted ingress can open this owner-only socket.
 * Verification challenges retain the ingress's live Clerk/registry checks at
 * staging, publication and result boundaries without forwarding credentials.
 */
export async function listenStage3Publisher({ socketPath, publisher }) {
  await privateSocketDirectory(socketPath);
  // Node refuses an existing socket. Never unlink an uncertain prior listener.
  const sockets = new Set(); // <= 4; removed on close, deadline, and shutdown.
  const jobs = new Set(); // <= 4; drained before returning from close.
  const server = createServer(socket => {
    if (sockets.size >= 4) return socket.destroy();
    sockets.add(socket);
    const controller = new AbortController();
    const deadline = setTimeout(() => socket.destroy(), 120_000);
    let started = false;
    let checking;
    let sequence = 0;
    socket.on('error', error => { console.error('[devstack-publisher] transport failed', error.name); });
    socket.on('close', () => {
      clearTimeout(deadline);
      sockets.delete(socket);
      controller.abort();
      checking?.reject(publisherError());
    });
    const assertCurrent = () => new Promise((resolve, reject) => {
      if (checking || sequence >= 16 || socket.destroyed) return reject(publisherError());
      const id = ++sequence;
      const timer = setTimeout(() => socket.destroy(), 10_000);
      checking = { id, resolve: () => { clearTimeout(timer); checking = undefined; resolve(); },
        reject: error => { clearTimeout(timer); checking = undefined; reject(error); } };
      sendPublisherFrame(socket, { type: 'verify', id });
    });
    readPublisherFrames(socket, 4 * 1024 ** 2 + 4096, message => {
      if (message?.type === 'verified' && Object.keys(message).length === 2 && checking?.id === message.id) {
        checking.resolve();
        return;
      }
      if (started || message?.type !== 'apply' || Object.keys(message).length !== 3) throw publisherError();
      started = true;
      const job = publisher.apply(message.binding, message.delta, assertCurrent, controller.signal).then(receipt => {
        sendPublisherFrame(socket, { type: 'result', receipt });
        socket.end();
      }).catch(error => {
        console.error('[devstack-publisher] publication failed', error instanceof Error ? error.name : 'Unknown');
        if (!socket.destroyed) { sendPublisherFrame(socket, { type: 'error' }); socket.end(); }
      }).finally(() => jobs.delete(job));
      jobs.add(job);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const created = await lstat(socketPath);
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...jobs]);
      // Some Node versions unlink automatically; never remove a replacement.
      try {
        const current = await lstat(socketPath);
        if (current.isSocket() && current.dev === created.dev && current.ino === created.ino) await unlink(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
