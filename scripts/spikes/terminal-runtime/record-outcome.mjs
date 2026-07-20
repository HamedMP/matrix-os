#!/usr/bin/env node

import { open } from 'node:fs/promises';

const runtimeId = process.argv[2] ?? '';
if (!/^[0-9a-f]{32}$/.test(runtimeId)) {
  process.exitCode = 2;
} else {
  const allowedResults = new Set(['success', 'exit-code', 'signal', 'core-dump', 'watchdog', 'timeout', 'oom-kill', 'resources', 'protocol']);
  const serviceResult = allowedResults.has(process.env.SERVICE_RESULT ?? '')
    ? process.env.SERVICE_RESULT
    : 'unknown';
  const outcomePath = `/run/matrix-terminal-runtime-spike/outcomes/${runtimeId}.json`;
  let handle;
  try {
    handle = await open(outcomePath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ runtimeId, serviceResult })}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code !== 'EEXIST') process.exitCode = 1;
  } finally {
    if (handle) await handle.close();
  }
}
