import { constants, fstat } from 'node:fs';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Grant } from './contracts.mjs';
import { createX11Backend } from './backend.mjs';
import { createQualificationSession } from './session.mjs';
import { createQualificationMcpServer, createQualificationStdioTransport, stopOnTransportLoss } from './mcp.mjs';

async function start() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.env.MATRIX_COMPUTER_QUALIFICATION !== 'synthetic-only') throw new Error('qualification_unavailable');
  const path = process.env.MATRIX_COMPUTER_QUALIFICATION_GRANT_FILE;
  if (!path || !isAbsolute(path)) throw new Error('qualification_unavailable');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let grant;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('qualification_unavailable');
    const bytes = Buffer.alloc(4097); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('qualification_unavailable');
    grant = Grant.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await file.close(); }
  if (process.env.MATRIX_HANDLE !== grant.targetId || process.env.MATRIX_RUNTIME_SLOT !== grant.targetId || process.env.MATRIX_CLERK_USER_ID !== grant.ownerId) throw new Error('qualification_unavailable');
  // FD 3 is a trusted operator-owned pipe, never the model's MCP stdin.
  if (!(await promisify(fstat)(3)).isFIFO()) throw new Error('qualification_unavailable');
  const controls = createReadStream('', { fd: 3, autoClose: true, highWaterMark: 128 });
  let buffer = '', stopped = false;
  const session = createQualificationSession({ grant, backend: createX11Backend() });
  const server = createQualificationMcpServer(session);
  const shutdown = async () => {
    if (stopped) return; stopped = true; controls.destroy();
    try { await session.stop(); } finally { await server.close(); }
  };
  controls.on('data', bytes => {
    buffer += bytes.toString('utf8');
    if (buffer.length > 128) { void shutdown().catch(fail); return; }
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const message = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (message === 'presence') {
        try { session.presence(); } catch (error) { console.warn('[computer-qualification] presence_refused', error instanceof Error ? error.name : 'UnknownError'); void shutdown().catch(fail); }
      } else { void shutdown().catch(fail); return; }
    }
  });
  controls.on('error', error => { console.warn('[computer-qualification] control_closed', error instanceof Error ? error.name : 'UnknownError'); void shutdown().catch(fail); });
  controls.on('end', () => { void shutdown().catch(fail); });
  process.once('SIGTERM', () => { void shutdown().catch(fail); });
  process.once('SIGINT', () => { void shutdown().catch(fail); });
  process.stdin.once('end', () => { void shutdown().catch(fail); });
  await server.connect(stopOnTransportLoss(createQualificationStdioTransport(), shutdown, fail));
}
function fail(error) {
  console.error('[computer-qualification] unavailable', error instanceof Error ? error.name : 'UnknownError'); process.exitCode = 1;
}
await start().catch(fail);
