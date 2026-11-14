// Synthetic fixture only. This is neither the Matrix gateway nor a sandbox.
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';

const owner = process.env.SPIKE_OWNER;
const generation = process.env.SPIKE_GENERATION;
const token = process.env.SPIKE_TOKEN;
if (!owner || !generation || !token) throw new Error('missing synthetic identity');
const statePath = '/workspace/state.json';
const server = createServer(async (request, response) => {
  const auth = Buffer.from(String(request.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${token}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
    response.writeHead(401).end();
    return;
  }
  try {
    if (request.method === 'GET' && request.url === '/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ owner, generation, rssBytes: process.memoryUsage().rss }));
    } else if (request.method === 'GET' && request.url === '/state') {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.owner !== owner) throw new Error('owner mismatch');
      const payload = await readFile('/workspace/fixture.bin');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...state, generation, fileHash: createHash('sha256').update(payload).digest('hex') }));
    } else if (request.method === 'POST' && request.url === '/mutate') {
      if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) {
        response.writeHead(413).end();
        return;
      }
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.owner !== owner) throw new Error('owner mismatch');
      state.revision += 1;
      await writeFile(`${statePath}.tmp`, JSON.stringify(state));
      await rename(`${statePath}.tmp`, statePath);
      response.end('{}');
    } else response.writeHead(404).end();
  } catch (error) {
    console.error(error);
    response.writeHead(500).end('fixture operation failed');
  }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.maxConnections = 16;
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
});
