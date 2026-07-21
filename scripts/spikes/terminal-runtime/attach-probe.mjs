#!/usr/bin/env node

import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spawn } = require('node-pty');
const runtimeId = process.argv[2] ?? '';
if (!/^[0-9a-f]{32}$/.test(runtimeId)) process.exit(2);

const pty = spawn('/opt/matrix/bin/zellij', ['attach', `matrix-t-${runtimeId}`], {
  name: 'xterm-256color', cols: 120, rows: 40,
  cwd: '/home/matrix/home', env: process.env,
});
const handle = await open(`/run/matrix-terminal-runtime-spike/attach-${runtimeId}.json`, 'wx', 0o600);
try {
  await handle.writeFile(`${JSON.stringify({ helper: process.pid, client: pty.pid })}\n`, 'utf8');
  await handle.sync();
} finally {
  await handle.close();
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  pty.kill();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
pty.onExit(() => process.exit(stopping ? 0 : 1));
setInterval(() => {}, 1000);
