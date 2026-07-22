#!/usr/bin/env node
const bytes = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isSafeInteger(bytes) || bytes < 1024 * 1024 || bytes > 8 * 1024 * 1024 * 1024) {
  process.exitCode = 2;
} else {
  const chunks = [];
  const chunkBytes = 8 * 1024 * 1024;
  for (let allocated = 0; allocated < bytes; allocated += chunkBytes) {
    const chunk = Buffer.alloc(Math.min(chunkBytes, bytes - allocated), 0x5a);
    chunks.push(chunk);
  }
  process.stdout.write('MATRIX_MEMORY_PROBE_READY\n');
  setInterval(() => {
    if (chunks.length === 0) process.exitCode = 3;
  }, 1000).unref();
  await new Promise(() => {});
}
