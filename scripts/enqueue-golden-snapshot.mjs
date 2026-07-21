#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/platform/package.json', import.meta.url));
const { z } = require('zod/v4');

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

const ReleaseContextSchema = z.object({
  eventName: z.string().min(1).max(64),
  refType: z.enum(['branch', 'tag']),
  refName: z.string().min(1).max(255),
  channel: z.enum(['dev', 'canary', 'beta', 'stable']).optional(),
}).strict();

const EnqueueInputSchema = z.object({
  platformUrl: z.url().max(2_048),
  platformSecret: z.string().min(1).max(8_192),
  bundleVersion: z.string().min(1).max(128),
}).strict();

const EnqueueResponseSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  reused: z.boolean(),
}).passthrough();

export function isEligibleSnapshotRelease(input) {
  const parsed = ReleaseContextSchema.safeParse(input);
  if (!parsed.success) return false;
  if (parsed.data.eventName === 'workflow_dispatch') return parsed.data.channel !== undefined;
  if (parsed.data.eventName !== 'push') return false;
  if (parsed.data.refType === 'tag') return /^v[^\s/]{1,253}$/.test(parsed.data.refName);
  return parsed.data.refName === 'main';
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('Snapshot build enqueue failed');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('Snapshot build enqueue failed');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Snapshot build enqueue failed');
  }
}

export async function enqueueGoldenSnapshot(input) {
  const { fetchImpl = fetch, ...untrusted } = input;
  const parsed = EnqueueInputSchema.safeParse(untrusted);
  if (!parsed.success) throw new Error('Snapshot build enqueue configuration is invalid');
  const endpoint = new URL('/system-bundles/snapshot-builds', parsed.data.platformUrl);
  if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost') {
    throw new Error('Snapshot build enqueue configuration is invalid');
  }

  let response;
  try {
    response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${parsed.data.platformSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ bundleVersion: parsed.data.bundleVersion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Snapshot build enqueue failed');
  }
  if (response.status !== 202) throw new Error('Snapshot build enqueue failed');
  const result = EnqueueResponseSchema.safeParse(await readBoundedJson(response));
  if (!result.success) throw new Error('Snapshot build enqueue failed');
  return { status: result.data.status, reused: result.data.reused };
}

function parseVersion(argv) {
  const index = argv.indexOf('--version');
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const context = {
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    refType: process.env.GITHUB_REF_TYPE ?? '',
    refName: process.env.GITHUB_REF_NAME ?? '',
    channel: process.env.PUBLISH_CHANNEL || undefined,
  };
  if (!isEligibleSnapshotRelease(context)) {
    process.stdout.write('Golden snapshot build not eligible for this release.\n');
    return;
  }
  const result = await enqueueGoldenSnapshot({
    platformUrl: process.env.PLATFORM_PUBLIC_URL ?? '',
    platformSecret: process.env.PLATFORM_SECRET ?? '',
    bundleVersion: parseVersion(process.argv.slice(2)) ?? '',
  });
  process.stdout.write(`Golden snapshot build ${result.reused ? 'already exists' : 'queued'}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Golden snapshot build enqueue failed. Host bundle publication and fleet deployment are unaffected.\n');
    process.exitCode = 1;
  });
}
