#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const API_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 300_000;
const MAX_JSON_BYTES = 64 * 1024;
const SINGLE_PUT_LIMIT = 64 * 1024 * 1024;
const MIN_PART_SIZE = 64 * 1024 * 1024;
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_PARTS = 10_000;
const MAX_OBJECT_SIZE = 5 * 1024 * 1024 * 1024 * 1024;
const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SAFE_SLOT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{4}Z\.dump$/;

function fail(message) {
  throw new Error(message);
}

function logCleanupFailure(operation) {
  console.error(`matrix-r2-broker: ${operation} cleanup failed`);
}

function storageAccess(key) {
  if (key === 'system/vps-meta.json') return 'read';
  if (key === 'system/db/latest') return 'write';
  const primary = /^system\/db\/snapshots\/([^/]+)$/.exec(key);
  if (primary) return SNAPSHOT_NAME.test(primary[1]) ? 'write' : null;
  const latest = /^system\/runtime-slots\/([^/]+)\/db\/latest$/.exec(key);
  if (latest) return SAFE_SLOT.test(latest[1]) ? 'write' : null;
  const snapshot = /^system\/runtime-slots\/([^/]+)\/db\/snapshots\/([^/]+)$/.exec(key);
  if (snapshot) {
    return SAFE_SLOT.test(snapshot[1]) && SNAPSHOT_NAME.test(snapshot[2]) ? 'write' : null;
  }
  return null;
}

function config() {
  const handle = process.env.MATRIX_HANDLE ?? '';
  const token = process.env.UPGRADE_TOKEN ?? '';
  const rawBase = process.env.PLATFORM_INTERNAL_URL ?? '';
  if (!SAFE_HANDLE.test(handle) || token.length < 16 || token.length > 4096 || rawBase.length > 2048) {
    fail('broker configuration invalid');
  }
  let base;
  try {
    base = new URL(rawBase);
  } catch {
    fail('broker configuration invalid');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    fail('broker configuration invalid');
  }
  return {
    token,
    route: `${base.toString().replace(/\/$/, '')}/internal/containers/${encodeURIComponent(handle)}/sync/system`,
  };
}

async function readJsonLimited(response) {
  if (!response.body) fail('broker response invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) fail('broker response too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail('broker response invalid');
  }
}

async function brokerRequest(path, payload) {
  const { route, token } = config();
  const response = await fetch(`${route}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) fail('broker request failed');
  return readJsonLimited(response);
}

function presignedUrl(value) {
  if (!value || typeof value.url !== 'string' || value.url.length > 8192) {
    fail('broker response invalid');
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    fail('broker response invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password) fail('broker response invalid');
  return url;
}

async function regularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_OBJECT_SIZE) {
    fail('source file invalid');
  }
  return metadata;
}

async function putStream(url, path, start, size) {
  const request = {
    method: 'PUT',
    headers: { 'content-length': String(size) },
    body: size === 0 ? new Uint8Array() : createReadStream(path, { start, end: start + size - 1 }),
    redirect: 'error',
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  };
  if (size > 0) request.duplex = 'half';
  const response = await fetch(url, request);
  if (!response.ok) fail('storage upload failed');
  return response.headers.get('etag');
}

async function singlePut(path, key, size) {
  const result = await brokerRequest('/presign/put', { key, size });
  await putStream(presignedUrl(result), path, 0, size);
}

function multipartPartSize(size) {
  const required = Math.ceil(size / MAX_PARTS);
  const rounded = Math.ceil(required / (1024 * 1024)) * 1024 * 1024;
  const partSize = Math.max(MIN_PART_SIZE, rounded);
  if (partSize > MAX_PART_SIZE) fail('source file too large');
  return partSize;
}

async function multipartPut(path, key, size) {
  const created = await brokerRequest('/multipart/create', { key });
  const uploadId = created?.uploadId;
  if (typeof uploadId !== 'string' || uploadId.length < 1 || uploadId.length > 512) {
    fail('broker response invalid');
  }
  const parts = [];
  try {
    const partSize = multipartPartSize(size);
    for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber += 1) {
      const length = Math.min(partSize, size - start);
      const signed = await brokerRequest('/multipart/part', { key, uploadId, partNumber });
      const etag = await putStream(presignedUrl(signed), path, start, length);
      if (!etag || etag.length > 512) fail('storage upload response invalid');
      parts.push({ partNumber, etag });
    }
    await brokerRequest('/multipart/complete', { key, uploadId, parts });
  } catch (error) {
    try {
      await brokerRequest('/multipart/abort', { key, uploadId });
    } catch {
      // The original upload failure remains authoritative; abandoned uploads
      // are covered by the bucket's multipart lifecycle policy.
      logCleanupFailure('multipart abort');
    }
    throw error;
  }
}

async function put(path, key) {
  if (storageAccess(key) !== 'write') fail('storage key invalid');
  const metadata = await regularFile(path);
  if (metadata.size <= SINGLE_PUT_LIMIT) {
    await singlePut(path, key, metadata.size);
  } else {
    await multipartPut(path, key, metadata.size);
  }
}

async function get(key, destination) {
  if (storageAccess(key) === null) fail('storage key invalid');
  const signed = await brokerRequest('/presign/get', { key });
  const response = await fetch(presignedUrl(signed), {
    redirect: 'error',
    signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) fail('storage download failed');

  const temp = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    const output = handle.createWriteStream({ autoClose: false });
    await pipeline(Readable.fromWeb(response.body), output);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, destination);
  } catch (error) {
    await handle?.close().catch(() => {
      logCleanupFailure('download handle close');
    });
    await rm(temp, { force: true }).catch(() => {
      logCleanupFailure('temporary download removal');
    });
    throw error;
  }
}

async function exists(key) {
  if (storageAccess(key) === null) fail('storage key invalid');
  const result = await brokerRequest('/exists', { key });
  if (typeof result?.exists !== 'boolean') fail('broker response invalid');
  return result.exists;
}

async function main(args) {
  switch (args[0]) {
    case 'probe':
      if (args.length !== 1) fail('usage');
      await brokerRequest('/presign/get', { key: 'system/vps-meta.json' });
      return 0;
    case 'exists':
      if (args.length !== 2) fail('usage');
      return (await exists(args[1])) ? 0 : 44;
    case 'put':
      if (args.length !== 3) fail('usage');
      await put(args[1], args[2]);
      return 0;
    case 'get':
      if (args.length !== 3) fail('usage');
      await get(args[1], args[2]);
      return 0;
    default:
      fail('usage');
  }
}

main(process.argv.slice(2)).then(
  (status) => { process.exitCode = status; },
  () => {
    console.error('matrix-r2-broker: operation failed');
    process.exitCode = 1;
  },
);
