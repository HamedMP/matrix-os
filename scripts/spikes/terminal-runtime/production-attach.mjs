#!/usr/bin/env node
import { open, readFile } from 'node:fs/promises';
import { spawn } from 'node-pty';

const [runtimeId = '', receiptPath = ''] = process.argv.slice(2);
if (!/^[0-9a-f]{32}$/.test(runtimeId) ||
    !/^\/run\/matrix-terminal-accept-[a-f0-9]{40}-[12]\.json$/.test(receiptPath)) {
  process.exit(2);
}
const home = '/home/matrix/home';
const state = `${home}/system/terminal-runtime`;
const child = spawn('/opt/matrix/bin/zellij', ['attach', `matrix-t-${runtimeId}`], {
  cwd: home,
  cols: 120,
  rows: 40,
  env: {
    HOME: home,
    MATRIX_HOME: home,
    PATH: `${home}/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    XDG_CACHE_HOME: `${state}/zellij-cache`,
    XDG_CONFIG_HOME: `${state}/zellij-config-home`,
    XDG_DATA_HOME: `${state}/zellij-data`,
    XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    ZELLIJ_CONFIG_DIR: '/opt/matrix/libexec/terminal-runtime/current',
    ZELLIJ_CONFIG_FILE: '/opt/matrix/libexec/terminal-runtime/current/config.kdl',
  },
});
const cgroup = (await readFile(`/proc/${child.pid}/cgroup`, 'utf8'))
  .split(/\r?\n/).find((line) => line.startsWith('0::'))?.slice(3) ?? '';
const handle = await open(receiptPath, 'wx', 0o600);
await handle.writeFile(`${JSON.stringify({ pid: child.pid, cgroup })}\n`);
await handle.close();
const stop = () => child.kill('SIGTERM');
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await new Promise((resolve) => child.onExit(resolve));
