import { randomBytes, randomUUID } from 'node:crypto';
import { link, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { initDevStackRegistry, readPrivateDevStackFile, redact, withDevStackRegistryLock } from './local.mjs';

const slug = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const runKey = /^[a-f0-9]{64}$/;
const maxRequestBytes = 16 * 1024;
const maxCommandBytes = 12 * 1024;
const maxRecordBytes = 20 * 1024;
const maxResponseBytes = 256 * 1024;
const maxRetained = 100;
const maxCursor = 512;
const maxLogPage = 8;
const retryWindowMs = 5 * 60_000;
const requestTimeoutMs = 10_000;
const statuses = new Set(['running', 'succeeded', 'failed', 'timed_out', 'interrupted', 'binding_rejected']);

function parseOrigin(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Set DEVSTACK_API_URL to the DevStack Platform origin'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error('DEVSTACK_API_URL must be an HTTPS origin or the isolated 127.0.0.1 HTTP origin');
  }
  return url.origin;
}

function validRunId(value) {
  return typeof value === 'string' && uuid.test(value) && value.length === 36;
}

function serializeSubmission(body) {
  if (!validRunId(body?.runId)
    || typeof body.runtime !== 'string' || !slug.test(body.runtime) || /\s/.test(body.runtime)
    || typeof body.worktree !== 'string' || !slug.test(body.worktree) || /\s/.test(body.worktree)
    || !['exec', 'test'].includes(body.kind)
    || !Array.isArray(body.command) || body.command.length < 1 || body.command.length > 57
    || body.command.some(arg => typeof arg !== 'string' || !arg.length || arg.length > 4096 || arg.includes('\0'))
    || body.command[0].startsWith('-')) {
    throw new Error('Provide a runtime, worktree and exec or test command with valid arguments');
  }
  const request = JSON.stringify({
    runId: body.runId, runtime: body.runtime, worktree: body.worktree, kind: body.kind, command: body.command,
  });
  if (Buffer.byteLength(JSON.stringify(body.command)) > maxCommandBytes || Buffer.byteLength(request) > maxRequestBytes) {
    throw new Error('DevStack command exceeds the request limit');
  }
  return request;
}

