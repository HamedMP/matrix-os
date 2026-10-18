import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseGatewayResult, isSdkSessionId } from './result.mjs';

const MAX_BYTES = 262_144;
const MAX_CHATS = 1000;
const CHAT = /^chat_[A-Za-z0-9_-]{1,128}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const unavailable = () => new Error('Runtime session state unavailable');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

async function safeDirectory(path) {
  if (!isAbsolute(path)) throw unavailable();
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, segment);
    if (!(await lstat(current)).isDirectory()) throw unavailable();
  }
}

function decode(raw, ownerId) {
  if (raw === null) return { version: 1, ownerId, sessions: [] };
  const state = JSON.parse(raw);
  if (!keys(state, ['version', 'ownerId', 'sessions']) || state.version !== 1 || state.ownerId !== ownerId
    || !Array.isArray(state.sessions) || state.sessions.length > MAX_CHATS) throw unavailable();
  const chats = new Set(); const sessions = new Set();
  for (const entry of state.sessions) {
    if (!keys(entry, ['chatId', 'sessionId']) || !CHAT.test(entry.chatId) || !isSdkSessionId(entry.sessionId)
      || chats.has(entry.chatId) || sessions.has(entry.sessionId.toLowerCase())) throw unavailable();
    chats.add(entry.chatId); sessions.add(entry.sessionId.toLowerCase());
  }
  return state;
}

/** Owner-local runtime identity/config only, never message content or credentials.
 * This same-UID file is not an authorization boundary against a hostile agent.
 * Production must bind restored associations to the trusted control-plane checkpoint.
 */
export function createRuntimeSessions(home, ownerId) {
  if (typeof ownerId !== 'string' || !OWNER.test(ownerId) || typeof home !== 'string' || !isAbsolute(home)) throw unavailable();
  const directory = join(resolve(home), '.matrix-runtime');
  let snapshot;
  async function location() {
    await safeDirectory(resolve(home));
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await safeDirectory(directory);
    // Pin the directory on the actual Linux container. A later parent rename or
    // symlink replacement cannot redirect reads or the atomic rename elsewhere.
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return { handle, path: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory };
  }
  async function read(path) {
    let file;
    try {
      file = await open(join(path, 'sessions.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_BYTES) throw unavailable();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw unavailable();
      return buffer.subarray(0, size).toString('utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await file?.close(); }
  }
  async function access(action) {
    let locationHandle;
    try {
      const located = await location(); locationHandle = located.handle;
      return await action(located.path, located.handle);
    } catch (error) {
      console.warn('[workspace-runtime] Session state rejected', { kind: error instanceof SyntaxError ? 'invalid_json' : 'invalid_state' });
      throw unavailable();
    }
    finally { await locationHandle?.close(); }
  }
  return {
    async get(chatId) {
      if (typeof chatId !== 'string' || !CHAT.test(chatId)) throw unavailable();
      return access(async path => {
        const raw = await read(path); const state = decode(raw, ownerId); snapshot = raw;
        return state.sessions.find(entry => entry.chatId === chatId)?.sessionId;
      });
    },
    async bind(chatId, sessionId) {
      if (typeof chatId !== 'string' || !CHAT.test(chatId) || typeof sessionId !== 'string' || !isSdkSessionId(sessionId)) throw unavailable();
      return access(async (path, directoryHandle) => {
        const raw = await read(path);
        if (snapshot !== undefined && raw !== snapshot) throw unavailable();
        const state = decode(raw, ownerId);
        const existing = state.sessions.find(entry => entry.chatId === chatId);
        if ((existing && existing.sessionId !== sessionId)
          || state.sessions.some(entry => entry.chatId !== chatId && entry.sessionId.toLowerCase() === sessionId.toLowerCase())) throw unavailable();
        if (existing) return;
        if (state.sessions.length >= MAX_CHATS) throw unavailable();
        state.sessions.push({ chatId, sessionId });
        const next = JSON.stringify(state);
        if (Buffer.byteLength(next) > MAX_BYTES) throw unavailable();
        const temporary = join(path, `sessions.${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
          if (await read(path) !== raw) throw unavailable();
          await rename(temporary, join(path, 'sessions.json'));
          await directoryHandle.sync();
          snapshot = next;
        } finally { await rm(temporary, { force: true }); }
      });
    },
  };
}

/** Trusted Queue Chat identity selects the association; extra client IDs are ignored. */
export async function runChatJob(home, job, request) {
  if (!object(job) || job.type !== 'chat' || typeof job.message !== 'string'
    || !job.message.trim() || job.message.length > 16_000) throw new Error('Invalid runtime Chat');
  const sessions = createRuntimeSessions(home, job.ownerId);
  const sessionId = await sessions.get(job.chatId);
  const response = await request('/api/message', { text: job.message, ...(sessionId ? { sessionId } : {}) });
  if (!response.body) throw new Error('Missing agent response');
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > 256_000) throw new Error('Agent result too large');
    chunks.push(chunk);
  }
  const result = parseGatewayResult(Buffer.concat(chunks).toString('utf8'), { requireSession: true, expectedSessionId: sessionId });
  await sessions.bind(job.chatId, result.sessionId);
  return result;
}
