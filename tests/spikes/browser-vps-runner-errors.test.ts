import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('the real comparison runner logs tool-start failure without child credential data', async () => {
  const runner = new URL('../../scripts/spikes/browser-vps/agent_browser_runner.mjs', import.meta.url).href;
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => { const error = new Error('private page password'); error.name = 'private cookie'; child.emit('error', error); });
      return child;
    };
    syncBuiltinESMExports();
    await import(${JSON.stringify(runner)});
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 })
    .then(() => { throw new Error('Runner should fail'); }, error => error as { code: number; stdout: string; stderr: string });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('[browser-lab] runner: tool_start_failed');
});