async function saveRecovery(directory, record) {
  const path = join(directory, `${record.body.runId}.json`);
  await withDevStackRegistryLock(directory, async () => {
    const files = await readdir(directory);
    if (files.filter(name => name.endsWith('.json')).length >= maxRetained) {
      throw new Error('DevStack recovery storage is full; archive finished run records before submitting');
    }
    const temp = `${path}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      // The final name is exclusive and only appears after the full record is written.
      await link(temp, path);
    } finally {
      await handle.close();
      await unlink(temp);
    }
  });
}

async function responseJson(response) {
  const contentType = response.headers.get('content-type') ?? '';
  const declaredSize = Number(response.headers.get('content-length'));
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(contentType) || declaredSize > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error('Invalid DevStack response');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error('DevStack response exceeds the byte limit');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function isExitCode(value) {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 255);
}

function previewLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid DevStack preview');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^\/vm\/[a-z0-9][a-z0-9-]{0,62}\/$/.test(url.pathname)
    || value !== url.origin + url.pathname) throw new Error('Invalid DevStack preview');
  return url.href;
}

function runResult(value, { body, key }, cursor, token) {
  if (!value || value.runId !== body.runId || value.runtime !== body.runtime || value.worktree !== body.worktree
    || !statuses.has(value.status) || typeof value.revision !== 'string' || !/^[a-f0-9]{40}$/.test(value.revision) || value.revision.length !== 40
    || !isExitCode(value.exitCode) || !Array.isArray(value.logs) || value.logs.length > maxLogPage
    || value.nextCursor !== cursor + value.logs.length || value.nextCursor > maxCursor
    || typeof value.hasMore !== 'boolean' || (value.hasMore && value.nextCursor === cursor)
    || typeof value.truncated !== 'boolean') throw new Error('Invalid DevStack result');
  let testResult = null;
  if (value.testResult !== null) {
    if (body.kind !== 'test' || !['passed', 'failed', 'timed_out'].includes(value.testResult?.status)
      || value.testResult.exitCode !== value.exitCode) throw new Error('Invalid DevStack test result');
    testResult = { status: value.testResult.status, exitCode: value.testResult.exitCode };
  }
  const logs = value.logs.map(log => {
    if (!['stdout', 'stderr'].includes(log?.stream) || typeof log.text !== 'string') throw new Error('Invalid DevStack log');
    return { stream: log.stream, text: redact(log.text.replaceAll(key, '[redacted]').replaceAll(token, '[redacted]')) };
  });
  return {
    runId: value.runId, status: value.status, runtime: value.runtime, worktree: value.worktree,
    revision: value.revision, previewUrl: previewLink(value.previewUrl), exitCode: value.exitCode,
    testResult, logs, nextCursor: value.nextCursor, hasMore: value.hasMore, truncated: value.truncated,
  };
}

export class DevStackRequestError extends Error {
  constructor(message, runId) {
    super(message);
    this.runId = runId;
  }
}

export function createRunClient(env = process.env) {
  const origin = parseOrigin(env.DEVSTACK_API_URL);
  const token = env.DEVSTACK_CLERK_TOKEN;
  if (typeof token !== 'string' || token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || /\s/.test(token)) {
    throw new Error('Set DEVSTACK_CLERK_TOKEN to a fresh Clerk session bearer');
  }
  const registry = env.DEVSTACK_STATE_DIR ?? join(homedir(), '.matrixos', 'devstack');
  if (!isAbsolute(registry)) throw new Error('Registry path must be absolute');
  const directory = join(resolve(registry), 'runs');

  async function send(record, method, cursor = 0) {
    const id = record.body.runId;
    const endpoint = '/api/devstack/runs' + (method === 'GET' ? `/${id}?cursor=${cursor}` : '');
    let response;
    try {
      response = await fetch(origin + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(requestTimeoutMs),
        headers: {
          authorization: `Bearer ${token}`, 'x-devstack-run-key': record.key, accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: serializeSubmission(record.body) } : {}),
      });
    } catch {
      throw new DevStackRequestError('DevStack request interrupted. Reuse the saved runId', id);
    }
    if (response.status !== (method === 'GET' ? 200 : 202)) {
      try { await response.body?.cancel(); }
      finally { throw new DevStackRequestError(`DevStack Platform returned HTTP ${response.status}`, id); }
    }
    try { return runResult(await responseJson(response), record, cursor, token); }
    catch { throw new DevStackRequestError('DevStack returned an invalid or incomplete result. Reuse the saved runId', id); }
  }

  async function recovery(id) {
    if (!validRunId(id)) throw new Error('Invalid DevStack runId');
    await initDevStackRegistry(registry);
    await initDevStackRegistry(directory);
    const record = await readPrivateDevStackFile(join(directory, `${id}.json`), maxRecordBytes);
    if (record?.version !== 1 || record.body?.runId !== id || !Number.isSafeInteger(record.createdAt)
      || record.createdAt <= 0 || typeof record.key !== 'string'
      || record.key.length !== 64 || !runKey.test(record.key)) throw new Error('Invalid DevStack recovery record');
    if (record.origin !== origin) throw new Error('DevStack recovery record belongs to another Platform origin');
    serializeSubmission(record.body);
    return record;
  }

  return {
    async dispatch(runtime, worktree, kind, command) {
      const body = { runId: randomUUID(), runtime, worktree, kind, command };
      serializeSubmission(body);
      const record = { version: 1, origin, createdAt: Date.now(), key: randomBytes(32).toString('hex'), body };
      await initDevStackRegistry(registry);
      await saveRecovery(directory, record);
      return send(record, 'POST');
    },
    async result(id, cursor = '0') {
      if (typeof cursor !== 'string' || !/^(?:0|[1-9][0-9]{0,2})$/.test(cursor) || /\s/.test(cursor)
        || Number(cursor) > maxCursor) throw new Error('Invalid DevStack log cursor');
      return send(await recovery(id), 'GET', Number(cursor));
    },
    async retry(id) {
      const record = await recovery(id);
      const age = Date.now() - record.createdAt;
      if (age < 0 || age >= retryWindowMs) throw new Error('DevStack retry window closed. Use result with the saved runId');
      return send(record, 'POST');
    },
  };
}
