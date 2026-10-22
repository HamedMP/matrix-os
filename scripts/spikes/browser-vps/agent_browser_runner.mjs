import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { BrowserLabFailure, reportBrowserFailure } from './safe-errors.mjs';

const executable = '/opt/matrix-browser-lab/bin/agent-browser';
const base = ['--session', 'matrix-browser-lab', '--cdp', 'http://127.0.0.1:9222'];
const fixture = 'http://127.0.0.1:8730/fixture';

async function command(...args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [...base, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new BrowserLabFailure('tool_deadline')); }, 15_000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      bytes += data.length;
      // Snapshot output never reaches logs or supervisor status.
      if (bytes > 65_536) { child.kill('SIGKILL'); reject(new BrowserLabFailure('tool_output_limit')); }
    });
    child.once('error', () => { clearTimeout(timeout); reject(new BrowserLabFailure('tool_start_failed')); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new BrowserLabFailure('tool_failed')); });
  });
}
async function state() {
  const response = await fetch(`${fixture}/status`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new BrowserLabFailure('service_unavailable');
  return response.json();
}
try {
  await command('open', fixture);
  await command('snapshot', '-i'); // Always re-observe; never reuse element references from a killed worker.
  const epoch = (await state()).epoch;
  for (let attempt = 0; attempt < 35; attempt++) {
    const current = await state();
    if (current.epoch !== epoch) throw new BrowserLabFailure('fixture_replaced');
    if (current.checkpoint === 3) process.exit(0);
    if (current.checkpoint === 0) {
      await command('fill', '#fixture-user', 'matrix-lab');
      await command('fill', '#fixture-password', 'synthetic-only');
      await command('click', '#fixture-login');
    } else if (current.checkpoint === 1) {
      await command('fill', '#fixture-otp', current.otp);
      await command('click', '#fixture-verify');
    } else if (current.checkpoint === 2) await command('click', '#fixture-work');
    else throw new BrowserLabFailure('invalid_response');
    await sleep(900);
    await command('snapshot', '-i');
  }
  throw new BrowserLabFailure('fixture_deadline');
} catch (error) {
  // Fixed categories only: real tool stderr may contain page data or credentials.
  reportBrowserFailure('runner', error);
  process.exitCode = 1;
}
