#!/usr/bin/env node
import { access, open, readFile } from 'node:fs/promises';
const [runtimeId = '', checkpoint = ''] = process.argv.slice(2);
const checkpoints = new Set(['initial', 'detach', 'gateway-restart', 'gateway-crash', 'shell-restart']);
if (!/^[0-9a-f]{32}$/.test(runtimeId) || !checkpoints.has(checkpoint)) process.exit(2);
const root = '/run/matrix-terminal-runtime-spike';
const readiness = JSON.parse(await readFile(`${root}/readiness/${runtimeId}.json`, 'utf8'));
const alive = async (pid) => {
  try {
    await access(`/proc/${pid}`);
    return true;
  } catch (error) {
    return false;
  }
};
const zellij = await Promise.all(readiness.roles.zellij.map(alive));
const diagnostic = {
  checkpoint,
  keeper: await alive(readiness.roles.keeper),
  zellijAlive: zellij.filter(Boolean).length,
  zellijExpected: zellij.length,
  shell: await alive(readiness.roles.shell),
  agent: await alive(readiness.roles.agent),
};
let handle;
try {
  handle = await open(`${root}/role-diagnostic-${runtimeId}.json`, 'wx', 0o600);
  await handle.writeFile(`${JSON.stringify(diagnostic)}\n`, 'utf8');
  await handle.sync();
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code !== 'EEXIST') throw error;
} finally {
  if (handle) await handle.close();
}
